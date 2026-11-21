#pragma once

// The web UI's service, served on the UI port (see docs/UI.md).
//
// It answers the JSON API under /api/. Errors are JSON,
// {"error": {"code": ..., "message": ...}}, with the S3 codes and statuses.
// Every request first passes the request guards (UI6, `ui::guard`). The
// routes are added step by step (docs/todo.md, U8 to U11). So far:
//   GET    /api/health
//   GET    /api/buckets                     {buckets: [{name, region, created}]}
//   POST   /api/buckets                     body {name, region?}, answers the bucket
//   GET    /api/buckets/{bucket}            {name, region, created, encryption, cors}
//   DELETE /api/buckets/{bucket}            204, or 409 BucketNotEmpty
//   POST   /api/buckets/{bucket}/empty      204
//   GET    /api/buckets/{bucket}/cors       the XML, or 404 NoSuchCORSConfiguration
//   PUT    /api/buckets/{bucket}/cors       body the S3 XML, 204
//   DELETE /api/buckets/{bucket}/cors       204
//   GET    /api/buckets/{bucket}/objects    ?prefix=&delimiter=&after=&limit=,
//                                           {folders, objects: [{key, size, etag,
//                                           lastModified}], next?}
//   GET    /api/buckets/{bucket}/meta?key=  {key, size, etag, lastModified, headers}
//   PUT    /api/buckets/{bucket}/meta?key=  body {headers}, replaced in place (UI7);
//                                           answers as GET
//   POST   /api/buckets/{bucket}/delete     body {keys} (at most 1000),
//                                           {deleted, errors: [{key, code, message}]}
//   POST   /api/buckets/{bucket}/copy       body {source: {bucket?, key},
//                                           destination: {bucket?, key}, move?};
//                                           answers the copy's {key, size, etag,
//                                           lastModified}. A missing bucket is the
//                                           one in the path.
// Object keys are passed in the `key` query parameter, never in the path.
// Path segments are percent-decoded. A known path with another method is 405
// MethodNotAllowed; HEAD is allowed wherever GET is. Other paths are 404.
//
// Outside /api/, the service serves the embedded UI files (U11): `/` is
// index.html, and every other embedded file is served at its own path, such
// as /assets/index-3f2a.js. Only GET and HEAD are allowed on them (405
// otherwise), and any other path, including every S3-style path such as
// /bucket/key, is a JSON 404, never an S3 error. index.html is sent with
// Cache-Control: no-cache; the hashed files under /assets/ may be cached for
// good.

#include "micros3/http.h"
#include "micros3/ui_assets.h"

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

// Adds the headers every response from the UI service carries (docs/UI.md,
// "Security of the frontend"): the Content-Security-Policy,
// X-Content-Type-Options: nosniff and Referrer-Policy: no-referrer. UiService
// adds them to pages, API replies, object content and refusals alike.
void add_security_headers(http::Response &response);

// The response for a request outside /api/: the embedded file at the path,
// or 404 NotFound, or 405 MethodNotAllowed for a method other than GET and
// HEAD on a file. A HEAD response has no body and reports the file's length.
http::Response serve_static(const Assets &assets, const http::Request &request);

} // namespace ui

class UiService : public http::Service {
public:
    // `port` is the UI port, which the Host header must name if it has a port.
    // `assets` are the files served outside /api/ (tests pass their own).
    UiService(Store &store, std::uint16_t port, ui::Assets assets = ui::embedded_assets())
        : store_(store), port_(port), assets_(assets) {}
    std::unique_ptr<http::Exchange> begin(const http::Request &request) override;

    // Sets the UI port, for a listener bound to port 0 (tests).
    void set_port(std::uint16_t port) { port_ = port; }

private:
    // The exchange for a request that passed the guards, before the security
    // headers are added.
    std::unique_ptr<http::Exchange> route(const http::Request &request);

    Store &store_;
    std::atomic<std::uint16_t> port_;
    ui::Assets assets_;
};

} // namespace micros3
