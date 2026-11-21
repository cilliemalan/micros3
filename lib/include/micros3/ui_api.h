#pragma once

// The web UI's service, served on the UI port (see docs/UI.md).
//
// It answers the JSON API under /api/. Errors are JSON,
// {"error": {"code": ..., "message": ...}}, with the S3 codes and statuses.
// The routes are added step by step (docs/todo.md, U7 to U11); for now it
// answers GET /api/health and 404 for everything else.

#include "micros3/http.h"

#include <memory>
#include <string>

namespace micros3 {

class Store;

namespace ui {

// A JSON response with `status` and the serialized `body`.
http::Response json_response(int status, const std::string &body);

// A JSON error response: {"error": {"code": code, "message": message}}.
http::Response json_error(int status, const std::string &code, const std::string &message);

} // namespace ui

class UiService : public http::Service {
public:
    explicit UiService(Store &store) : store_(store) {}
    std::unique_ptr<http::Exchange> begin(const http::Request &request) override;

private:
    Store &store_;
};

} // namespace micros3
