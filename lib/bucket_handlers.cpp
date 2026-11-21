// ListBuckets, CreateBucket, HeadBucket, GetBucketLocation, GetBucketEncryption
// and DeleteBucket.

#include "micros3/buckets.h"
#include "micros3/clock.h"
#include "micros3/digest.h"
#include "micros3/handlers.h"
#include "micros3/xml.h"

#include <pugixml.hpp>

#include <cstdint>
#include <stdexcept>
#include <string>
#include <variant>

namespace micros3::handlers {

namespace {

// ListBuckets returns at most this many buckets per page.
constexpr std::int64_t kMaxBuckets = 10000;

S3Error invalid_bucket_name() { return {400, "InvalidBucketName", "The specified bucket is not valid."}; }

S3Error invalid_location_constraint() {
    return {400, "InvalidLocationConstraint", "The specified location-constraint is not valid."};
}

// An element's name without any namespace prefix.
std::string_view local_name(const pugi::xml_node &node) {
    std::string_view name = node.name();
    const std::size_t colon = name.find(':');
    return colon == std::string_view::npos ? name : name.substr(colon + 1);
}

bool blank(std::string_view text) {
    return text.find_first_not_of(" \t\r\n") == std::string_view::npos;
}

// A region name such as "eu-west-1", or the legacy "EU".
bool valid_region(std::string_view region) {
    if (region == "EU") return true;
    if (region.empty() || region.size() > 64) return false;
    for (char c : region) {
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) return false;
    }
    return true;
}

// The LocationConstraint of a CreateBucketConfiguration body: the default
// region when the body or the constraint is empty, or an error.
std::variant<std::string, S3Error> location_constraint(std::string_view body) {
    if (blank(body)) return std::string(buckets::kDefaultRegion);
    pugi::xml_document doc;
    if (!doc.load_buffer(body.data(), body.size())) return malformed_xml();
    const pugi::xml_node root = doc.document_element();
    if (local_name(root) != "CreateBucketConfiguration") return malformed_xml();
    for (const pugi::xml_node &child : root.children()) {
        if (child.type() != pugi::node_element || local_name(child) != "LocationConstraint") continue;
        const std::string region = child.text().get();
        if (region.empty()) return std::string(buckets::kDefaultRegion);
        if (!valid_region(region)) return invalid_location_constraint();
        return region;
    }
    return std::string(buckets::kDefaultRegion);
}

http::Response error(const S3Error &e, const http::Request &request) { return http::error_response(e, request); }

} // namespace

http::Response list_buckets(Store &store, const http::Request &request, const router::Route &route) {
    const url::Query &query = route.query;
    std::int64_t limit = kMaxBuckets;
    if (auto max = query.get("max-buckets")) {
        try {
            std::size_t used = 0;
            limit = std::stoll(*max, &used);
            if (used != max->size()) throw std::invalid_argument("trailing characters");
        } catch (const std::exception &) {
            return error(invalid_argument("Provided max-buckets not an integer or within integer range"), request);
        }
        if (limit < 1 || limit > kMaxBuckets) {
            return error(invalid_argument("Argument max-buckets must be an integer between 1 and 10000"), request);
        }
    }
    std::string after;
    const std::optional<std::string> token = query.get("continuation-token");
    if (token && !token->empty()) {
        auto decoded = digest::base64_decode(*token);
        if (!decoded || decoded->empty()) {
            return error(invalid_argument("The continuation token provided is incorrect"), request);
        }
        after = std::move(*decoded);
    }
    const std::string prefix = query.get("prefix").value_or("");
    std::optional<std::string> region = query.get("bucket-region");
    if (region && region->empty()) region.reset();

    std::vector<buckets::Bucket> found =
        buckets::list(store, prefix, after, region, static_cast<std::size_t>(limit) + 1);
    const bool truncated = found.size() > static_cast<std::size_t>(limit);
    if (truncated) found.resize(static_cast<std::size_t>(limit));

    xml::Writer writer;
    writer.open("ListAllMyBucketsResult", xml::kS3Namespace).open("Buckets");
    for (const buckets::Bucket &bucket : found) {
        writer.open("Bucket")
            .element("Name", bucket.name)
            .element("CreationDate", clock::iso8601(bucket.created_ms))
            .element("BucketRegion", bucket.region)
            .close();
    }
    writer.close().open("Owner").element("DisplayName", kOwnerName).element("ID", kOwnerId).close();
    if (truncated) writer.element("ContinuationToken", digest::base64_encode(found.back().name));
    if (query.has("prefix")) writer.element("Prefix", prefix);
    return xml_response(writer.finish());
}

http::Response create_bucket(Store &store, const http::Request &request, const router::Route &route,
                             std::string_view body) {
    if (!buckets::valid_name(route.bucket)) return error(invalid_bucket_name(), request);
    auto region = location_constraint(body);
    if (auto *e = std::get_if<S3Error>(&region)) return error(*e, request);

    const auto existing = buckets::create(store, route.bucket, std::get<std::string>(region), clock::now_ms());
    // In us-east-1, S3 keeps a legacy idempotent answer to a repeat creation
    // by the owner. Elsewhere the repeat is BucketAlreadyOwnedByYou.
    if (existing && existing->region != buckets::kDefaultRegion) {
        return error({409, "BucketAlreadyOwnedByYou",
                      "Your previous request to create the named bucket succeeded and you already own it."},
                     request);
    }
    http::Response response;
    response.set_header("Location", "/" + route.bucket);
    return response;
}

http::Response head_bucket(Store &store, const http::Request &request, const router::Route &route) {
    const auto bucket = buckets::find(store, route.bucket);
    if (!bucket) return error(no_such_bucket(), request);
    http::Response response;
    response.set_header("x-amz-bucket-region", bucket->region);
    response.set_header("x-amz-access-point-alias", "false");
    return response;
}

http::Response get_bucket_location(Store &store, const http::Request &request, const router::Route &route) {
    const auto bucket = buckets::find(store, route.bucket);
    if (!bucket) return error(no_such_bucket(), request);
    // S3 reports us-east-1 as an empty constraint.
    xml::Writer writer;
    writer.open("LocationConstraint", xml::kS3Namespace);
    if (bucket->region != buckets::kDefaultRegion) writer.text(bucket->region);
    return xml_response(writer.finish());
}

http::Response get_bucket_encryption(Store &store, const http::Request &request, const router::Route &route) {
    if (!buckets::find(store, route.bucket)) return error(no_such_bucket(), request);
    // Every bucket has the SSE-S3 default, which cannot be changed.
    xml::Writer writer;
    writer.open("ServerSideEncryptionConfiguration", xml::kS3Namespace)
        .open("Rule")
        .open("ApplyServerSideEncryptionByDefault")
        .element("SSEAlgorithm", "AES256")
        .close()
        .element("BucketKeyEnabled", "false");
    return xml_response(writer.finish());
}

http::Response delete_bucket(Store &store, const http::Request &request, const router::Route &route) {
    switch (buckets::remove(store, route.bucket)) {
    case buckets::DeleteResult::NoSuchBucket: return error(no_such_bucket(), request);
    case buckets::DeleteResult::NotEmpty:
        return error({409, "BucketNotEmpty", "The bucket you tried to delete is not empty"}, request);
    case buckets::DeleteResult::Deleted: break;
    }
    http::Response response;
    response.status = 204;
    return response;
}

} // namespace micros3::handlers
