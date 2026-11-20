#include "micros3/handlers.h"

#include <utility>

namespace micros3::handlers {

namespace {

// The largest body a handler that buffers its body accepts.
constexpr std::size_t kMaxBufferedBody = 1024 * 1024;

} // namespace

http::Response xml_response(std::string body) {
    http::Response response;
    response.body = std::move(body);
    response.set_header("Content-Type", "application/xml");
    return response;
}

std::unique_ptr<http::Exchange> begin(Store &store, const http::Request &request, const router::Route &route) {
    using router::Operation;
    // The handler runs after the body, so it keeps its own copies.
    auto buffered = [&](auto handler) -> std::unique_ptr<http::Exchange> {
        return std::make_unique<http::BufferedExchange>(
            request, kMaxBufferedBody,
            [&store, request, route, handler](std::string body) { return handler(store, request, route, body); });
    };
    auto ignoring_body = [&](http::Response (*handler)(Store &, const http::Request &, const router::Route &)) {
        return buffered([handler](Store &s, const http::Request &q, const router::Route &r, const std::string &) {
            return handler(s, q, r);
        });
    };

    switch (route.op) {
    case Operation::ListBuckets: return ignoring_body(&list_buckets);
    case Operation::CreateBucket:
        return buffered([](Store &s, const http::Request &q, const router::Route &r, const std::string &body) {
            return create_bucket(s, q, r, body);
        });
    case Operation::HeadBucket: return ignoring_body(&head_bucket);
    case Operation::GetBucketLocation: return ignoring_body(&get_bucket_location);
    case Operation::DeleteBucket: return ignoring_body(&delete_bucket);
    default: return nullptr;
    }
}

} // namespace micros3::handlers
