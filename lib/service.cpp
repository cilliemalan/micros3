#include "micros3/service.h"

#include <string>

namespace micros3 {

std::unique_ptr<http::Exchange> S3Service::begin(const http::Request &request) {
    const router::Route route = router::route(request.method, request.path, request.query,
                                              [&request](std::string_view name) { return request.header(name); });
    if (auto error = router::route_error(route)) {
        return std::make_unique<http::FixedExchange>(http::error_response(*error, request));
    }
    // No operation is implemented yet.
    const std::string message = std::string(router::name(route.op)) + " is not implemented yet.";
    return std::make_unique<http::FixedExchange>(http::error_response(not_implemented(message), request));
}

} // namespace micros3
