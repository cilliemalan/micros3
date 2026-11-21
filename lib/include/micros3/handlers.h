#pragma once

// Operation handlers. Each runs once the request body is complete (and its
// payload hash checked) and returns the response.

#include "micros3/digest.h"
#include "micros3/http.h"
#include "micros3/objects.h"
#include "micros3/router.h"
#include "micros3/store.h"

#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <variant>

namespace micros3::handlers {

// The exchange that serves `route`, or nullptr when its operation has no
// handler yet.
std::unique_ptr<http::Exchange> begin(Store &store, const http::Request &request, const router::Route &route);

// Bucket operations (bucket_handlers.cpp). `body` is the whole request body.
http::Response list_buckets(Store &store, const http::Request &request, const router::Route &route);
http::Response create_bucket(Store &store, const http::Request &request, const router::Route &route,
                             std::string_view body);
http::Response head_bucket(Store &store, const http::Request &request, const router::Route &route);
http::Response get_bucket_location(Store &store, const http::Request &request, const router::Route &route);
http::Response get_bucket_encryption(Store &store, const http::Request &request, const router::Route &route);
http::Response delete_bucket(Store &store, const http::Request &request, const router::Route &route);

// Object listings (list_handlers.cpp).
http::Response list_objects(Store &store, const http::Request &request, const router::Route &route);
http::Response list_objects_v2(Store &store, const http::Request &request, const router::Route &route);

// Object operations (object_handlers.cpp). PutObject streams its body, so it
// is an exchange rather than a handler.
std::unique_ptr<http::Exchange> put_object(Store &store, const http::Request &request, const router::Route &route);
http::Response get_object(Store &store, const http::Request &request, const router::Route &route);
http::Response head_object(Store &store, const http::Request &request, const router::Route &route);
http::Response delete_object(Store &store, const http::Request &request, const router::Route &route);
http::Response copy_object(Store &store, const http::Request &request, const router::Route &route);

// DeleteObjects (delete_objects_handler.cpp). `body` is the whole request body.
http::Response delete_objects(Store &store, const http::Request &request, const router::Route &route,
                              std::string_view body);

// Bucket CORS configuration (cors_handlers.cpp). `body` is the whole request body.
http::Response put_bucket_cors(Store &store, const http::Request &request, const router::Route &route,
                               std::string_view body);
http::Response get_bucket_cors(Store &store, const http::Request &request, const router::Route &route);
http::Response delete_bucket_cors(Store &store, const http::Request &request, const router::Route &route);

// CORS preflight OPTIONS (cors_handlers.cpp), answered without a signature. A
// missing Origin or an invalid Access-Control-Request-Method is BadRequest
// (400). A missing bucket, a bucket without a configuration, or a request no
// rule allows is AccessForbidden (403), with no CORS headers.
http::Response preflight(Store &store, const http::Request &request, const router::Route &route);

// Adds CORS headers to the response to a signed request on a bucket, from the
// first rule that matches its Origin and method. Adds `Vary: Origin` whenever
// the bucket has a configuration, since the response then depends on Origin.
void add_cors_headers(Store &store, const http::Request &request, const router::Route &route,
                      http::Response &response);

// Multipart uploads (multipart_handlers.cpp). UploadPart streams its body.
http::Response create_multipart_upload(Store &store, const http::Request &request, const router::Route &route);
std::unique_ptr<http::Exchange> upload_part(Store &store, const http::Request &request, const router::Route &route);
http::Response list_parts(Store &store, const http::Request &request, const router::Route &route);
http::Response list_multipart_uploads(Store &store, const http::Request &request, const router::Route &route);
http::Response complete_multipart_upload(Store &store, const http::Request &request, const router::Route &route,
                                         std::string_view body);
http::Response abort_multipart_upload(Store &store, const http::Request &request, const router::Route &route);

// The digests a streamed body must match, decoded from the Content-MD5,
// x-amz-checksum-crc32 and x-amz-checksum-sha256 headers.
struct ExpectedDigests {
    std::optional<std::string> md5;
    std::optional<std::string> crc32;
    std::optional<std::string> sha256;
};

// Reads the expected digests of a request. A malformed value is an error, as
// is a checksum algorithm other than CRC32 and SHA-256 (NotImplemented).
std::variant<ExpectedDigests, S3Error> expected_digests(const http::Request &request);

// Streams a request body into staging/, hashing it as it arrives. Once the
// body is complete and matches the expected digests, commit() decides what
// becomes of the staged blob. On any failure the staging file is removed.
class StagedBodyExchange : public http::Exchange {
public:
    StagedBodyExchange(Store &store, const http::Request &request, ExpectedDigests expected);

    void on_data(std::string_view chunk) override;
    http::Response on_end() override;
    void on_abort() override;

protected:
    // Called once the body has been validated. `md5` is the body's MD5.
    virtual http::Response commit(objects::StagedBlob &blob, const digest::Md5Digest &md5) = 0;
    // Adds the checksum headers the request asked for to a success response.
    void add_checksum_headers(http::Response &response) const;
    // An error response for this request.
    http::Response error(const S3Error &e) const { return http::error_response(e, request_); }

    Store &store_;

private:
    http::Request request_; // path and request ID, for error responses
    ExpectedDigests expected_;
    objects::StagedBlob blob_;
    digest::Md5 md5_;
    std::optional<digest::Crc32> crc32_;
    std::optional<digest::Sha256> sha256_;
    std::optional<std::array<std::uint8_t, 4>> crc32_result_;
    std::optional<digest::Sha256Digest> sha256_result_;
    bool failed_ = false;
};

// The owner (and initiator) of every bucket, object and upload.
inline constexpr std::string_view kOwnerId = "75aa57f09aa0c8caeab4f8c24e99d10f8e7faeebf76c078efc7c6caea54ba06a";
inline constexpr std::string_view kOwnerName = "micros3";

// The value of the x-amz-server-side-encryption header on object responses.
// Objects are stored unencrypted, but answer as SSE-S3 (design.md, question 3).
inline constexpr std::string_view kSseAlgorithm = "AES256";

// The error for a key longer than objects::kMaxKeyBytes.
inline S3Error key_too_long() { return {400, "KeyTooLongError", "Your key is too long"}; }

// Checks the x-amz-server-side-encryption header and the stored metadata of a
// request that creates an object (PutObject, CreateMultipartUpload).
std::optional<S3Error> check_object_request(const http::Request &request, const router::Route &route,
                                            const http::Headers &metadata);

// Checks Content-MD5 and the CRC32 and SHA-256 checksum headers, when present,
// against a buffered body. Other checksum algorithms are not checked.
std::optional<S3Error> check_body_digests(const http::Request &request, std::string_view body);

// A 200 response with an XML body.
http::Response xml_response(std::string body);

} // namespace micros3::handlers
