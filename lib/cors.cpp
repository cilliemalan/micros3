#include "micros3/cors.h"

#include "micros3/xml.h"

#include <pugixml.hpp>

#include <algorithm>
#include <array>
#include <charconv>

namespace micros3::cors {

namespace {

constexpr std::array<std::string_view, 5> kMethods = {"GET", "PUT", "HEAD", "POST", "DELETE"};

// Longest rule ID S3 accepts.
constexpr std::size_t kMaxIdLength = 255;

S3Error invalid_request(std::string message) { return {400, "InvalidRequest", std::move(message)}; }

std::string_view local_name(const pugi::xml_node &node) {
    std::string_view name = node.name();
    const std::size_t colon = name.find(':');
    return colon == std::string_view::npos ? name : name.substr(colon + 1);
}

std::string trimmed(const pugi::xml_node &node) {
    std::string_view text = node.text().get();
    const std::size_t first = text.find_first_not_of(" \t\r\n");
    if (first == std::string_view::npos) return {};
    const std::size_t last = text.find_last_not_of(" \t\r\n");
    return std::string(text.substr(first, last - first + 1));
}

bool has_child_elements(const pugi::xml_node &node) {
    return std::any_of(node.children().begin(), node.children().end(),
                       [](const pugi::xml_node &c) { return c.type() == pugi::node_element; });
}

std::size_t wildcards(std::string_view text) { return static_cast<std::size_t>(std::count(text.begin(), text.end(), '*')); }

std::variant<Rule, S3Error> parse_rule(const pugi::xml_node &node) {
    Rule rule;
    for (const pugi::xml_node &field : node.children()) {
        if (field.type() != pugi::node_element) continue;
        if (has_child_elements(field)) return malformed_xml();
        const std::string_view name = local_name(field);
        std::string value = trimmed(field);
        if (name == "ID") {
            if (rule.id || value.size() > kMaxIdLength) return malformed_xml();
            rule.id = std::move(value);
        } else if (name == "AllowedOrigin") {
            if (wildcards(value) > 1) {
                return invalid_request("AllowedOrigin \"" + value + "\" can not have more than one wildcard.");
            }
            rule.allowed_origins.push_back(std::move(value));
        } else if (name == "AllowedMethod") {
            if (std::find(kMethods.begin(), kMethods.end(), value) == kMethods.end()) {
                return invalid_request("Found unsupported HTTP method in CORS config. Unsupported method is " + value);
            }
            rule.allowed_methods.push_back(std::move(value));
        } else if (name == "AllowedHeader") {
            if (wildcards(value) > 1) {
                return invalid_request("AllowedHeader \"" + value + "\" can not have more than one wildcard.");
            }
            rule.allowed_headers.push_back(std::move(value));
        } else if (name == "ExposeHeader") {
            rule.expose_headers.push_back(std::move(value));
        } else if (name == "MaxAgeSeconds") {
            std::int64_t seconds = 0;
            const char *end = value.data() + value.size();
            const auto [ptr, ec] = std::from_chars(value.data(), end, seconds);
            if (rule.max_age_seconds || value.empty() || ec != std::errc() || ptr != end || seconds < 0) {
                return malformed_xml();
            }
            rule.max_age_seconds = seconds;
        } else {
            return malformed_xml();
        }
    }
    if (rule.allowed_origins.empty() || rule.allowed_methods.empty()) return malformed_xml();
    return rule;
}

} // namespace

std::variant<Configuration, S3Error> parse(std::string_view body) {
    pugi::xml_document doc;
    if (!doc.load_buffer(body.data(), body.size())) return malformed_xml();
    const pugi::xml_node root = doc.document_element();
    if (local_name(root) != "CORSConfiguration") return malformed_xml();
    Configuration config;
    for (const pugi::xml_node &node : root.children()) {
        if (node.type() != pugi::node_element) continue;
        if (local_name(node) != "CORSRule") return malformed_xml();
        if (config.size() == kMaxRules) return malformed_xml();
        auto rule = parse_rule(node);
        if (auto *e = std::get_if<S3Error>(&rule)) return std::move(*e);
        config.push_back(std::move(std::get<Rule>(rule)));
    }
    if (config.empty()) return malformed_xml();
    return config;
}

std::string to_xml(const Configuration &config) {
    xml::Writer writer;
    writer.open("CORSConfiguration", xml::kS3Namespace);
    for (const Rule &rule : config) {
        writer.open("CORSRule");
        if (rule.id) writer.element("ID", *rule.id);
        for (const std::string &header : rule.allowed_headers) writer.element("AllowedHeader", header);
        for (const std::string &method : rule.allowed_methods) writer.element("AllowedMethod", method);
        for (const std::string &origin : rule.allowed_origins) writer.element("AllowedOrigin", origin);
        for (const std::string &header : rule.expose_headers) writer.element("ExposeHeader", header);
        if (rule.max_age_seconds) writer.element("MaxAgeSeconds", std::to_string(*rule.max_age_seconds));
        writer.close();
    }
    return writer.finish();
}

Lookup load(Store &store, std::string_view bucket) {
    db::Statement stmt = store.db().prepare("SELECT cors_xml FROM buckets WHERE name = ?");
    stmt.bind_text(1, bucket);
    Lookup lookup;
    if (!stmt.step()) return lookup;
    lookup.bucket_exists = true;
    if (stmt.column_is_null(0)) return lookup;
    auto parsed = parse(stmt.column_text(0));
    if (auto *config = std::get_if<Configuration>(&parsed)) lookup.config = std::move(*config);
    return lookup;
}

bool save(Store &store, std::string_view bucket, const std::optional<Configuration> &config) {
    db::Transaction txn(store.db());
    db::Statement exists = store.db().prepare("SELECT 1 FROM buckets WHERE name = ?");
    exists.bind_text(1, bucket);
    if (!exists.step()) return false;
    db::Statement update = store.db().prepare("UPDATE buckets SET cors_xml = ? WHERE name = ?");
    if (config) {
        update.bind_text(1, to_xml(*config));
    } else {
        update.bind_null(1);
    }
    update.bind_text(2, bucket).run();
    txn.commit();
    return true;
}

} // namespace micros3::cors
