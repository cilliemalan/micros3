#include "micros3/ui_api.h"

#include <nlohmann/json.hpp>

#include <arpa/inet.h>

#include <cctype>

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

std::unique_ptr<http::Exchange> UiService::begin(const http::Request &request) {
    (void)store_;
    if (auto refused = ui::guard(request, port_)) return std::make_unique<http::FixedExchange>(std::move(*refused));
    if (request.path == "/api/health") {
        if (request.method == "GET" || request.method == "HEAD") {
            return std::make_unique<http::FixedExchange>(ui::json_response(200, R"({"status":"ok"})"));
        }
        return std::make_unique<http::FixedExchange>(
            ui::json_error(405, "MethodNotAllowed", "The specified method is not allowed against this resource."));
    }
    return std::make_unique<http::FixedExchange>(ui::json_error(404, "NotFound", "Not found."));
}

} // namespace micros3
