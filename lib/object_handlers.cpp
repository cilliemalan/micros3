// PutObject, GetObject, HeadObject and DeleteObject.

#include "micros3/buckets.h"
#include "micros3/clock.h"
#include "micros3/conditions.h"
#include "micros3/digest.h"
#include "micros3/handlers.h"
#include "micros3/objects.h"

#include <fcntl.h>
#include <unistd.h>

#include <array>
#include <cerrno>
#include <cstring>
#include <iostream>
#include <optional>
#include <string>
#include <system_error>
#include <tuple>

namespace micros3::handlers {

namespace {

// Objects are stored unencrypted, but answer as SSE-S3 (design.md, question 3).
constexpr std::string_view kSseAlgorithm = "AES256";

// GetObject query parameters that override a response header.
constexpr std::array<std::pair<std::string_view, std::string_view>, 6> kResponseOverrides = {{
    {"response-content-type", "Content-Type"},
    {"response-content-language", "Content-Language"},
    {"response-expires", "Expires"},
    {"response-cache-control", "Cache-Control"},
    {"response-content-disposition", "Content-Disposition"},
    {"response-content-encoding", "Content-Encoding"},
}};

http::Response error(const S3Error &e, const http::Request &request) { return http::error_response(e, request); }

std::unique_ptr<http::Exchange> fixed_error(const S3Error &e, const http::Request &request) {
    return std::make_unique<http::FixedExchange>(error(e, request));
}

S3Error key_too_long() { return {400, "KeyTooLongError", "Your key is too long"}; }

std::string quote_etag(std::string_view text) { return "\"" + std::string(text) + "\""; }

// A checksum header's value: absent, or decoded to `size` bytes, or invalid.
struct ChecksumHeader {
    bool present = false;
    bool valid = false;
    std::string bytes;
};

ChecksumHeader checksum_header(const http::Request &request, std::string_view name, std::size_t size) {
    ChecksumHeader result;
    const auto value = request.header(name);
    if (!value) return result;
    result.present = true;
    auto decoded = digest::base64_decode(*value);
    if (decoded && decoded->size() == size) {
        result.valid = true;
        result.bytes = std::move(*decoded);
    }
    return result;
}

std::string_view as_view(const void *data, std::size_t size) {
    return std::string_view(static_cast<const char *>(data), size);
}

// Streams a PutObject body into staging/, hashing it as it arrives, then
// validates and commits it.
class PutObjectExchange : public http::Exchange {
public:
    PutObjectExchange(Store &store, const http::Request &request, const router::Route &route,
                      http::Headers metadata, std::optional<std::string> content_md5,
                      std::optional<std::string> crc32, std::optional<std::string> sha256)
        : store_(store), bucket_(route.bucket), key_(route.key), metadata_(std::move(metadata)),
          content_md5_(std::move(content_md5)), expected_crc32_(std::move(crc32)),
          expected_sha256_(std::move(sha256)), blob_(store) {
        request_.method = request.method;
        request_.path = request.path;
        request_.request_id = request.request_id;
        if (expected_crc32_) crc32_.emplace();
        if (expected_sha256_) sha256_.emplace();
    }

    void on_data(std::string_view chunk) override {
        if (failed_) return;
        md5_.update(chunk);
        if (crc32_) crc32_->update(chunk);
        if (sha256_) sha256_->update(chunk);
        try {
            blob_.write(chunk);
        } catch (const std::exception &e) {
            std::cerr << "Request " << request_.request_id << " failed: " << e.what() << std::endl;
            failed_ = true;
            blob_.discard();
        }
    }

