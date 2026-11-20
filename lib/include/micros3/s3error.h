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

inline S3Error invalid_argument(std::string message) { return {400, "InvalidArgument", std::move(message)}; }

inline S3Error malformed_xml() {
    return {400, "MalformedXML",
            "The XML you provided was not well-formed or did not validate against our published schema."};
}

inline S3Error max_message_length_exceeded() {
    return {400, "MaxMessageLengthExceeded", "Your request was too big."};
}

inline S3Error no_such_bucket() { return {404, "NoSuchBucket", "The specified bucket does not exist"}; }

inline S3Error internal_error() { return {500, "InternalError", "We encountered an internal error. Please try again."}; }

} // namespace micros3
