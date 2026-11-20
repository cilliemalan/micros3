#pragma once

// Path-style request routing (design.md, "Request path", step 2).
//
// The first path segment is the bucket and the rest is the key, each
// percent-decoded. The operation is selected from the method, the presence of
// a bucket and key, and the subresource in the query string. Unsupported
// subresources and out-of-scope operations route to `Unsupported`, never to
// an object operation.

#include "micros3/s3error.h"
#include "micros3/url.h"

#include <functional>
#include <optional>
#include <string>
#include <string_view>

namespace micros3::router {

enum class Operation {
    // Service
    ListBuckets,
    // Bucket
    CreateBucket,
    HeadBucket,
    DeleteBucket,
    GetBucketLocation,
    ListObjects,
    ListObjectsV2,
    GetBucketCors,
    PutBucketCors,
    DeleteBucketCors,
    GetBucketEncryption,
    DeleteObjects,
    ListMultipartUploads,
    // Object
    PutObject,
    CopyObject,
    GetObject,
    HeadObject,
    DeleteObject,
    CreateMultipartUpload,
    UploadPart,
    CompleteMultipartUpload,
    AbortMultipartUpload,
    ListParts,
    // CORS preflight, on any path
    Preflight,
    // Out of scope: 501 NotImplemented
    Unsupported,
    // The path or query could not be decoded: 400 InvalidURI
    InvalidUri,
};

// The operation's name, as AWS documents it (for example "ListObjectsV2").
std::string_view name(Operation op);

struct Route {
    Operation op = Operation::Unsupported;
    std::string bucket; // decoded; empty for service-level requests
    std::string key;    // decoded raw bytes; empty for bucket-level requests
    url::Query query;
};

// Looks up a request header by lowercase name. Returns nullopt when absent.
using HeaderLookup = std::function<std::optional<std::string_view>(std::string_view)>;

// Routes a request. `method` is upper case (GET, PUT, ...), `raw_path` is the
// still-encoded path starting with `/`, and `raw_query` is the still-encoded
// query string without the `?`.
Route route(std::string_view method, std::string_view raw_path, std::string_view raw_query,
            const HeaderLookup &header);

// The error a route answers with when it cannot be served: NotImplemented for
// `Unsupported`, InvalidURI for `InvalidUri`, and nullopt otherwise.
std::optional<S3Error> route_error(const Route &route);

} // namespace micros3::router