    http::Response on_end() override {
        if (failed_) return error(internal_error(), request_);
        const digest::Md5Digest md5 = md5_.finish();
        if (content_md5_ && *content_md5_ != as_view(md5.data(), md5.size())) {
            blob_.discard();
            return error(bad_digest(), request_);
        }
        std::optional<std::array<std::uint8_t, 4>> crc;
        if (crc32_) {
            crc = crc32_->bytes();
            if (*expected_crc32_ != as_view(crc->data(), crc->size())) {
                blob_.discard();
                return error(bad_digest("The CRC32 you specified did not match the calculated checksum."), request_);
            }
        }
        std::optional<digest::Sha256Digest> sha;
        if (sha256_) {
            sha = sha256_->finish();
            if (*expected_sha256_ != as_view(sha->data(), sha->size())) {
                blob_.discard();
                return error(bad_digest("The SHA256 you specified did not match the calculated checksum."), request_);
            }
        }

        objects::Object object;
        object.bucket = bucket_;
        object.key = key_;
        object.size = blob_.size();
        object.etag = quote_etag(digest::hex(md5));
        object.last_modified_ms = clock::now_ms();
        object.headers = std::move(metadata_);
        object.blob_id = blob_.commit();
        std::optional<std::string> replaced;
        objects::PutResult result;
        try {
            result = objects::put(store_, object, replaced);
        } catch (...) {
            objects::remove_blob(store_, object.blob_id);
            throw;
        }
        if (result == objects::PutResult::NoSuchBucket) {
            // The bucket was deleted while the body was uploading.
            objects::remove_blob(store_, object.blob_id);
            return error(no_such_bucket(), request_);
        }
        if (replaced) objects::remove_blob(store_, *replaced);

        http::Response response;
        response.set_header("ETag", object.etag);
        response.set_header("x-amz-server-side-encryption", std::string(kSseAlgorithm));
        if (crc) response.set_header("x-amz-checksum-crc32", digest::base64_encode(*crc));
        if (sha) response.set_header("x-amz-checksum-sha256", digest::base64_encode(*sha));
        return response;
    }

