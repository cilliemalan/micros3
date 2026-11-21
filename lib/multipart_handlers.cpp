// Multipart uploads: CreateMultipartUpload, UploadPart, ListParts,
// ListMultipartUploads, CompleteMultipartUpload and AbortMultipartUpload.

#include "micros3/buckets.h"
#include "micros3/clock.h"
#include "micros3/handlers.h"
#include "micros3/listing.h"
#include "micros3/uploads.h"
#include "micros3/xml.h"

#include <pugixml.hpp>

#include <algorithm>
#include <stdexcept>
#include <string>
#include <variant>
#include <vector>

namespace micros3::handlers {

namespace {

http::Response error(const S3Error &e, const http::Request &request) { return http::error_response(e, request); }

S3Error no_such_upload() {
    return {404, "NoSuchUpload",
            "The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted "
            "or completed."};
}

S3Error invalid_part() {
    return {400, "InvalidPart",
            "One or more of the specified parts could not be found. The part may not have been uploaded, or the "
            "specified entity tag may not match the part's entity tag."};
}

S3Error invalid_part_order() {
    return {400, "InvalidPartOrder", "The list of parts was not in ascending order. Parts must be ordered by part number."};
}

S3Error entity_too_small() {
    return {400, "EntityTooSmall", "Your proposed upload is smaller than the minimum allowed object size."};
}

std::string quote_etag(std::string_view text) { return "\"" + std::string(text) + "\""; }

// An ETag without its surrounding quotes, if it has them.
std::string_view unquoted(std::string_view etag) {
    if (etag.size() >= 2 && etag.front() == '"' && etag.back() == '"') return etag.substr(1, etag.size() - 2);
    return etag;
}

// Parses a non-negative decimal integer query value. Returns nullopt when the
// value is not one (or does not fit in a long long).
std::optional<long long> parse_count(std::string_view text) {
    if (text.empty() || text.size() > 18) return std::nullopt;
    long long value = 0;
    for (char c : text) {
        if (c < '0' || c > '9') return std::nullopt;
        value = value * 10 + (c - '0');
    }
    return value;
}

// Reads a part number query value: an integer from 1 to 10,000.
std::optional<int> parse_part_number(std::optional<std::string> text) {
    if (!text) return std::nullopt;
    const auto value = parse_count(*text);
    if (!value || *value < uploads::kMinPartNumber || *value > uploads::kMaxPartNumber) return std::nullopt;
    return static_cast<int>(*value);
}

// Reads a page size query parameter (max-parts, max-uploads), clamped to
// uploads::kMaxListing.
std::optional<S3Error> parse_page_size(const url::Query &query, std::string_view name, std::size_t &out) {
    const auto text = query.get(name);
    if (!text) return std::nullopt;
    const auto value = parse_count(*text);
    if (!value) {
        return invalid_argument("Provided " + std::string(name) + " not an integer or within integer range");
    }
    out = static_cast<std::size_t>(std::min<long long>(*value, uploads::kMaxListing));
    return std::nullopt;
}

// Reads the encoding-type parameter of a listing. Returns an error for any
// value other than `url`.
std::optional<S3Error> parse_encoding(const url::Query &query, bool &url_encoding) {
    url_encoding = false;
    if (auto encoding = query.get("encoding-type")) {
        if (*encoding != "url") return invalid_argument("Invalid Encoding Method specified in Request");
        url_encoding = true;
    }
    return std::nullopt;
}

void write_owner(xml::Writer &writer, std::string_view element) {
    writer.open(element).element("ID", kOwnerId).element("DisplayName", kOwnerName).close();
}

// The upload a request names with `uploadId`, or the error to answer: a
// missing bucket is NoSuchBucket, and a missing upload NoSuchUpload.
std::variant<uploads::Upload, S3Error> find_upload(Store &store, const router::Route &route) {
    if (!buckets::find(store, route.bucket)) return no_such_bucket();
    const auto upload_id = route.query.get("uploadId");
    if (!upload_id) return no_such_upload();
    auto upload = uploads::find(store, route.bucket, route.key, *upload_id);
    if (!upload) return no_such_upload();
    return std::move(*upload);
}

// Streams an UploadPart body into staging/, then commits it as the part.
class UploadPartExchange : public StagedBodyExchange {
public:
    UploadPartExchange(Store &store, const http::Request &request, uploads::Upload upload, int part_number,
                       ExpectedDigests expected)
        : StagedBodyExchange(store, request, std::move(expected)), upload_(std::move(upload)),
          part_number_(part_number) {}

protected:
    http::Response commit(objects::StagedBlob &blob, const digest::Md5Digest &md5) override {
        uploads::Part part;
        part.number = part_number_;
        part.size = blob.size();
        part.etag = quote_etag(digest::hex(md5));
        part.last_modified_ms = clock::now_ms();
        part.blob_id = blob.commit();
        std::optional<std::string> replaced;
        uploads::Result result;
        try {
            result = uploads::put_part(store_, upload_, part, replaced);
        } catch (...) {
            objects::remove_blob(store_, part.blob_id);
            throw;
        }
        if (result == uploads::Result::NoSuchUpload) {
            // The upload was completed, aborted or deleted with its bucket
            // while the body was uploading.
            objects::remove_blob(store_, part.blob_id);
            return error(no_such_upload());
        }
        if (replaced) objects::remove_blob(store_, *replaced);

        http::Response response;
        response.set_header("ETag", part.etag);
        response.set_header("x-amz-server-side-encryption", std::string(kSseAlgorithm));
        add_checksum_headers(response);
        return response;
    }

private:
    uploads::Upload upload_;
    int part_number_;
};

// A part a CompleteMultipartUpload body names.
struct RequestedPart {
    int number = 0;
    std::string etag;
};

// Parses a CompleteMultipartUpload body. Parts out of ascending order are
// InvalidPartOrder; anything else unexpected is MalformedXML.
std::variant<std::vector<RequestedPart>, S3Error> parse_complete(std::string_view body) {
    pugi::xml_document doc;
    if (!doc.load_buffer(body.data(), body.size(), pugi::parse_default & ~pugi::parse_eol)) return malformed_xml();
    const pugi::xml_node root = doc.document_element();
    const auto local_name = [](const pugi::xml_node &node) {
        std::string_view name = node.name();
        const std::size_t colon = name.find(':');
        return colon == std::string_view::npos ? name : name.substr(colon + 1);
    };
    if (local_name(root) != "CompleteMultipartUpload") return malformed_xml();
    std::vector<RequestedPart> parts;
    for (const pugi::xml_node &node : root.children()) {
        if (node.type() != pugi::node_element || local_name(node) != "Part") continue;
        std::optional<int> number;
        std::optional<std::string> etag;
        for (const pugi::xml_node &field : node.children()) {
            if (field.type() != pugi::node_element) continue;
            const std::string_view name = local_name(field);
            if (name == "PartNumber") {
                const auto value = parse_count(field.text().get());
                if (!value || *value > uploads::kMaxPartNumber) return malformed_xml();
                number = static_cast<int>(*value);
            } else if (name == "ETag") {
                etag = field.text().get();
            }
        }
        if (!number || !etag) return malformed_xml();
        if (!parts.empty() && *number <= parts.back().number) return invalid_part_order();
        parts.push_back({*number, std::move(*etag)});
    }
    if (parts.empty()) return malformed_xml();
    return parts;
}

} // namespace

http::Response create_multipart_upload(Store &store, const http::Request &request, const router::Route &route) {
    if (request.header("x-amz-checksum-algorithm")) {
        return error(not_implemented("The x-amz-checksum-algorithm header is not implemented."), request);
    }
    uploads::Upload upload;
    upload.headers = objects::metadata_from(request);
    if (auto e = check_object_request(request, route, upload.headers)) return error(*e, request);
    upload.bucket = route.bucket;
    upload.key = route.key;
    upload.initiated_ms = clock::now_ms();
    upload.upload_id = uploads::new_upload_id(upload.initiated_ms);
    if (!uploads::create(store, upload)) return error(no_such_bucket(), request);

    xml::Writer writer;
    writer.open("InitiateMultipartUploadResult", xml::kS3Namespace)
        .element("Bucket", upload.bucket)
        .element("Key", upload.key)
        .element("UploadId", upload.upload_id);
    http::Response response = xml_response(writer.finish());
    response.set_header("x-amz-server-side-encryption", std::string(kSseAlgorithm));
    return response;
}

std::unique_ptr<http::Exchange> upload_part(Store &store, const http::Request &request, const router::Route &route) {
    const auto fixed = [&request](const S3Error &e) {
        return std::make_unique<http::FixedExchange>(error(e, request));
    };
    const auto part_number = parse_part_number(route.query.get("partNumber"));
    if (!part_number) {
        return fixed(invalid_argument("Part number must be an integer between 1 and 10000, inclusive"));
    }
    auto expected = expected_digests(request);
    if (auto *e = std::get_if<S3Error>(&expected)) return fixed(*e);
    auto upload = find_upload(store, route);
    if (auto *e = std::get_if<S3Error>(&upload)) return fixed(*e);
    return std::make_unique<UploadPartExchange>(store, request, std::get<uploads::Upload>(std::move(upload)),
                                                *part_number, std::get<ExpectedDigests>(std::move(expected)));
}

http::Response list_parts(Store &store, const http::Request &request, const router::Route &route) {
    const url::Query &query = route.query;
    std::size_t max_parts = uploads::kMaxListing;
    if (auto e = parse_page_size(query, "max-parts", max_parts)) return error(*e, request);
    int marker = 0;
    if (auto text = query.get("part-number-marker")) {
        const auto value = parse_count(*text);
        if (!value) {
            return error(invalid_argument("Provided part-number-marker not an integer or within integer range"),
                         request);
        }
        marker = static_cast<int>(std::min<long long>(*value, uploads::kMaxPartNumber));
    }
    bool url_encoding = false;
    if (auto e = parse_encoding(query, url_encoding)) return error(*e, request);
    auto found = find_upload(store, route);
    if (auto *e = std::get_if<S3Error>(&found)) return error(*e, request);
    const uploads::Upload &upload = std::get<uploads::Upload>(found);

    std::vector<uploads::Part> parts = uploads::list_parts(store, upload.upload_id, marker, max_parts + 1);
    const bool truncated = parts.size() > max_parts;
    if (truncated) parts.resize(max_parts);

    xml::Writer writer;
    writer.open("ListPartsResult", xml::kS3Namespace)
        .element("Bucket", upload.bucket)
        .element("Key", url_encoding ? listing::url_encode(upload.key) : upload.key)
        .element("UploadId", upload.upload_id);
    if (url_encoding) writer.element("EncodingType", "url");
    write_owner(writer, "Initiator");
    write_owner(writer, "Owner");
    writer.element("StorageClass", "STANDARD")
        .element("PartNumberMarker", std::to_string(marker))
        .element("MaxParts", std::to_string(max_parts))
        .element("IsTruncated", truncated ? "true" : "false");
    if (truncated) writer.element("NextPartNumberMarker", std::to_string(parts.back().number));
    for (const uploads::Part &part : parts) {
        writer.open("Part")
            .element("PartNumber", std::to_string(part.number))
            .element("LastModified", clock::iso8601(part.last_modified_ms))
            .element("ETag", part.etag)
            .element("Size", std::to_string(part.size))
            .close();
    }
    return xml_response(writer.finish());
}

http::Response list_multipart_uploads(Store &store, const http::Request &request, const router::Route &route) {
    const url::Query &query = route.query;
    uploads::ListRequest params;
    params.prefix = query.get("prefix").value_or("");
    params.delimiter = query.get("delimiter").value_or("");
    params.key_marker = query.get("key-marker").value_or("");
    params.upload_id_marker = query.get("upload-id-marker").value_or("");
    if (auto e = parse_page_size(query, "max-uploads", params.max_uploads)) return error(*e, request);
    bool url_encoding = false;
    if (auto e = parse_encoding(query, url_encoding)) return error(*e, request);
    const auto encode = [&](std::string_view value) {
        return url_encoding ? listing::url_encode(value) : std::string(value);
    };

    const auto page = uploads::list(store, route.bucket, params);
    if (!page) return error(no_such_bucket(), request);

    xml::Writer writer;
    writer.open("ListMultipartUploadsResult", xml::kS3Namespace)
        .element("Bucket", route.bucket)
        .element("KeyMarker", encode(params.key_marker))
        .element("UploadIdMarker", params.key_marker.empty() ? "" : params.upload_id_marker);
    if (page->truncated) {
        // After a common prefix, the prefix is the next key marker and there
        // is no upload ID marker.
        const uploads::ListEntry &last = page->entries.back();
        writer.element("NextKeyMarker", encode(last.key));
        if (!last.is_prefix) writer.element("NextUploadIdMarker", last.upload_id);
    }
    if (url_encoding) writer.element("EncodingType", "url");
    writer.element("MaxUploads", std::to_string(params.max_uploads))
        .element("IsTruncated", page->truncated ? "true" : "false")
        .element("Prefix", encode(params.prefix));
    if (!params.delimiter.empty()) writer.element("Delimiter", encode(params.delimiter));
    for (const uploads::ListEntry &entry : page->entries) {
        if (entry.is_prefix) continue;
        writer.open("Upload").element("Key", encode(entry.key)).element("UploadId", entry.upload_id);
        write_owner(writer, "Initiator");
        write_owner(writer, "Owner");
        writer.element("StorageClass", "STANDARD")
            .element("Initiated", clock::iso8601(entry.initiated_ms))
            .close();
    }
    for (const uploads::ListEntry &entry : page->entries) {
        if (entry.is_prefix) writer.open("CommonPrefixes").element("Prefix", encode(entry.key)).close();
    }
    return xml_response(writer.finish());
}

http::Response complete_multipart_upload(Store &store, const http::Request &request, const router::Route &route,
                                         std::string_view body) {
    // Conditional writes are not supported (D7).
    if (request.header("if-none-match") || request.header("if-match")) {
        return error(not_implemented("Conditional writes are not implemented."), request);
    }
    auto found = find_upload(store, route);
    if (auto *e = std::get_if<S3Error>(&found)) return error(*e, request);
    const uploads::Upload &upload = std::get<uploads::Upload>(found);
    if (auto e = check_body_digests(request, body)) return error(*e, request);
    auto parsed = parse_complete(body);
    if (auto *e = std::get_if<S3Error>(&parsed)) return error(*e, request);
    const auto &requested = std::get<std::vector<RequestedPart>>(parsed);

    // Match each requested part to an uploaded one.
    const std::vector<uploads::Part> stored = uploads::all_parts(store, upload.upload_id);
    std::vector<const uploads::Part *> chosen;
    chosen.reserve(requested.size());
    auto next = stored.begin();
    for (const RequestedPart &want : requested) {
        next = std::find_if(next, stored.end(), [&](const uploads::Part &p) { return p.number >= want.number; });
        if (next == stored.end() || next->number != want.number || unquoted(next->etag) != unquoted(want.etag)) {
            return error(invalid_part(), request);
        }
        chosen.push_back(&*next);
    }
    for (std::size_t i = 0; i + 1 < chosen.size(); ++i) {
        if (chosen[i]->size < uploads::kMinPartSize) return error(entity_too_small(), request);
    }

    std::vector<std::string> etags;
    etags.reserve(chosen.size());
    for (const uploads::Part *part : chosen) etags.push_back(part->etag);
    const auto etag = uploads::multipart_etag(etags);
    if (!etag) return error(internal_error(), request);

    // Assemble the object from the chosen parts. The handler runs on the
    // event loop, so the parts cannot change meanwhile.
    objects::StagedBlob blob(store);
    for (const uploads::Part *part : chosen) blob.copy_from(store.blob_path(part->blob_id));
    objects::Object object;
    object.bucket = upload.bucket;
    object.key = upload.key;
    object.size = blob.size();
    object.etag = *etag;
    object.last_modified_ms = clock::now_ms();
    object.headers = upload.headers;
    object.blob_id = blob.commit();
    uploads::Result result;
    try {
        result = uploads::complete(store, upload, object);
    } catch (...) {
        objects::remove_blob(store, object.blob_id);
        throw;
    }
    if (result == uploads::Result::NoSuchUpload) {
        objects::remove_blob(store, object.blob_id);
        return error(no_such_upload(), request);
    }

    xml::Writer writer;
    writer.open("CompleteMultipartUploadResult", xml::kS3Namespace)
        .element("Location", "/" + upload.bucket + "/" + listing::url_encode(upload.key))
        .element("Bucket", upload.bucket)
        .element("Key", upload.key)
        .element("ETag", object.etag);
    http::Response response = xml_response(writer.finish());
    response.set_header("x-amz-server-side-encryption", std::string(kSseAlgorithm));
    return response;
}

http::Response abort_multipart_upload(Store &store, const http::Request &request, const router::Route &route) {
    auto found = find_upload(store, route);
    if (auto *e = std::get_if<S3Error>(&found)) return error(*e, request);
    if (uploads::abort(store, std::get<uploads::Upload>(found)) == uploads::Result::NoSuchUpload) {
        return error(no_such_upload(), request);
    }
    http::Response response;
    response.status = 204;
    return response;
}

} // namespace micros3::handlers
