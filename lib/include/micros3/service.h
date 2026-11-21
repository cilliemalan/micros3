#pragma once

// The S3 service: authenticates each request (sigv4.h), routes it (router.h)
// and hands it to its operation handler.

#include "micros3/http.h"
#include "micros3/router.h"
#include "micros3/sigv4.h"
#include "micros3/store.h"

#include <utility>

namespace micros3 {

class S3Service : public http::Service {
public:
    S3Service(Store &store, sigv4::Credentials credentials) : store_(store), credentials_(std::move(credentials)) {}

    std::unique_ptr<http::Exchange> begin(const http::Request &request) override;

private:
    // Authenticates and routes the request to its handler's exchange.
    std::unique_ptr<http::Exchange> dispatch(const http::Request &request, const router::Route &route);

    Store &store_;
    sigv4::Credentials credentials_;
};

// Wraps an exchange, hashing the body as it streams through. When the body's
// SHA-256 differs from `expected`, the inner exchange is aborted (so it
// discards anything it staged) and the response is XAmzContentSHA256Mismatch.
class PayloadHashExchange : public http::Exchange {
public:
    PayloadHashExchange(std::unique_ptr<http::Exchange> inner, digest::Sha256Digest expected,
                        const http::Request &request);

    void on_data(std::string_view chunk) override;
    http::Response on_end() override;
    void on_abort() override;

private:
    std::unique_ptr<http::Exchange> inner_;
    digest::Sha256Digest expected_;
    digest::Sha256 hash_;
    http::Request request_; // path and request ID, for the error response
};

// Wraps the exchange of a request on a bucket, adding CORS headers to its
// response from the bucket's configuration (handlers::add_cors_headers).
class CorsExchange : public http::Exchange {
public:
    CorsExchange(std::unique_ptr<http::Exchange> inner, Store &store, const http::Request &request,
                 const router::Route &route);

    void on_data(std::string_view chunk) override { inner_->on_data(chunk); }
    http::Response on_end() override;
    void on_abort() override { inner_->on_abort(); }

private:
    std::unique_ptr<http::Exchange> inner_;
    Store &store_;
    http::Request request_; // method and Origin only
    router::Route route_;   // bucket only
};

} // namespace micros3
