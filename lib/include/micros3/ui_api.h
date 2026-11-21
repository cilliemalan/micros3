#pragma once

// The web UI's service, served on the UI port (see docs/UI.md).
//
// It answers the JSON API under /api/. Errors are JSON,
// {"error": {"code": ..., "message": ...}}, with the S3 codes and statuses.
// Every request first passes the request guards (UI6, `ui::guard`). The
// routes are added step by step (docs/todo.md, U8 to U11); for now it answers
// GET /api/health and 404 for everything else.

#include "micros3/http.h"

#include <atomic>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

namespace micros3 {

class Store;

namespace ui {

// A JSON response with `status` and the serialized `body`.
http::Response json_response(int status, const std::string &body);

// A JSON error response: {"error": {"code": code, "message": message}}.
http::Response json_error(int status, const std::string &code, const std::string &message);

// True when `host`, a Host header value, names localhost (any case), an IPv4
// address or a bracketed IPv6 address, with no port or with `port`.
bool host_allowed(std::string_view host, std::uint16_t port);

// The request guards (UI6, docs/UI.md "Request guards"). Returns the 403
// AccessForbidden response for a refused request, or nullopt when it passes:
// - the Host header must be present and pass host_allowed;
// - a request that is not GET or HEAD must carry no Origin, or exactly
//   "http://" followed by the Host header value.
// They stop DNS rebinding and requests from other web pages. They are not
// authentication.
std::optional<http::Response> guard(const http::Request &request, std::uint16_t port);

} // namespace ui

class UiService : public http::Service {
public:
    // `port` is the UI port, which the Host header must name if it has a port.
    UiService(Store &store, std::uint16_t port) : store_(store), port_(port) {}
    std::unique_ptr<http::Exchange> begin(const http::Request &request) override;

    // Sets the UI port, for a listener bound to port 0 (tests).
    void set_port(std::uint16_t port) { port_ = port; }

private:
    Store &store_;
    std::atomic<std::uint16_t> port_;
};

} // namespace micros3
