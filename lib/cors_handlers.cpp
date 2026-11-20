// PutBucketCors, GetBucketCors and DeleteBucketCors.

#include "micros3/cors.h"
#include "micros3/handlers.h"

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

} // namespace micros3::handlers
