// DeleteObjects: several keys in one request, with a result for each.

#include "micros3/buckets.h"
#include "micros3/handlers.h"
#include "micros3/objects.h"
#include "micros3/xml.h"

#include <pugixml.hpp>

#include <string>
#include <variant>
#include <vector>

namespace micros3::handlers {

namespace {

// The most keys one request may name.
constexpr std::size_t kMaxKeys = 1000;

std::string_view local_name(const pugi::xml_node &node) {
    std::string_view name = node.name();
    const std::size_t colon = name.find(':');
    return colon == std::string_view::npos ? name : name.substr(colon + 1);
}

pugi::xml_node child(const pugi::xml_node &node, std::string_view name) {
    for (const pugi::xml_node &c : node.children()) {
        if (c.type() == pugi::node_element && local_name(c) == name) return c;
    }
    return {};
}

struct Entry {
    std::string key;
    std::optional<std::string> version_id;
};

struct DeleteRequest {
    bool quiet = false;
    std::vector<Entry> entries;
};

std::variant<DeleteRequest, S3Error> parse(std::string_view body) {
    pugi::xml_document doc;
    if (!doc.load_buffer(body.data(), body.size(), pugi::parse_default & ~pugi::parse_eol)) return malformed_xml();
    const pugi::xml_node root = doc.document_element();
    if (local_name(root) != "Delete") return malformed_xml();
    DeleteRequest out;
    for (const pugi::xml_node &node : root.children()) {
        if (node.type() != pugi::node_element) continue;
        const std::string_view name = local_name(node);
        if (name == "Quiet") {
            const std::string_view value = node.text().get();
            if (value == "true") {
                out.quiet = true;
            } else if (value != "false") {
                return malformed_xml();
            }
        } else if (name == "Object") {
            const pugi::xml_node key = child(node, "Key");
            if (!key) return malformed_xml();
            Entry entry;
            entry.key = key.text().get();
            if (const pugi::xml_node version = child(node, "VersionId")) entry.version_id = version.text().get();
            out.entries.push_back(std::move(entry));
            if (out.entries.size() > kMaxKeys) return malformed_xml();
        }
    }
    if (out.entries.empty()) return malformed_xml();
    return out;
}

} // namespace

http::Response delete_objects(Store &store, const http::Request &request, const router::Route &route,
                              std::string_view body) {
    if (!buckets::find(store, route.bucket)) return http::error_response(no_such_bucket(), request);
    if (auto e = check_body_digests(request, body)) return http::error_response(*e, request);
    auto parsed = parse(body);
    if (auto *e = std::get_if<S3Error>(&parsed)) return http::error_response(*e, request);
    const DeleteRequest &del = std::get<DeleteRequest>(parsed);

    // Versioning is out of scope: only the "null" version exists.
    std::vector<std::string> keys;
    for (const Entry &entry : del.entries) {
        if (!entry.version_id || *entry.version_id == "null") keys.push_back(entry.key);
    }
    if (objects::remove_many(store, route.bucket, keys) == objects::DeleteResult::NoSuchBucket) {
        return http::error_response(no_such_bucket(), request);
    }

    xml::Writer writer;
    writer.open("DeleteResult", xml::kS3Namespace);
    for (const Entry &entry : del.entries) {
        const bool failed = entry.version_id && *entry.version_id != "null";
        if (failed) {
            writer.open("Error")
                .element("Key", entry.key)
                .element("VersionId", *entry.version_id)
                .element("Code", "NoSuchVersion")
                .element("Message", "The specified version does not exist.")
                .close();
        } else if (!del.quiet) {
            writer.open("Deleted").element("Key", entry.key);
            if (entry.version_id) writer.element("VersionId", *entry.version_id);
            writer.close();
        }
    }
    return xml_response(writer.finish());
}

} // namespace micros3::handlers
