#include "micros3/router.h"
#include "micros3/url.h"

#include <gtest/gtest.h>

#include <map>
#include <string>

using micros3::router::Operation;
using micros3::router::Route;

namespace {

Route route(const std::string &method, const std::string &path, const std::string &query = "",
            const std::map<std::string, std::string> &headers = {}) {
    return micros3::router::route(method, path, query,
                                  [&headers](std::string_view name) -> std::optional<std::string_view> {
                                      auto it = headers.find(std::string(name));
                                      if (it == headers.end()) return std::nullopt;
                                      return std::string_view(it->second);
                                  });
}

Operation op(const std::string &method, const std::string &path, const std::string &query = "",
             const std::map<std::string, std::string> &headers = {}) {
    return route(method, path, query, headers).op;
}

} // namespace

TEST(Url, DecodesPercentEscapes) {
    EXPECT_EQ(micros3::url::decode("a%20b%2Fc", false), "a b/c");
    EXPECT_EQ(micros3::url::decode("a+b", false), "a+b");
    EXPECT_EQ(micros3::url::decode("a+b", true), "a b");
    EXPECT_EQ(micros3::url::decode("%E6%97%A5", false), "\xE6\x97\xA5");
    EXPECT_EQ(micros3::url::decode("%00%01", false), std::string("\0\1", 2));
}

TEST(Url, RejectsMalformedEscapes) {
    EXPECT_FALSE(micros3::url::decode("%", false));
    EXPECT_FALSE(micros3::url::decode("a%2", false));
    EXPECT_FALSE(micros3::url::decode("%zz", false));
}

TEST(Url, ParsesQuery) {
    auto query = micros3::url::Query::parse("uploads&prefix=a%2Fb&max-keys=2&empty=&&x=1+2");
    ASSERT_TRUE(query);
    ASSERT_EQ(query->params().size(), 5u);
    EXPECT_EQ(query->params()[0].name, "uploads");
    EXPECT_FALSE(query->params()[0].has_value);
    EXPECT_EQ(query->get("prefix"), "a/b");
    EXPECT_EQ(query->get("empty"), "");
    EXPECT_TRUE(query->params()[3].has_value);
    EXPECT_EQ(query->get("x"), "1 2");
    EXPECT_FALSE(query->get("missing"));
    EXPECT_FALSE(micros3::url::Query::parse("a=%G1"));
}

TEST(Router, SplitsBucketAndKey) {
    Route r = route("GET", "/bucket/dir/sub%20dir/file%2Bname.txt", "");
    EXPECT_EQ(r.op, Operation::GetObject);
    EXPECT_EQ(r.bucket, "bucket");
    EXPECT_EQ(r.key, "dir/sub dir/file+name.txt");

    r = route("GET", "/bucket/a%2Fb", "");
    EXPECT_EQ(r.key, "a/b");

    r = route("GET", "/bucket/dir//x/", "");
    EXPECT_EQ(r.key, "dir//x/");

    r = route("GET", "/bucket/ctl%01%0A", "");
    EXPECT_EQ(r.key, "ctl\x01\n");
}

TEST(Router, ServiceLevel) {
    EXPECT_EQ(op("GET", "/"), Operation::ListBuckets);
    EXPECT_EQ(op("GET", "/", "x-id=ListBuckets"), Operation::ListBuckets);
    EXPECT_EQ(op("PUT", "/"), Operation::Unsupported);
    EXPECT_EQ(op("GET", "/", "acl"), Operation::Unsupported);
}

TEST(Router, BucketOperations) {
    EXPECT_EQ(op("PUT", "/b"), Operation::CreateBucket);
    EXPECT_EQ(op("PUT", "/b/"), Operation::CreateBucket);
    EXPECT_EQ(op("HEAD", "/b"), Operation::HeadBucket);
    EXPECT_EQ(op("DELETE", "/b"), Operation::DeleteBucket);
    EXPECT_EQ(op("GET", "/b", "location"), Operation::GetBucketLocation);
    EXPECT_EQ(op("GET", "/b"), Operation::ListObjects);
    EXPECT_EQ(op("GET", "/b", "prefix=a&delimiter=%2F&max-keys=2"), Operation::ListObjects);
    EXPECT_EQ(op("GET", "/b", "list-type=2&prefix=a"), Operation::ListObjectsV2);
    EXPECT_EQ(op("GET", "/b", "cors"), Operation::GetBucketCors);
    EXPECT_EQ(op("PUT", "/b", "cors"), Operation::PutBucketCors);
    EXPECT_EQ(op("DELETE", "/b", "cors"), Operation::DeleteBucketCors);
    EXPECT_EQ(op("GET", "/b", "encryption"), Operation::GetBucketEncryption);
    EXPECT_EQ(op("POST", "/b", "delete"), Operation::DeleteObjects);
    EXPECT_EQ(op("POST", "/b", "delete="), Operation::DeleteObjects);
    EXPECT_EQ(op("GET", "/b", "uploads&max-uploads=2"), Operation::ListMultipartUploads);
}

