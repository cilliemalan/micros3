#include "micros3/handlers.h"

#include "micros3/digest.h"

#include <utility>

namespace micros3::handlers {

namespace {

// The largest body a handler that buffers its body accepts.
constexpr std::size_t kMaxBufferedBody = 1024 * 1024;

} // namespace

std::optional<S3Error> check_body_digests(const http::Request &request, std::string_view body) {
    if (auto value = request.header("content-md5")) {
        auto decoded = digest::base64_decode(*value);
        if (!decoded || decoded->size() != 16) return invalid_digest();
        const auto md5 = digest::md5(body);
        if (*decoded != std::string_view(reinterpret_cast<const char *>(md5.data()), md5.size())) return bad_digest();
    }
    if (auto value = request.header("x-amz-checksum-crc32")) {
        auto decoded = digest::base64_decode(*value);
        if (!decoded || decoded->size() != 4) {
            return S3Error{400, "InvalidRequest", "Value for x-amz-checksum-crc32 header is invalid."};
        }
        digest::Crc32 crc;
        crc.update(body);
        const auto bytes = crc.bytes();
        if (*decoded != std::string_view(reinterpret_cast<const char *>(bytes.data()), bytes.size())) {
            return bad_digest("The CRC32 you specified did not match the calculated checksum.");
        }
    }
    if (auto value = request.header("x-amz-checksum-sha256")) {
        auto decoded = digest::base64_decode(*value);
        if (!decoded || decoded->size() != 32) {
            return S3Error{400, "InvalidRequest", "Value for x-amz-checksum-sha256 header is invalid."};
        }
        const auto sha = digest::sha256(body);
        if (*decoded != std::string_view(reinterpret_cast<const char *>(sha.data()), sha.size())) {
            return bad_digest("The SHA256 you specified did not match the calculated checksum.");
        }
    }
    return std::nullopt;
}

http::Response xml_response(std::string body) {
    http::Response response;
    response.body = std::move(body);
    response.set_header("Content-Type", "application/xml");
    return response;
}

std::unique_ptr<http::Exchange> begin(Store &store, const http::Request &request, const router::Route &route) {
    using router::Operation;
    // The handler runs after the body, so it keeps its own copies.
    auto buffered = [&](auto handler) -> std::unique_ptr<http::Exchange> {
        return std::make_unique<http::BufferedExchange>(
            request, kMaxBufferedBody,
            [&store, request, route, handler](std::string body) { return handler(store, request, route, body); });
    };
    auto ignoring_body = [&](http::Response (*handler)(Store &, const http::Request &, const router::Route &)) {
        return buffered([handler](Store &s, const http::Request &q, const router::Route &r, const std::string &) {
            return handler(s, q, r);
        });
    };

    switch (route.op) {
    case Operation::ListBuckets: return ignoring_body(&list_buckets);
    case Operation::CreateBucket:
        return buffered([](Store &s, const http::Request &q, const router::Route &r, const std::string &body) {
            return create_bucket(s, q, r, body);
        });
    case Operation::HeadBucket: return ignoring_body(&head_bucket);
    case Operation::GetBucketLocation: return ignoring_body(&get_bucket_location);
    case Operation::GetBucketEncryption: return ignoring_body(&get_bucket_encryption);
    case Operation::DeleteBucket: return ignoring_body(&delete_bucket);
    case Operation::ListObjects: return ignoring_body(&list_objects);
    case Operation::ListObjectsV2: return ignoring_body(&list_objects_v2);
    case Operation::PutObject: return put_object(store, request, route);
    case Operation::GetObject: return ignoring_body(&get_object);
    case Operation::HeadObject: return ignoring_body(&head_object);
    case Operation::DeleteObject: return ignoring_body(&delete_object);
    case Operation::CopyObject: return ignoring_body(&copy_object);
    case Operation::PutBucketCors:
        return buffered([](Store &s, const http::Request &q, const router::Route &r, const std::string &body) {
            return put_bucket_cors(s, q, r, body);
        });
    case Operation::GetBucketCors: return ignoring_body(&get_bucket_cors);
    case Operation::DeleteBucketCors: return ignoring_body(&delete_bucket_cors);
    case Operation::DeleteObjects:
        return buffered([](Store &s, const http::Request &q, const router::Route &r, const std::string &body) {
            return delete_objects(s, q, r, body);
        });
    default: return nullptr;
    }
}

} // namespace micros3::handlers
