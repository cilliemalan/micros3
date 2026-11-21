// Streamed request bodies (PutObject, UploadPart): the expected digests and
// the exchange that stages, hashes and validates the body.

#include "micros3/handlers.h"

#include <iostream>
#include <tuple>

namespace micros3::handlers {

namespace {

std::string_view as_view(const void *data, std::size_t size) {
    return std::string_view(static_cast<const char *>(data), size);
}

} // namespace

std::variant<ExpectedDigests, S3Error> expected_digests(const http::Request &request) {
    for (const char *name : {"x-amz-checksum-crc32c", "x-amz-checksum-crc64nvme", "x-amz-checksum-sha1"}) {
        if (request.header(name)) return not_implemented(std::string("The ") + name + " header is not implemented.");
    }
    ExpectedDigests out;
    if (auto value = request.header("content-md5")) {
        auto decoded = digest::base64_decode(*value);
        if (!decoded || decoded->size() != 16) return invalid_digest();
        out.md5 = std::move(*decoded);
    }
    for (auto [name, size, target] : {std::tuple{"x-amz-checksum-crc32", std::size_t{4}, &out.crc32},
                                      std::tuple{"x-amz-checksum-sha256", std::size_t{32}, &out.sha256}}) {
        const auto value = request.header(name);
        if (!value) continue;
        auto decoded = digest::base64_decode(*value);
        if (!decoded || decoded->size() != size) {
            return S3Error{400, "InvalidRequest", std::string("Value for ") + name + " header is invalid."};
        }
        *target = std::move(*decoded);
    }
    return out;
}

std::optional<S3Error> check_object_request(const http::Request &request, const router::Route &route,
                                            const http::Headers &metadata) {
    if (route.key.size() > objects::kMaxKeyBytes) return key_too_long();
    if (auto sse = request.header("x-amz-server-side-encryption"); sse && *sse != kSseAlgorithm) {
        return not_implemented("Only SSE-S3 (AES256) server-side encryption is implemented.");
    }
    if (objects::user_metadata_bytes(metadata) > objects::kMaxUserMetadataBytes) {
        return S3Error{400, "MetadataTooLarge", "Your metadata headers exceed the maximum allowed metadata size."};
    }
    return std::nullopt;
}

StagedBodyExchange::StagedBodyExchange(Store &store, const http::Request &request, ExpectedDigests expected)
    : store_(store), expected_(std::move(expected)), blob_(store) {
    request_.method = request.method;
    request_.path = request.path;
    request_.request_id = request.request_id;
    if (expected_.crc32) crc32_.emplace();
    if (expected_.sha256) sha256_.emplace();
}

void StagedBodyExchange::on_data(std::string_view chunk) {
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

http::Response StagedBodyExchange::on_end() {
    if (failed_) return error(internal_error());
    const digest::Md5Digest md5 = md5_.finish();
    if (expected_.md5 && *expected_.md5 != as_view(md5.data(), md5.size())) {
        blob_.discard();
        return error(bad_digest());
    }
    if (crc32_) {
        crc32_result_ = crc32_->bytes();
        if (*expected_.crc32 != as_view(crc32_result_->data(), crc32_result_->size())) {
            blob_.discard();
            return error(bad_digest("The CRC32 you specified did not match the calculated checksum."));
        }
    }
    if (sha256_) {
        sha256_result_ = sha256_->finish();
        if (*expected_.sha256 != as_view(sha256_result_->data(), sha256_result_->size())) {
            blob_.discard();
            return error(bad_digest("The SHA256 you specified did not match the calculated checksum."));
        }
    }
    return commit(blob_, md5);
}

void StagedBodyExchange::on_abort() { blob_.discard(); }

void StagedBodyExchange::add_checksum_headers(http::Response &response) const {
    if (crc32_result_) response.set_header("x-amz-checksum-crc32", digest::base64_encode(*crc32_result_));
    if (sha256_result_) response.set_header("x-amz-checksum-sha256", digest::base64_encode(*sha256_result_));
}

} // namespace micros3::handlers
