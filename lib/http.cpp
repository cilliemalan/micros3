#include "micros3/http.h"

#include "micros3/url.h"
#include "micros3/xml.h"

#include <unistd.h>

#include <cerrno>
#include <random>
#include <system_error>

namespace micros3::http {

std::optional<std::string_view> Request::header(std::string_view name) const {
    for (const auto &[key, value] : headers) {
        if (key == name) return std::string_view(value);
    }
    return std::nullopt;
}

void Response::set_header(std::string name, std::string value) {
    for (auto &[key, existing] : headers) {
        if (key == name) {
            existing = std::move(value);
            return;
        }
    }
    headers.emplace_back(std::move(name), std::move(value));
}

FileBody::~FileBody() {
    if (fd_ >= 0) ::close(fd_);
}

std::size_t FileBody::read(std::uint64_t position, char *buffer, std::size_t size) const {
    if (position >= length_) return 0;
    if (size > length_ - position) size = static_cast<std::size_t>(length_ - position);
    std::size_t done = 0;
    while (done < size) {
        const ssize_t n = ::pread(fd_, buffer + done, size - done, static_cast<off_t>(offset_ + position + done));
        if (n < 0) {
            if (errno == EINTR) continue;
            throw std::system_error(errno, std::generic_category(), "read object file");
        }
        if (n == 0) break;
        done += static_cast<std::size_t>(n);
    }
    return done;
}

bool bodyless(std::string_view method, int status) {
    return method == "HEAD" || (status >= 100 && status < 200) || status == 204 || status == 304;
}

std::string_view reason(int status) {
    switch (status) {
    case 100: return "Continue";
    case 200: return "OK";
    case 204: return "No Content";
    case 206: return "Partial Content";
    case 304: return "Not Modified";
    case 400: return "Bad Request";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 409: return "Conflict";
    case 411: return "Length Required";
    case 412: return "Precondition Failed";
    case 413: return "Payload Too Large";
    case 416: return "Range Not Satisfiable";
    case 500: return "Internal Server Error";
    case 501: return "Not Implemented";
    case 503: return "Service Unavailable";
    default: return "Unknown";
    }
}

std::string new_request_id() {
    thread_local std::mt19937_64 engine{std::random_device{}()};
    static constexpr char kHex[] = "0123456789ABCDEF";
    std::uint64_t bits = engine();
    std::string id(16, '0');
    for (char &c : id) {
        c = kHex[bits & 0xF];
        bits >>= 4;
    }
    return id;
}

Response error_response(const S3Error &error, const Request &request) {
    Response response;
    response.status = error.status;
    const std::string resource = url::decode(request.path, false).value_or(request.path);
    response.body = xml::error_document(error, resource, request.request_id);
    response.set_header("Content-Type", "application/xml");
    return response;
}

BufferedExchange::BufferedExchange(const Request &request, std::size_t limit, Handler handler)
    : limit_(limit), handler_(std::move(handler)) {
    request_.method = request.method;
    request_.path = request.path;
    request_.request_id = request.request_id;
}

void BufferedExchange::on_data(std::string_view chunk) {
    if (too_long_) return;
    if (chunk.size() > limit_ - body_.size()) {
        too_long_ = true;
        body_.clear();
        return;
    }
    body_.append(chunk);
}

Response BufferedExchange::on_end() {
    if (too_long_) return error_response(max_message_length_exceeded(), request_);
    return handler_(std::move(body_));
}

} // namespace micros3::http
