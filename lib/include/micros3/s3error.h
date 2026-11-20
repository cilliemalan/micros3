#pragma once

// An S3 error: the HTTP status, the S3 error code and a human-readable message.

#include <string>

namespace micros3 {

struct S3Error {
    int status = 500;
    std::string code;
    std::string message;
};

inline S3Error not_implemented(std::string message =
                                   "A header or query parameter you provided implies functionality "
                                   "that is not implemented.") {
    return {501, "NotImplemented", std::move(message)};
}

inline S3Error invalid_uri(std::string message = "Couldn't parse the specified URI.") {
    return {400, "InvalidURI", std::move(message)};
}

} // namespace micros3