TEST(Router, ObjectOperations) {
    EXPECT_EQ(op("PUT", "/b/k"), Operation::PutObject);
    EXPECT_EQ(op("PUT", "/b/k", "x-id=PutObject"), Operation::PutObject);
    EXPECT_EQ(op("PUT", "/b/k", "", {{"x-amz-copy-source", "/src/key"}}), Operation::CopyObject);
    EXPECT_EQ(op("GET", "/b/k"), Operation::GetObject);
    EXPECT_EQ(op("GET", "/b/k", "response-content-type=text%2Fplain"), Operation::GetObject);
    EXPECT_EQ(op("HEAD", "/b/k"), Operation::HeadObject);
    EXPECT_EQ(op("DELETE", "/b/k"), Operation::DeleteObject);
    EXPECT_EQ(op("POST", "/b/k", "uploads"), Operation::CreateMultipartUpload);
    EXPECT_EQ(op("PUT", "/b/k", "partNumber=1&uploadId=abc"), Operation::UploadPart);
    EXPECT_EQ(op("PUT", "/b/k", "uploadId=abc"), Operation::UploadPart);
    EXPECT_EQ(op("POST", "/b/k", "uploadId=abc"), Operation::CompleteMultipartUpload);
    EXPECT_EQ(op("DELETE", "/b/k", "uploadId=abc"), Operation::AbortMultipartUpload);
    EXPECT_EQ(op("GET", "/b/k", "uploadId=abc&max-parts=2&part-number-marker=1"), Operation::ListParts);
}

TEST(Router, PreflightOnAnyPath) {
    EXPECT_EQ(op("OPTIONS", "/b"), Operation::Preflight);
    EXPECT_EQ(op("OPTIONS", "/b/k"), Operation::Preflight);
    EXPECT_EQ(op("OPTIONS", "/b/k", "uploads"), Operation::Preflight);
}

TEST(Router, UnsupportedSubresourcesNeverReachObjectOperations) {
    for (const char *sub : {"tagging", "acl", "policy", "versioning", "versions", "lifecycle", "website",
                            "retention", "legal-hold", "torrent", "restore", "attributes", "select"}) {
        for (const char *method : {"GET", "PUT", "DELETE", "POST", "HEAD"}) {
            EXPECT_EQ(op(method, "/b/k", sub), Operation::Unsupported) << method << " ?" << sub;
            EXPECT_EQ(op(method, "/b", sub), Operation::Unsupported) << method << " ?" << sub;
        }
    }
    // With a value, and mixed with supported parameters.
    EXPECT_EQ(op("GET", "/b/k", "versionId=null"), Operation::Unsupported);
    EXPECT_EQ(op("PUT", "/b/k", "tagging=&x-id=PutObjectTagging"), Operation::Unsupported);
    EXPECT_EQ(op("GET", "/b", "list-type=2&acl"), Operation::Unsupported);
    // An unknown bare subresource.
    EXPECT_EQ(op("GET", "/b/k", "somethingnew"), Operation::Unsupported);
    EXPECT_EQ(op("PUT", "/b/k", "somethingnew"), Operation::Unsupported);
}

TEST(Router, OutOfScopeOperations) {
    EXPECT_EQ(op("PUT", "/b", "encryption"), Operation::Unsupported);   // PutBucketEncryption
    EXPECT_EQ(op("DELETE", "/b", "encryption"), Operation::Unsupported);
    EXPECT_EQ(op("PUT", "/b/k", "partNumber=1&uploadId=abc", {{"x-amz-copy-source", "/s/k"}}),
              Operation::Unsupported); // UploadPartCopy
    EXPECT_EQ(op("GET", "/b/k", "partNumber=1"), Operation::Unsupported);
    EXPECT_EQ(op("POST", "/b/k"), Operation::Unsupported);
    EXPECT_EQ(op("POST", "/b"), Operation::Unsupported);
    EXPECT_EQ(op("PATCH", "/b/k"), Operation::Unsupported);
    EXPECT_EQ(op("GET", "/b", "cors&location"), Operation::Unsupported);
    EXPECT_EQ(op("GET", "/b/k", "cors"), Operation::Unsupported);
    EXPECT_EQ(op("POST", "/b/k", "delete"), Operation::Unsupported);
}

TEST(Router, InvalidUris) {
    EXPECT_EQ(op("GET", "/b/%zz"), Operation::InvalidUri);
    EXPECT_EQ(op("GET", "/b/k", "prefix=%"), Operation::InvalidUri);
    EXPECT_EQ(op("GET", "//k"), Operation::InvalidUri);
    EXPECT_EQ(op("GET", "b/k"), Operation::InvalidUri);
}

TEST(Router, RouteErrors) {
    auto error = micros3::router::route_error(route("GET", "/b/k", "tagging"));
    ASSERT_TRUE(error);
    EXPECT_EQ(error->status, 501);
    EXPECT_EQ(error->code, "NotImplemented");

    error = micros3::router::route_error(route("GET", "/b/%"));
    ASSERT_TRUE(error);
    EXPECT_EQ(error->status, 400);
    EXPECT_EQ(error->code, "InvalidURI");

    EXPECT_FALSE(micros3::router::route_error(route("GET", "/b/k")));
}
