#pragma once

// Operation handlers. Each runs once the request body is complete (and its
// payload hash checked) and returns the response.

#include "micros3/http.h"
#include "micros3/router.h"
#include "micros3/store.h"

#include <memory>
#include <optional>
#include <string_view>

namespace micros3::handlers {

// The exchange that serves `route`, or nullptr when its operation has no
// handler yet.
std::unique_ptr<http::Exchange> begin(Store &store, const http::Request &request, const router::Route &route);

// Bucket operations (bucket_handlers.cpp). `body` is the whole request body.
http::Response list_buckets(Store &store, const http::Request &request, const router::Route &route);
http::Response create_bucket(Store &store, const http::Request &request, const router::Route &route,
                             std::string_view body);
http::Response head_bucket(Store &store, const http::Request &request, const router::Route &route);
http::Response get_bucket_location(Store &store, const http::Request &request, const router::Route &route);
http::Response get_bucket_encryption(Store &store, const http::Request &request, const router::Route &route);
http::Response delete_bucket(Store &store, const http::Request &request, const router::Route &route);

// Object listings (list_handlers.cpp).
http::Response list_objects(Store &store, const http::Request &request, const router::Route &route);
http::Response list_objects_v2(Store &store, const http::Request &request, const router::Route &route);

// Object operations (object_handlers.cpp). PutObject streams its body, so it
// is an exchange rather than a handler.
std::unique_ptr<http::Exchange> put_object(Store &store, const http::Request &request, const router::Route &route);
http::Response get_object(Store &store, const http::Request &request, const router::Route &route);
http::Response head_object(Store &store, const http::Request &request, const router::Route &route);
http::Response delete_object(Store &store, const http::Request &request, const router::Route &route);
http::Response copy_object(Store &store, const http::Request &request, const router::Route &route);

// DeleteObjects (delete_objects_handler.cpp). `body` is the whole request body.
http::Response delete_objects(Store &store, const http::Request &request, const router::Route &route,
                              std::string_view body);

// Bucket CORS configuration (cors_handlers.cpp). `body` is the whole request body.
http::Response put_bucket_cors(Store &store, const http::Request &request, const router::Route &route,
                               std::string_view body);
http::Response get_bucket_cors(Store &store, const http::Request &request, const router::Route &route);
http::Response delete_bucket_cors(Store &store, const http::Request &request, const router::Route &route);

// Checks Content-MD5 and the CRC32 and SHA-256 checksum headers, when present,
// against a buffered body. Other checksum algorithms are not checked.
std::optional<S3Error> check_body_digests(const http::Request &request, std::string_view body);

// A 200 response with an XML body.
http::Response xml_response(std::string body);

} // namespace micros3::handlers
