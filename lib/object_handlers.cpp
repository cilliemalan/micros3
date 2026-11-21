// PutObject, CopyObject, GetObject, HeadObject and DeleteObject.

#include "micros3/buckets.h"
#include "micros3/clock.h"
#include "micros3/conditions.h"
#include "micros3/digest.h"
#include "micros3/handlers.h"
#include "micros3/objects.h"
#include "micros3/url.h"
#include "micros3/xml.h"

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

std::string quote_etag(std::string_view text) { return "\"" + std::string(text) + "\""; }

// Streams a PutObject body into staging/, then commits it as the object.
class PutObjectExchange : public StagedBodyExchange {
public:
    PutObjectExchange(Store &store, const http::Request &request, const router::Route &route,
                      http::Headers metadata, ExpectedDigests expected)
        : StagedBodyExchange(store, request, std::move(expected)), bucket_(route.bucket), key_(route.key),
          metadata_(std::move(metadata)) {}

protected:
    http::Response commit(objects::StagedBlob &blob, const digest::Md5Digest &md5) override {
        objects::Object object;
        object.bucket = bucket_;
        object.key = key_;
        object.size = blob.size();
        object.etag = quote_etag(digest::hex(md5));
        object.last_modified_ms = clock::now_ms();
        object.headers = std::move(metadata_);
        object.blob_id = blob.commit();
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
            return error(no_such_bucket());
        }
        if (replaced) objects::remove_blob(store_, *replaced);

        http::Response response;
        response.set_header("ETag", object.etag);
        response.set_header("x-amz-server-side-encryption", std::string(kSseAlgorithm));
        add_checksum_headers(response);
        return response;
    }

private:
    std::string bucket_;
    std::string key_;
    http::Headers metadata_;
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

// The bucket, key and version of an x-amz-copy-source header.
struct CopySource {
    std::string bucket;
    std::string key;
    std::optional<std::string> version_id;
};

// Parses `bucket/key[?versionId=v]`, percent-encoded, with an optional leading
// slash. Returns nullopt when it is malformed.
std::optional<CopySource> parse_copy_source(std::string_view header) {
    std::string_view rest = header;
    std::optional<std::string> version_id;
    if (const std::size_t question = rest.find('?'); question != std::string_view::npos) {
        const auto query = url::Query::parse(rest.substr(question + 1));
        if (!query) return std::nullopt;
        version_id = query->get("versionId");
        rest = rest.substr(0, question);
    }
    if (!rest.empty() && rest.front() == '/') rest.remove_prefix(1);
    const std::size_t slash = rest.find('/');
    if (slash == std::string_view::npos || slash == 0 || slash + 1 == rest.size()) return std::nullopt;
    auto bucket = url::decode(rest.substr(0, slash), false);
    auto key = url::decode(rest.substr(slash + 1), false);
    if (!bucket || !key) return std::nullopt;
    return CopySource{std::move(*bucket), std::move(*key), std::move(version_id)};
}

S3Error invalid_copy_source() {
    return invalid_argument("Copy Source must mention the source bucket and key: sourcebucket/sourcekey");
}

} // namespace

std::unique_ptr<http::Exchange> put_object(Store &store, const http::Request &request, const router::Route &route) {
    // Conditional writes are not supported (D7).
    if (request.header("if-none-match") || request.header("if-match")) {
        return fixed_error(not_implemented("Conditional writes are not implemented."), request);
    }
    auto expected = expected_digests(request);
    if (auto *e = std::get_if<S3Error>(&expected)) return fixed_error(*e, request);
    http::Headers metadata = objects::metadata_from(request);
    if (auto e = check_object_request(request, route, metadata)) return fixed_error(*e, request);
    if (auto e = check_content_length(store, request)) return fixed_error(*e, request);
    if (!buckets::find(store, route.bucket)) return fixed_error(no_such_bucket(), request);
    return std::make_unique<PutObjectExchange>(store, request, route, std::move(metadata),
                                               std::get<ExpectedDigests>(std::move(expected)));
}

http::Response copy_object(Store &store, const http::Request &request, const router::Route &route) {
    // Conditional writes are not supported (D7).
    if (request.header("if-none-match") || request.header("if-match")) {
        return error(not_implemented("Conditional writes are not implemented."), request);
    }
    const auto source = parse_copy_source(request.header("x-amz-copy-source").value_or(""));
    if (!source) return error(invalid_copy_source(), request);
    if (source->version_id && *source->version_id != "null") {
        return error(invalid_argument("Invalid version id specified"), request);
    }
    if (route.key.size() > objects::kMaxKeyBytes) return error(key_too_long(), request);
    if (auto sse = request.header("x-amz-server-side-encryption"); sse && *sse != kSseAlgorithm) {
        return error(not_implemented("Only SSE-S3 (AES256) server-side encryption is implemented."), request);
    }
    if (request.header("x-amz-checksum-algorithm")) {
        return error(not_implemented("The x-amz-checksum-algorithm header is not implemented."), request);
    }
    const std::string directive(request.header("x-amz-metadata-directive").value_or("COPY"));
    if (directive != "COPY" && directive != "REPLACE") {
        return error(invalid_argument("Unknown metadata directive."), request);
    }
    const bool replace = directive == "REPLACE";
    http::Headers metadata;
    if (replace) {
        metadata = objects::metadata_from(request);
        if (objects::user_metadata_bytes(metadata) > objects::kMaxUserMetadataBytes) {
            return error({400, "MetadataTooLarge", "Your metadata headers exceed the maximum allowed metadata size."},
                         request);
        }
    }

    if (!buckets::find(store, route.bucket)) return error(no_such_bucket(), request);
    if (!buckets::find(store, source->bucket)) return error(no_such_bucket(), request);
    auto object = objects::find(store, source->bucket, source->key);
    if (!object) return error(no_such_key(), request);

    conditions::Preconditions preconditions;
    preconditions.if_match = request.header("x-amz-copy-source-if-match");
    preconditions.if_unmodified_since = request.header("x-amz-copy-source-if-unmodified-since");
    preconditions.if_none_match = request.header("x-amz-copy-source-if-none-match");
    preconditions.if_modified_since = request.header("x-amz-copy-source-if-modified-since");
    // Every failed copy condition is 412, including those that are 304 on GET.
    if (conditions::evaluate(preconditions, object->etag, object->last_modified_ms, clock::now_ms()) !=
        conditions::Outcome::Proceed) {
        return error(precondition_failed(), request);
    }

    if (source->bucket == route.bucket && source->key == route.key && !replace) {
        return error({400, "InvalidRequest",
                      "This copy request is illegal because it is trying to copy an object to itself without "
                      "changing the object's metadata, storage class, website redirect location or encryption "
                      "attributes."},
                     request);
    }

    objects::Object copied;
    std::optional<http::Headers> headers;
    if (replace) headers = std::move(metadata);
    if (objects::copy(store, *object, route.bucket, route.key, headers, copied) == objects::CopyResult::NoSuchBucket) {
        return error(no_such_bucket(), request);
    }

    xml::Writer writer;
    writer.open("CopyObjectResult", xml::kS3Namespace)
        .element("LastModified", clock::iso8601(copied.last_modified_ms))
        .element("ETag", copied.etag);
    http::Response response = xml_response(writer.finish());
    response.set_header("x-amz-server-side-encryption", std::string(kSseAlgorithm));
    return response;
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
