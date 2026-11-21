// ListObjects (v1) and ListObjectsV2.

#include "micros3/clock.h"
#include "micros3/digest.h"
#include "micros3/handlers.h"
#include "micros3/listing.h"
#include "micros3/xml.h"

#include <algorithm>
#include <stdexcept>
#include <string>

namespace micros3::handlers {

namespace {

std::optional<S3Error> parse_max_keys(const url::Query &query, std::size_t &out) {
    const auto value = query.get("max-keys");
    if (!value) return std::nullopt;
    long long parsed = 0;
    try {
        std::size_t used = 0;
        parsed = std::stoll(*value, &used);
        if (used != value->size()) throw std::invalid_argument("trailing characters");
    } catch (const std::exception &) {
        return invalid_argument("Provided max-keys not an integer or within integer range");
    }
    if (parsed < 0) return invalid_argument("Argument maxKeys must be an integer between 0 and 2147483647");
    out = static_cast<std::size_t>(std::min<long long>(parsed, listing::kMaxKeys));
    return std::nullopt;
}

http::Response list(Store &store, const http::Request &request, const router::Route &route, bool v2) {
    const url::Query &query = route.query;
    listing::Request params;
    params.prefix = query.get("prefix").value_or("");
    params.delimiter = query.get("delimiter").value_or("");
    if (auto e = parse_max_keys(query, params.max_keys)) return http::error_response(*e, request);
    // MaxKeys echoes the request, even above the page limit.
    const std::string max_keys_text = query.get("max-keys").value_or(std::to_string(listing::kMaxKeys));

    bool url_encoding = false;
    if (auto encoding = query.get("encoding-type")) {
        if (*encoding != "url") {
            return http::error_response(invalid_argument("Invalid Encoding Method specified in Request"), request);
        }
        url_encoding = true;
    }
    const auto encode = [&](std::string_view value) {
        return url_encoding ? listing::url_encode(value) : std::string(value);
    };

    std::optional<std::string> marker, start_after, token;
    if (v2) {
        start_after = query.get("start-after");
        token = query.get("continuation-token");
        if (token) {
            auto decoded = digest::base64_decode(*token);
            if (!decoded || decoded->empty()) {
                return http::error_response(invalid_argument("The continuation token provided is incorrect"), request);
            }
            params.after = std::move(*decoded);
        } else if (start_after) {
            params.after = *start_after;
        }
    } else {
        marker = query.get("marker");
        if (marker) params.after = *marker;
    }

    const auto page = listing::list(store, route.bucket, params);
    if (!page) return http::error_response(no_such_bucket(), request);
    const bool fetch_owner = !v2 || query.get("fetch-owner") == std::optional<std::string>("true");

    xml::Writer writer;
    writer.open("ListBucketResult", xml::kS3Namespace);
    writer.element("Name", route.bucket).element("Prefix", encode(params.prefix));
    if (v2) {
        if (token) writer.element("ContinuationToken", *token);
        if (start_after) writer.element("StartAfter", encode(*start_after));
        writer.element("KeyCount", std::to_string(page->entries.size()));
    } else {
        writer.element("Marker", encode(marker.value_or("")));
    }
    writer.element("MaxKeys", max_keys_text);
    if (!params.delimiter.empty()) writer.element("Delimiter", encode(params.delimiter));
    if (url_encoding) writer.element("EncodingType", "url");
    writer.element("IsTruncated", page->truncated ? "true" : "false");
    if (page->truncated) {
        const std::string &last = page->entries.back().key;
        if (v2) {
            writer.element("NextContinuationToken", digest::base64_encode(last));
        } else if (!params.delimiter.empty()) {
            // S3 returns NextMarker only with a delimiter; otherwise the
            // client uses the last key.
            writer.element("NextMarker", encode(last));
        }
    }
    for (const listing::Entry &entry : page->entries) {
        if (entry.is_prefix) continue;
        writer.open("Contents")
            .element("Key", encode(entry.key))
            .element("LastModified", clock::iso8601(entry.last_modified_ms))
            .element("ETag", entry.etag)
            .element("Size", std::to_string(entry.size));
        if (fetch_owner) writer.open("Owner").element("ID", kOwnerId).element("DisplayName", kOwnerName).close();
        writer.element("StorageClass", "STANDARD").close();
    }
    for (const listing::Entry &entry : page->entries) {
        if (entry.is_prefix) writer.open("CommonPrefixes").element("Prefix", encode(entry.key)).close();
    }
    return xml_response(writer.finish());
}

} // namespace

http::Response list_objects(Store &store, const http::Request &request, const router::Route &route) {
    return list(store, request, route, false);
}

http::Response list_objects_v2(Store &store, const http::Request &request, const router::Route &route) {
    return list(store, request, route, true);
}

} // namespace micros3::handlers
