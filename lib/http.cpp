#include "micros3/http.h"

#include "micros3/url.h"
#include "micros3/xml.h"

#include <random>

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

} // namespace micros3::http
