#include "micros3/service.h"

#include "micros3/handlers.h"

#include <string>
#include <variant>

namespace micros3 {

PayloadHashExchange::PayloadHashExchange(std::unique_ptr<http::Exchange> inner, digest::Sha256Digest expected,
                                         const http::Request &request)
    : inner_(std::move(inner)), expected_(expected) {
    request_.method = request.method;
    request_.path = request.path;
    request_.request_id = request.request_id;
}

void PayloadHashExchange::on_data(std::string_view chunk) {
    hash_.update(chunk);
    inner_->on_data(chunk);
}

http::Response PayloadHashExchange::on_end() {
    const digest::Sha256Digest actual = hash_.finish();
    if (!sigv4::constant_time_equal(
            std::string_view(reinterpret_cast<const char *>(actual.data()), actual.size()),
            std::string_view(reinterpret_cast<const char *>(expected_.data()), expected_.size()))) {
        inner_->on_abort();
        inner_.reset();
        return http::error_response(sigv4::content_sha256_mismatch(), request_);
    }
    return inner_->on_end();
}

void PayloadHashExchange::on_abort() {
    if (inner_) inner_->on_abort();
}

CorsExchange::CorsExchange(std::unique_ptr<http::Exchange> inner, Store &store, const http::Request &request,
                           const router::Route &route)
    : inner_(std::move(inner)), store_(store) {
    request_.method = request.method;
    if (auto origin = request.header("origin")) request_.headers.emplace_back("origin", std::string(*origin));
    route_.op = route.op;
    route_.bucket = route.bucket;
}

http::Response CorsExchange::on_end() {
    http::Response response = inner_->on_end();
    handlers::add_cors_headers(store_, request_, route_, response);
    return response;
}

std::unique_ptr<http::Exchange> S3Service::begin(const http::Request &request) {
    const router::Route route = router::route(request.method, request.path, request.query,
                                              [&request](std::string_view name) { return request.header(name); });
    std::unique_ptr<http::Exchange> exchange = dispatch(request, route);
    // Preflight sets its own CORS headers, and a rejected one has none.
    if (!route.bucket.empty() && route.op != router::Operation::Preflight &&
        route.op != router::Operation::InvalidUri) {
        exchange = std::make_unique<CorsExchange>(std::move(exchange), store_, request, route);
    }
    return exchange;
}

std::unique_ptr<http::Exchange> S3Service::dispatch(const http::Request &request, const router::Route &route) {
    const auto fixed = [&request](const S3Error &error) {
        return std::make_unique<http::FixedExchange>(http::error_response(error, request));
    };
    // A target that cannot be decoded cannot be canonicalized for signing.
    if (route.op == router::Operation::InvalidUri) return fixed(*router::route_error(route));

    // CORS preflight is answered without a signature.
    std::optional<digest::Sha256Digest> expected_payload;
    if (route.op != router::Operation::Preflight) {
        auto auth = sigv4::authenticate(request, credentials_);
        if (auto *error = std::get_if<S3Error>(&auth)) return fixed(*error);
        expected_payload = std::get<sigv4::PayloadCheck>(auth).expected;
    }
    if (auto error = router::route_error(route)) return fixed(*error);

    std::unique_ptr<http::Exchange> exchange = handlers::begin(store_, request, route);
    if (!exchange) {
        const std::string message = std::string(router::name(route.op)) + " is not implemented yet.";
        exchange = fixed(not_implemented(message));
    }
    if (expected_payload) {
        exchange = std::make_unique<PayloadHashExchange>(std::move(exchange), *expected_payload, request);
    }
    return exchange;
}

} // namespace micros3
