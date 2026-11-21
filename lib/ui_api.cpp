#include "micros3/ui_api.h"

#include <nlohmann/json.hpp>

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

} // namespace ui

std::unique_ptr<http::Exchange> UiService::begin(const http::Request &request) {
    (void)store_;
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
