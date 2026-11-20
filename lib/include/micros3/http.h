#pragma once

// Framework-independent HTTP request and response types, and the interface
// between the server (server.h) and the S3 service that answers requests.
//
// The server builds a Request from the head of each HTTP request and asks the
// Service for an Exchange. It then streams the body to Exchange::on_data in
// chunks as they arrive, so no body is buffered whole, and sends the Response
// that Exchange::on_end returns once the body is complete.

#include "micros3/s3error.h"

#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace micros3::http {

using Headers = std::vector<std::pair<std::string, std::string>>;

struct Request {
    std::string method;     // upper case: GET, PUT, ...
    std::string path;       // raw (still percent-encoded), starting with `/`
    std::string query;      // raw, without the leading `?`
    Headers headers;        // names in lower case, in request order
    std::string request_id; // also sent as x-amz-request-id

    // The first header called `name` (lower case), or nullopt.
    std::optional<std::string_view> header(std::string_view name) const;
};

struct Response {
    int status = 200;
    Headers headers;
    std::string body;
    // For a response sent without a body (HEAD), the Content-Length to report.
    std::optional<std::uint64_t> reported_length;

    void set_header(std::string name, std::string value);
};

// True when a response with this status, to this method, has no body on the
// wire: HEAD, 1xx, 204 and 304.
bool bodyless(std::string_view method, int status);

// The reason phrase for a status code ("Not Found"), or "Unknown".
std::string_view reason(int status);

// A new request ID: 16 upper-case hex characters.
std::string new_request_id();

// An XML error response for `request`. The Resource is the decoded path.
Response error_response(const S3Error &error, const Request &request);

// One request in progress. Created once the request head has arrived.
class Exchange {
public:
    virtual ~Exchange() = default;
    // A chunk of the request body. Called zero or more times.
    virtual void on_data(std::string_view chunk) = 0;
    // The body is complete. Returns the response to send.
    virtual Response on_end() = 0;
    // The client went away before the response was sent. No further calls.
    virtual void on_abort() {}
};

class Service {
public:
    virtual ~Service() = default;
    virtual std::unique_ptr<Exchange> begin(const Request &request) = 0;
};

// An exchange that ignores the body and answers with a fixed response.
class FixedExchange : public Exchange {
public:
    explicit FixedExchange(Response response) : response_(std::move(response)) {}
    void on_data(std::string_view) override {}
    Response on_end() override { return std::move(response_); }

private:
    Response response_;
};

// An exchange that collects a small body, then answers with `handler(body)`.
// A body longer than `limit` bytes is answered with MaxMessageLengthExceeded
// and the handler is not called.
class BufferedExchange : public Exchange {
public:
    using Handler = std::function<Response(std::string body)>;
    BufferedExchange(const Request &request, std::size_t limit, Handler handler);
    void on_data(std::string_view chunk) override;
    Response on_end() override;

private:
    Request request_; // path and request ID, for the error response
    std::size_t limit_;
    Handler handler_;
    std::string body_;
    bool too_long_ = false;
};

} // namespace micros3::http
