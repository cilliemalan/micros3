#include "micros3/ui_api.h"

#include "micros3/buckets.h"
#include "micros3/clock.h"
#include "micros3/cors.h"
#include "micros3/store.h"
#include "micros3/url.h"

#include <nlohmann/json.hpp>

#include <arpa/inet.h>

#include <cctype>
#include <cstdint>
#include <functional>
#include <variant>
#include <vector>

namespace micros3 {

namespace ui {

http::Response json_response(int status, const std::string &body) {
    http::Response response;
    response.status = status;
    response.set_header("Content-Type", "application/json; charset=utf-8");
    response.set_header("Cache-Control", "no-store");
    response.body = body;
    return response;
}

http::Response json_error(int status, const std::string &code, const std::string &message) {
    const nlohmann::json body = {{"error", {{"code", code}, {"message", message}}}};
    return json_response(status, body.dump());
}

namespace {

bool iequals(std::string_view a, std::string_view b) {
    if (a.size() != b.size()) return false;
    for (std::size_t i = 0; i < a.size(); ++i) {
        if (std::tolower(static_cast<unsigned char>(a[i])) != std::tolower(static_cast<unsigned char>(b[i]))) {
            return false;
        }
    }
    return true;
}

// True when `text` is one or more decimal digits naming `port`.
bool port_matches(std::string_view text, std::uint16_t port) {
    if (text.empty() || text.size() > 5) return false;
    unsigned value = 0;
    for (char c : text) {
        if (c < '0' || c > '9') return false;
        value = value * 10 + static_cast<unsigned>(c - '0');
    }
    return value == port;
}

bool is_address(int family, std::string_view text) {
    if (text.empty() || text.size() > 45) return false;
    const std::string copy(text);
    unsigned char buffer[16];
    return ::inet_pton(family, copy.c_str(), buffer) == 1;
}

http::Response forbidden(const std::string &message) { return json_error(403, "AccessForbidden", message); }

} // namespace

bool host_allowed(std::string_view host, std::uint16_t port) {
    std::string_view name = host;
    std::string_view port_text;
    bool has_port = false;
    if (!host.empty() && host.front() == '[') {
        const std::size_t close = host.find(']');
        if (close == std::string_view::npos) return false;
        name = host.substr(1, close - 1);
        const std::string_view rest = host.substr(close + 1);
        if (!rest.empty()) {
            if (rest.front() != ':') return false;
            has_port = true;
            port_text = rest.substr(1);
        }
        if (!is_address(AF_INET6, name)) return false;
    } else {
        const std::size_t colon = host.find(':');
        if (colon != std::string_view::npos) {
            name = host.substr(0, colon);
            port_text = host.substr(colon + 1);
            has_port = true;
        }
        if (!iequals(name, "localhost") && !is_address(AF_INET, name)) return false;
    }
    return !has_port || port_matches(port_text, port);
}

std::optional<http::Response> guard(const http::Request &request, std::uint16_t port) {
    const auto host = request.header("host");
    if (!host) return forbidden("The request has no Host header.");
    if (!host_allowed(*host, port)) {
        return forbidden("The Host header must name localhost or an IP address, with the UI port.");
    }
    if (request.method != "GET" && request.method != "HEAD") {
        if (const auto origin = request.header("origin")) {
            if (*origin != "http://" + std::string(*host)) {
                return forbidden("Requests from another origin may not change anything.");
            }
        }
    }
    return std::nullopt;
}

} // namespace ui

namespace {

using ExchangePtr = std::unique_ptr<http::Exchange>;

// The most bytes a JSON or CORS XML request body may hold.
constexpr std::size_t kMaxJsonBody = 1024 * 1024;

ExchangePtr fixed(http::Response response) { return std::make_unique<http::FixedExchange>(std::move(response)); }

http::Response error(const S3Error &e) { return ui::json_error(e.status, e.code, e.message); }

http::Response no_content() {
    http::Response response;
    response.status = 204;
    response.set_header("Cache-Control", "no-store");
    return response;
}

http::Response method_not_allowed() {
    return ui::json_error(405, "MethodNotAllowed", "The specified method is not allowed against this resource.");
}

S3Error invalid_bucket_name() { return {400, "InvalidBucketName", "The specified bucket is not valid."}; }

S3Error no_such_cors() { return {404, "NoSuchCORSConfiguration", "The CORS configuration does not exist"}; }

S3Error malformed_json(std::string message = "The request body is not a valid JSON object.") {
    return {400, "MalformedJSON", std::move(message)};
}

// Collects a small body, then answers with `handler(body)`. A body over
// kMaxJsonBody is answered with MaxMessageLengthExceeded, in JSON.
class JsonBodyExchange : public http::Exchange {
public:
    using Handler = std::function<http::Response(std::string body)>;
    explicit JsonBodyExchange(Handler handler) : handler_(std::move(handler)) {}
    void on_data(std::string_view chunk) override {
        if (too_long_) return;
        if (chunk.size() > kMaxJsonBody - body_.size()) {
            too_long_ = true;
            body_.clear();
            return;
        }
        body_.append(chunk);
    }
    http::Response on_end() override {
        if (too_long_) return error(max_message_length_exceeded());
        return handler_(std::move(body_));
    }

private:
    Handler handler_;
    std::string body_;
    bool too_long_ = false;
};

// A changing request that takes no body runs once the body has ended, as S3
// requests do, so a request cut short changes nothing.
ExchangePtr after_body(std::function<http::Response()> action) {
    return std::make_unique<JsonBodyExchange>([action = std::move(action)](std::string) { return action(); });
}

nlohmann::json bucket_json(const buckets::Bucket &bucket) {
    return {{"name", bucket.name}, {"region", bucket.region}, {"created", clock::iso8601(bucket.created_ms)}};
}

http::Response list_buckets(Store &store) {
    nlohmann::json list = nlohmann::json::array();
    for (const buckets::Bucket &bucket : buckets::list(store, "", "", std::nullopt, SIZE_MAX)) {
        list.push_back(bucket_json(bucket));
    }
    return ui::json_response(200, nlohmann::json{{"buckets", std::move(list)}}.dump());
}

http::Response create_bucket(Store &store, const std::string &body) {
    const nlohmann::json parsed = nlohmann::json::parse(body, nullptr, false);
    if (parsed.is_discarded() || !parsed.is_object()) return error(malformed_json());
    const auto name = parsed.find("name");
    if (name == parsed.end() || !name->is_string()) {
        return error(malformed_json("The request body must have a string \"name\"."));
    }
    std::string region(buckets::kDefaultRegion);
    if (const auto given = parsed.find("region"); given != parsed.end() && !given->is_null()) {
        if (!given->is_string()) return error(malformed_json("The \"region\" must be a string."));
        if (!given->get_ref<const std::string &>().empty()) region = given->get<std::string>();
    }
    const std::string bucket_name = name->get<std::string>();
    if (!buckets::valid_name(bucket_name)) return error(invalid_bucket_name());
    if (!buckets::valid_region(region)) {
        return error({400, "InvalidLocationConstraint", "The specified location-constraint is not valid."});
    }
    if (buckets::create(store, bucket_name, region, clock::now_ms())) {
        return error({409, "BucketAlreadyOwnedByYou",
                      "Your previous request to create the named bucket succeeded and you already own it."});
    }
    const auto created = buckets::find(store, bucket_name);
    if (!created) return error(internal_error());
    return ui::json_response(200, bucket_json(*created).dump());
}

http::Response get_bucket(Store &store, const std::string &name) {
    const auto bucket = buckets::find(store, name);
    if (!bucket) return error(no_such_bucket());
    nlohmann::json body = bucket_json(*bucket);
    // Every bucket has the SSE-S3 default, which cannot be changed.
    body["encryption"] = "AES256";
    body["cors"] = cors::load(store, name).config.has_value();
    return ui::json_response(200, body.dump());
}

http::Response delete_bucket(Store &store, const std::string &name) {
    switch (buckets::remove(store, name)) {
    case buckets::DeleteResult::NoSuchBucket: return error(no_such_bucket());
    case buckets::DeleteResult::NotEmpty:
        return error({409, "BucketNotEmpty", "The bucket you tried to delete is not empty"});
    case buckets::DeleteResult::Deleted: break;
    }
    return no_content();
}

http::Response empty_bucket(Store &store, const std::string &name) {
    if (buckets::empty(store, name) == buckets::EmptyResult::NoSuchBucket) return error(no_such_bucket());
    return no_content();
}

http::Response get_cors(Store &store, const std::string &name) {
    const cors::Lookup lookup = cors::load(store, name);
    if (!lookup.bucket_exists) return error(no_such_bucket());
    if (!lookup.config) return error(no_such_cors());
    http::Response response;
    response.set_header("Content-Type", "application/xml");
    response.set_header("Cache-Control", "no-store");
    response.body = cors::to_xml(*lookup.config);
    return response;
}

http::Response put_cors(Store &store, const std::string &name, const std::string &body) {
    if (!cors::load(store, name).bucket_exists) return error(no_such_bucket());
    auto parsed = cors::parse(body);
    if (auto *e = std::get_if<S3Error>(&parsed)) return error(*e);
    if (!cors::save(store, name, std::get<cors::Configuration>(parsed))) return error(no_such_bucket());
    return no_content();
}

http::Response delete_cors(Store &store, const std::string &name) {
    if (!cors::save(store, name, std::nullopt)) return error(no_such_bucket());
    return no_content();
}

// The decoded segments of a path under /api/, or nullopt when an escape is
// malformed. "/api/buckets/a%20b" gives {"buckets", "a b"}.
std::optional<std::vector<std::string>> api_segments(std::string_view rest) {
    std::vector<std::string> segments;
    while (true) {
        const std::size_t slash = rest.find('/');
        auto decoded = url::decode(rest.substr(0, slash), false);
        if (!decoded) return std::nullopt;
        segments.push_back(std::move(*decoded));
        if (slash == std::string_view::npos) break;
        rest.remove_prefix(slash + 1);
    }
    return segments;
}

} // namespace

std::unique_ptr<http::Exchange> UiService::begin(const http::Request &request) {
    if (auto refused = ui::guard(request, port_)) return fixed(std::move(*refused));

    constexpr std::string_view kApi = "/api/";
    const std::string_view path = request.path;
    if (path.substr(0, kApi.size()) != kApi) return fixed(ui::json_error(404, "NotFound", "Not found."));
    const auto segments = api_segments(path.substr(kApi.size()));
    if (!segments) return fixed(error(invalid_uri()));

    const std::string &method = request.method;
    const bool get = method == "GET" || method == "HEAD";
    Store &store = store_;
    const std::size_t n = segments->size();
    const std::string &first = (*segments)[0];

    if (n == 1 && first == "health") {
        if (get) return fixed(ui::json_response(200, R"({"status":"ok"})"));
        return fixed(method_not_allowed());
    }
    if (first == "buckets" && n == 1) {
        if (get) return fixed(list_buckets(store));
        if (method == "POST") {
            return std::make_unique<JsonBodyExchange>(
                [&store](std::string body) { return create_bucket(store, body); });
        }
        return fixed(method_not_allowed());
    }
    if (first == "buckets" && n >= 2 && !(*segments)[1].empty()) {
        const std::string bucket = (*segments)[1];
        if (n == 2) {
            if (get) return fixed(get_bucket(store, bucket));
            if (method == "DELETE") return after_body([&store, bucket] { return delete_bucket(store, bucket); });
            return fixed(method_not_allowed());
        }
        const std::string &sub = (*segments)[2];
        if (n == 3 && sub == "empty") {
            if (method == "POST") return after_body([&store, bucket] { return empty_bucket(store, bucket); });
            return fixed(method_not_allowed());
        }
        if (n == 3 && sub == "cors") {
            if (get) return fixed(get_cors(store, bucket));
            if (method == "DELETE") return after_body([&store, bucket] { return delete_cors(store, bucket); });
            if (method == "PUT") {
                return std::make_unique<JsonBodyExchange>(
                    [&store, bucket](std::string body) { return put_cors(store, bucket, body); });
            }
            return fixed(method_not_allowed());
        }
    }
    return fixed(ui::json_error(404, "NotFound", "Not found."));
}

} // namespace micros3