    void on_abort() override { blob_.discard(); }

private:
    Store &store_;
    http::Request request_; // path and request ID, for error responses
    std::string bucket_;
    std::string key_;
    http::Headers metadata_;
    std::optional<std::string> content_md5_;
    std::optional<std::string> expected_crc32_;
    std::optional<std::string> expected_sha256_;
    objects::StagedBlob blob_;
    digest::Md5 md5_;
    std::optional<digest::Crc32> crc32_;
    std::optional<digest::Sha256> sha256_;
    bool failed_ = false;
};

// The headers GetObject and HeadObject return for an object.
void object_headers(http::Response &response, const objects::Object &object, const url::Query &query) {
    response.set_header("ETag", object.etag);
    response.set_header("Last-Modified", clock::http_date(object.last_modified_ms));
    response.set_header("Accept-Ranges", "bytes");
    response.set_header("x-amz-server-side-encryption", std::string(kSseAlgorithm));
    bool has_type = false;
    for (const auto &[name, value] : object.headers) {
        if (name == "Content-Type") has_type = true;
        response.set_header(name, value);
    }
    if (!has_type) response.set_header("Content-Type", "binary/octet-stream");
    for (const auto &[param, header] : kResponseOverrides) {
        if (auto value = query.get(param)) response.set_header(std::string(header), *value);
    }
}

// GetObject and HeadObject: the same checks and headers, with a body only
// for GET.
http::Response read_object(Store &store, const http::Request &request, const router::Route &route, bool with_body) {
    if (!buckets::find(store, route.bucket)) return error(no_such_bucket(), request);
    const auto object = objects::find(store, route.bucket, route.key);
    if (!object) return error(no_such_key(), request);

    conditions::Preconditions preconditions;
    preconditions.if_match = request.header("if-match");
    preconditions.if_unmodified_since = request.header("if-unmodified-since");
    preconditions.if_none_match = request.header("if-none-match");
    preconditions.if_modified_since = request.header("if-modified-since");
    switch (conditions::evaluate(preconditions, object->etag, object->last_modified_ms, clock::now_ms())) {
    case conditions::Outcome::Proceed: break;
    case conditions::Outcome::NotModified: {
        http::Response response;
        response.status = 304;
        response.set_header("ETag", object->etag);
        response.set_header("Last-Modified", clock::http_date(object->last_modified_ms));
        return response;
    }
    case conditions::Outcome::PreconditionFailed: return error(precondition_failed(), request);
    }

    const conditions::RangeResult range = conditions::parse_range(request.header("range"), object->size);
    if (range.kind == conditions::RangeKind::Unsatisfiable) {
        http::Response response = error(invalid_range(), request);
        response.set_header("Content-Range", "bytes */" + std::to_string(object->size));
        return response;
    }

    http::Response response;
    object_headers(response, *object, route.query);
    std::uint64_t offset = 0;
    std::uint64_t length = object->size;
    if (range.kind == conditions::RangeKind::Partial) {
        response.status = 206;
        offset = range.range.first;
        length = range.range.length();
        response.set_header("Content-Range", "bytes " + std::to_string(range.range.first) + "-" +
                                                 std::to_string(range.range.last) + "/" +
                                                 std::to_string(object->size));
    }
    if (!with_body) {
        response.reported_length = length;
        return response;
    }
    const std::filesystem::path path = store.blob_path(object->blob_id);
    const int fd = ::open(path.c_str(), O_RDONLY | O_CLOEXEC);
    if (fd < 0) throw std::system_error(errno, std::generic_category(), "open " + path.string());
    response.file = std::make_shared<http::FileBody>(fd, offset, length);
    return response;
}

} // namespace

std::unique_ptr<http::Exchange> put_object(Store &store, const http::Request &request, const router::Route &route) {
    // Conditional writes are not supported (D7).
    if (request.header("if-none-match") || request.header("if-match")) {
        return fixed_error(not_implemented("Conditional writes are not implemented."), request);
    }
    if (route.key.size() > objects::kMaxKeyBytes) return fixed_error(key_too_long(), request);
    if (auto sse = request.header("x-amz-server-side-encryption"); sse && *sse != kSseAlgorithm) {
        return fixed_error(not_implemented("Only SSE-S3 (AES256) server-side encryption is implemented."), request);
    }
    for (const char *name : {"x-amz-checksum-crc32c", "x-amz-checksum-crc64nvme", "x-amz-checksum-sha1"}) {
        if (request.header(name)) {
            return fixed_error(not_implemented(std::string("The ") + name + " header is not implemented."), request);
        }
    }

    std::optional<std::string> content_md5;
    if (auto value = request.header("content-md5")) {
        auto decoded = digest::base64_decode(*value);
        if (!decoded || decoded->size() != 16) return fixed_error(invalid_digest(), request);
        content_md5 = std::move(*decoded);
    }
    std::optional<std::string> crc32;
    std::optional<std::string> sha256;
    for (auto [name, size, target] : {std::tuple{"x-amz-checksum-crc32", std::size_t{4}, &crc32},
                                      std::tuple{"x-amz-checksum-sha256", std::size_t{32}, &sha256}}) {
        ChecksumHeader header = checksum_header(request, name, size);
        if (!header.present) continue;
        if (!header.valid) {
            return fixed_error({400, "InvalidRequest", std::string("Value for ") + name + " header is invalid."},
                               request);
        }
        *target = std::move(header.bytes);
    }

    http::Headers metadata = objects::metadata_from(request);
    if (objects::user_metadata_bytes(metadata) > objects::kMaxUserMetadataBytes) {
        return fixed_error({400, "MetadataTooLarge", "Your metadata headers exceed the maximum allowed metadata size."},
                           request);
    }
    if (!buckets::find(store, route.bucket)) return fixed_error(no_such_bucket(), request);
    return std::make_unique<PutObjectExchange>(store, request, route, std::move(metadata), std::move(content_md5),
                                               std::move(crc32), std::move(sha256));
}

http::Response get_object(Store &store, const http::Request &request, const router::Route &route) {
    return read_object(store, request, route, true);
}

http::Response head_object(Store &store, const http::Request &request, const router::Route &route) {
    return read_object(store, request, route, false);
}

http::Response delete_object(Store &store, const http::Request &request, const router::Route &route) {
    if (objects::remove(store, route.bucket, route.key) == objects::DeleteResult::NoSuchBucket) {
        return error(no_such_bucket(), request);
    }
    http::Response response;
    response.status = 204;
    return response;
}

} // namespace micros3::handlers
