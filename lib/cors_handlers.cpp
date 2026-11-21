// PutBucketCors, GetBucketCors and DeleteBucketCors, preflight OPTIONS, and
// CORS headers on signed requests.

#include "micros3/cors.h"
#include "micros3/handlers.h"

#include <array>
#include <algorithm>
#include <variant>

namespace micros3::handlers {

http::Response put_bucket_cors(Store &store, const http::Request &request, const router::Route &route,
                               std::string_view body) {
    if (!cors::load(store, route.bucket).bucket_exists) return http::error_response(no_such_bucket(), request);
    if (auto e = check_body_digests(request, body)) return http::error_response(*e, request);
    auto parsed = cors::parse(body);
    if (auto *e = std::get_if<S3Error>(&parsed)) return http::error_response(*e, request);
    if (!cors::save(store, route.bucket, std::get<cors::Configuration>(parsed))) {
        return http::error_response(no_such_bucket(), request);
    }
    return http::Response{};
}

http::Response get_bucket_cors(Store &store, const http::Request &request, const router::Route &route) {
    const cors::Lookup lookup = cors::load(store, route.bucket);
    if (!lookup.bucket_exists) return http::error_response(no_such_bucket(), request);
    if (!lookup.config) {
        return http::error_response(
            {404, "NoSuchCORSConfiguration", "The CORS configuration does not exist"}, request);
    }
    return xml_response(cors::to_xml(*lookup.config));
}

http::Response delete_bucket_cors(Store &store, const http::Request &request, const router::Route &route) {
    if (!cors::save(store, route.bucket, std::nullopt)) return http::error_response(no_such_bucket(), request);
    http::Response response;
    response.status = 204;
    return response;
}

namespace {

constexpr std::array<std::string_view, 5> kPreflightMethods = {"GET", "PUT", "HEAD", "POST", "DELETE"};

S3Error forbidden(std::string message) { return {403, "AccessForbidden", std::move(message)}; }

} // namespace

http::Response preflight(Store &store, const http::Request &request, const router::Route &route) {
    const auto origin = request.header("origin");
    if (!origin || origin->empty()) {
        return http::error_response(
            {400, "BadRequest", "Insufficient information. Origin request header needed."}, request);
    }
    const auto method = request.header("access-control-request-method");
    if (!method || std::find(kPreflightMethods.begin(), kPreflightMethods.end(), *method) == kPreflightMethods.end()) {
        return http::error_response(
            {400, "BadRequest",
             "Invalid Access-Control-Request-Method: " + std::string(method ? *method : std::string_view("null"))},
            request);
    }
    const cors::Lookup lookup = route.bucket.empty() ? cors::Lookup{} : cors::load(store, route.bucket);
    if (!lookup.bucket_exists) return http::error_response(forbidden("CORSResponse: Bucket not found"), request);
    if (!lookup.config) {
        return http::error_response(forbidden("CORSResponse: CORS is not enabled for this bucket."), request);
    }
    const auto match = cors::match_preflight(*lookup.config, *origin, *method,
                                             request.header("access-control-request-headers").value_or(""));
    if (!match) {
        return http::error_response(
            forbidden("CORSResponse: This CORS request is not allowed. This is usually because the evaluation of "
                      "Origin, request method / Access-Control-Request-Method or Access-Control-Request-Headers "
                      "are not whitelisted by the resource's CORS spec."),
            request);
    }
    http::Response response;
    cors::add_headers(response, *match->rule, *origin, match->headers);
    cors::add_vary(response, "Origin, Access-Control-Request-Headers, Access-Control-Request-Method");
    return response;
}

void add_cors_headers(Store &store, const http::Request &request, const router::Route &route,
                      http::Response &response) {
    if (route.bucket.empty()) return;
    const cors::Lookup lookup = cors::load(store, route.bucket);
    if (!lookup.config) return;
    cors::add_vary(response, "Origin");
    const auto origin = request.header("origin");
    if (!origin || origin->empty()) return;
    if (const cors::Rule *rule = cors::match_request(*lookup.config, *origin, request.method)) {
        cors::add_headers(response, *rule, *origin);
    }
}

} // namespace micros3::handlers
