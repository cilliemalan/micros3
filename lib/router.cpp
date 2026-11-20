#include "micros3/router.h"

#include <algorithm>
#include <array>
#include <vector>

namespace micros3::router {

namespace {

// Query parameters that select an operation. At most one may appear, except
// that UploadPart takes both `uploadId` and `partNumber`.
constexpr std::array<std::string_view, 8> kSelectors = {
    "uploads", "uploadId", "partNumber", "cors", "encryption", "location", "delete", "list-type",
};

// Subresources of S3 operations that MicroS3 does not implement. A request
// carrying one of these is answered with NotImplemented, whatever its method.
constexpr std::array<std::string_view, 35> kUnsupported = {
    "acl",
    "tagging",
    "policy",
    "policyStatus",
    "versioning",
    "versions",
    "versionId",
    "lifecycle",
    "website",
    "replication",
    "logging",
    "notification",
    "object-lock",
    "retention",
    "legal-hold",
    "torrent",
    "restore",
    "select",
    "select-type",
    "attributes",
    "accelerate",
    "analytics",
    "inventory",
    "metrics",
    "intelligent-tiering",
    "ownershipControls",
    "publicAccessBlock",
    "requestPayment",
    "session",
    "renameObject",
    "metadataTable",
    "metadataConfiguration",
    "metadataInventoryTable",
    "metadataJournalTable",
    "abac",
};

template <std::size_t N>
bool contains(const std::array<std::string_view, N> &set, std::string_view name) {
    return std::find(set.begin(), set.end(), name) != set.end();
}

Operation service_operation(std::string_view method, const std::vector<std::string> &selectors) {
    if (method == "GET" && selectors.empty()) return Operation::ListBuckets;
    return Operation::Unsupported;
}

Operation bucket_operation(std::string_view method, const std::vector<std::string> &selectors,
                           const url::Query &query) {
    if (selectors.size() > 1) return Operation::Unsupported;
    const std::string selector = selectors.empty() ? std::string() : selectors.front();
    if (method == "GET") {
        if (selector.empty()) return Operation::ListObjects;
        if (selector == "list-type") {
            return query.get("list-type") == std::optional<std::string>("2") ? Operation::ListObjectsV2
                                                                             : Operation::ListObjects;
        }
        if (selector == "location") return Operation::GetBucketLocation;
        if (selector == "cors") return Operation::GetBucketCors;
        if (selector == "encryption") return Operation::GetBucketEncryption;
        if (selector == "uploads") return Operation::ListMultipartUploads;
    } else if (method == "HEAD") {
        if (selector.empty()) return Operation::HeadBucket;
    } else if (method == "PUT") {
        if (selector.empty()) return Operation::CreateBucket;
        if (selector == "cors") return Operation::PutBucketCors;
    } else if (method == "DELETE") {
        if (selector.empty()) return Operation::DeleteBucket;
        if (selector == "cors") return Operation::DeleteBucketCors;
    } else if (method == "POST") {
        if (selector == "delete") return Operation::DeleteObjects;
    }
    return Operation::Unsupported;
}

Operation object_operation(std::string_view method, const std::vector<std::string> &selectors,
                           const HeaderLookup &header) {
    const auto has = [&selectors](std::string_view name) {
        return std::find(selectors.begin(), selectors.end(), name) != selectors.end();
    };
    const bool copy = header && header("x-amz-copy-source").has_value();
    if (method == "PUT") {
        // UploadPart takes uploadId and partNumber. A missing partNumber is
        // left to the handler, which answers InvalidArgument.
        if (has("uploadId") && (selectors.size() == 1 || (selectors.size() == 2 && has("partNumber")))) {
            return copy ? Operation::Unsupported /* UploadPartCopy */ : Operation::UploadPart;
        }
        if (selectors.empty()) return copy ? Operation::CopyObject : Operation::PutObject;
        return Operation::Unsupported;
    }
    if (selectors.size() > 1) return Operation::Unsupported;
    const std::string selector = selectors.empty() ? std::string() : selectors.front();
    if (method == "GET") {
        if (selector.empty()) return Operation::GetObject;
        if (selector == "uploadId") return Operation::ListParts;
    } else if (method == "HEAD") {
        if (selector.empty()) return Operation::HeadObject;
    } else if (method == "DELETE") {
        if (selector.empty()) return Operation::DeleteObject;
        if (selector == "uploadId") return Operation::AbortMultipartUpload;
    } else if (method == "POST") {
        if (selector == "uploads") return Operation::CreateMultipartUpload;
        if (selector == "uploadId") return Operation::CompleteMultipartUpload;
    }
    return Operation::Unsupported;
}

} // namespace

std::string_view name(Operation op) {
    switch (op) {
    case Operation::ListBuckets: return "ListBuckets";
    case Operation::CreateBucket: return "CreateBucket";
    case Operation::HeadBucket: return "HeadBucket";
    case Operation::DeleteBucket: return "DeleteBucket";
    case Operation::GetBucketLocation: return "GetBucketLocation";
    case Operation::ListObjects: return "ListObjects";
    case Operation::ListObjectsV2: return "ListObjectsV2";
    case Operation::GetBucketCors: return "GetBucketCors";
    case Operation::PutBucketCors: return "PutBucketCors";
    case Operation::DeleteBucketCors: return "DeleteBucketCors";
    case Operation::GetBucketEncryption: return "GetBucketEncryption";
    case Operation::DeleteObjects: return "DeleteObjects";
    case Operation::ListMultipartUploads: return "ListMultipartUploads";
    case Operation::PutObject: return "PutObject";
    case Operation::CopyObject: return "CopyObject";
    case Operation::GetObject: return "GetObject";
    case Operation::HeadObject: return "HeadObject";
    case Operation::DeleteObject: return "DeleteObject";
    case Operation::CreateMultipartUpload: return "CreateMultipartUpload";
    case Operation::UploadPart: return "UploadPart";
    case Operation::CompleteMultipartUpload: return "CompleteMultipartUpload";
    case Operation::AbortMultipartUpload: return "AbortMultipartUpload";
    case Operation::ListParts: return "ListParts";
    case Operation::Preflight: return "Preflight";
    case Operation::Unsupported: return "Unsupported";
    case Operation::InvalidUri: return "InvalidUri";
    }
    return "Unknown";
}

Route route(std::string_view method, std::string_view raw_path, std::string_view raw_query,
            const HeaderLookup &header) {
    Route result;

    auto query = url::Query::parse(raw_query);
    if (raw_path.empty() || raw_path.front() != '/' || !query) {
        result.op = Operation::InvalidUri;
        return result;
    }
    result.query = std::move(*query);

    // Split on the raw path, so an encoded `/` (%2F) stays inside the key.
    const std::string_view rest = raw_path.substr(1);
    const std::size_t slash = rest.find('/');
    const std::string_view raw_bucket = rest.substr(0, slash);
    const std::string_view raw_key = slash == std::string_view::npos ? std::string_view() : rest.substr(slash + 1);
    auto bucket = url::decode(raw_bucket, false);
    auto key = url::decode(raw_key, false);
    if (!bucket || !key) {
        result.op = Operation::InvalidUri;
        return result;
    }
    result.bucket = std::move(*bucket);
    result.key = std::move(*key);

    if (method == "OPTIONS") {
        result.op = Operation::Preflight;
        return result;
    }

    std::vector<std::string> selectors;
    for (const auto &param : result.query.params()) {
        if (contains(kUnsupported, param.name)) {
            result.op = Operation::Unsupported;
            return result;
        }
        if (contains(kSelectors, param.name)) {
            if (std::find(selectors.begin(), selectors.end(), param.name) == selectors.end()) {
                selectors.push_back(param.name);
            }
        } else if (!param.has_value) {
            // A bare name is the form subresources take (`?tagging`). An
            // unknown one is some operation MicroS3 does not implement.
            result.op = Operation::Unsupported;
            return result;
        }
        // Other parameters with values (prefix=, max-keys=, x-id=, ...) are
        // operation arguments, read by the handlers.
    }

    if (result.bucket.empty()) {
        result.op = result.key.empty() ? service_operation(method, selectors) : Operation::InvalidUri;
    } else if (result.key.empty()) {
        result.op = bucket_operation(method, selectors, result.query);
    } else {
        result.op = object_operation(method, selectors, header);
    }
    return result;
}

std::optional<S3Error> route_error(const Route &route) {
    switch (route.op) {
    case Operation::Unsupported: return not_implemented();
    case Operation::InvalidUri: return invalid_uri();
    default: return std::nullopt;
    }
}

} // namespace micros3::router
