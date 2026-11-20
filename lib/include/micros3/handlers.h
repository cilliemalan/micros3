#pragma once

// Operation handlers. Each runs once the request body is complete (and its
// payload hash checked) and returns the response.

#include "micros3/http.h"
#include "micros3/router.h"
#include "micros3/store.h"

#include <memory>
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
http::Response delete_bucket(Store &store, const http::Request &request, const router::Route &route);

// Object operations (object_handlers.cpp). PutObject streams its body, so it
// is an exchange rather than a handler.
std::unique_ptr<http::Exchange> put_object(Store &store, const http::Request &request, const router::Route &route);
http::Response get_object(Store &store, const http::Request &request, const router::Route &route);
http::Response head_object(Store &store, const http::Request &request, const router::Route &route);
http::Response delete_object(Store &store, const http::Request &request, const router::Route &route);

// A 200 response with an XML body.
http::Response xml_response(std::string body);

} // namespace micros3::handlers
