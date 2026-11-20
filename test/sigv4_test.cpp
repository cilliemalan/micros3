#include "micros3/service.h"
#include "micros3/sigv4.h"

#include <gtest/gtest.h>

#include <string>
#include <variant>

namespace {

using micros3::http::Request;
namespace sigv4 = micros3::sigv4;
namespace digest = micros3::digest;

constexpr const char *kEmptySha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// The credentials and request of AWS's S3 examples:
// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
const sigv4::Credentials kS3Example{"AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"};

Request s3_example(std::string method, std::string path, std::string query, std::string payload_hash) {
    Request request;
    request.method = std::move(method);
    request.path = std::move(path);
    request.query = std::move(query);
    request.headers = {{"host", "examplebucket.s3.amazonaws.com"},
                       {"x-amz-date", "20130524T000000Z"},
                       {"x-amz-content-sha256", std::move(payload_hash)}};
    return request;
}

std::string signature_of(const std::string &authorization) {
    return authorization.substr(authorization.rfind('=') + 1);
}

TEST(SigV4, DerivedSigningKeyMatchesAwsExample) {
    // From the AWS General Reference, "Examples of how to derive a signing key".
    const auto key = sigv4::signing_key("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20120215", "us-east-1", "iam");
    EXPECT_EQ(digest::hex(key), "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d");
}

TEST(SigV4, GetObjectExample) {
    Request request = s3_example("GET", "/test.txt", "", kEmptySha256);
    request.headers.emplace_back("range", "bytes=0-9");
    const std::vector<std::string> signed_headers{"host", "range", "x-amz-content-sha256", "x-amz-date"};
    const auto canonical = sigv4::canonical_request(request, signed_headers, kEmptySha256);
    ASSERT_TRUE(canonical);
    EXPECT_EQ(*canonical, std::string("GET\n/test.txt\n\n"
                                      "host:examplebucket.s3.amazonaws.com\n"
                                      "range:bytes=0-9\n"
                                      "x-amz-content-sha256:") +
                              kEmptySha256 +
                              "\n"
                              "x-amz-date:20130524T000000Z\n\n"
                              "host;range;x-amz-content-sha256;x-amz-date\n" +
                              kEmptySha256);
    const std::string to_sign =
        sigv4::string_to_sign("20130524T000000Z", "20130524/us-east-1/s3/aws4_request", *canonical);
    EXPECT_EQ(to_sign, "AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n"
                       "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972");
    const std::string authorization = sigv4::authorization_header(request, kS3Example, "us-east-1", signed_headers);
    EXPECT_EQ(authorization,
              "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
              "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
              "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");

    request.headers.emplace_back("authorization", authorization);
    const auto result = sigv4::authenticate(request, kS3Example);
    ASSERT_TRUE(std::holds_alternative<sigv4::PayloadCheck>(result));
    EXPECT_EQ(digest::hex(*std::get<sigv4::PayloadCheck>(result).expected), kEmptySha256);
}

TEST(SigV4, PutObjectExample) {
    Request request = s3_example("PUT", "/test%24file.text", "",
                                 "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
    request.headers.emplace_back("date", "Fri, 24 May 2013 00:00:00 GMT");
    request.headers.emplace_back("x-amz-storage-class", "REDUCED_REDUNDANCY");
    EXPECT_EQ(digest::hex(digest::sha256("Welcome to Amazon S3.")),
              "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
    const std::string authorization = sigv4::authorization_header(
        request, kS3Example, "us-east-1", {"date", "host", "x-amz-content-sha256", "x-amz-date", "x-amz-storage-class"});
    EXPECT_EQ(signature_of(authorization), "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
}

TEST(SigV4, GetBucketLifecycleExample) {
    const Request request = s3_example("GET", "/", "lifecycle", kEmptySha256);
    EXPECT_EQ(sigv4::canonical_query("lifecycle"), "lifecycle=");
    const std::string authorization =
        sigv4::authorization_header(request, kS3Example, "us-east-1", {"host", "x-amz-content-sha256", "x-amz-date"});
    EXPECT_EQ(signature_of(authorization), "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
}

TEST(SigV4, ListObjectsExample) {
    const Request request = s3_example("GET", "/", "max-keys=2&prefix=J", kEmptySha256);
    const std::string authorization =
        sigv4::authorization_header(request, kS3Example, "us-east-1", {"host", "x-amz-content-sha256", "x-amz-date"});
    EXPECT_EQ(signature_of(authorization), "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
}

TEST(SigV4, GetVanillaFromAwsTestSuite) {
    Request request;
    request.method = "GET";
    request.path = "/";
    request.headers = {{"host", "example.amazonaws.com"}, {"x-amz-date", "20150830T123600Z"}};
    const auto canonical = sigv4::canonical_request(request, {"host", "x-amz-date"}, kEmptySha256);
    ASSERT_TRUE(canonical);
    const std::string sig = sigv4::signature(
        sigv4::signing_key("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150830", "us-east-1", "service"),
        sigv4::string_to_sign("20150830T123600Z", "20150830/us-east-1/service/aws4_request", *canonical));
    EXPECT_EQ(sig, "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
}

TEST(SigV4, UriEncoding) {
    EXPECT_EQ(sigv4::uri_encode("aZ09-_.~ /+*%\xc3\xa9"), "aZ09-_.~%20%2F%2B%2A%25%C3%A9");
    EXPECT_EQ(sigv4::uri_encode("a/b c", true), "a/b%20c");
    EXPECT_EQ(sigv4::canonical_uri("/bucket/a%20b%2Fc!"), "/bucket/a%20b%2Fc%21");
    EXPECT_EQ(sigv4::canonical_uri("/bucket/a+b"), "/bucket/a%2Bb");
    EXPECT_EQ(sigv4::canonical_uri("/"), "/");
    EXPECT_EQ(sigv4::canonical_uri("/b/%zz"), std::nullopt);
    EXPECT_EQ(sigv4::canonical_query("prefix=a%2Fb&list-type=2&uploads&a=2&a=1"),
              "a=1&a=2&list-type=2&prefix=a%2Fb&uploads=");
    EXPECT_EQ(sigv4::canonical_query(""), "");
}

TEST(SigV4, HeaderValuesAreTrimmedAndJoined) {
    EXPECT_EQ(sigv4::canonical_header_value("  a   b\t c  "), "a b c");
    Request request;
    request.method = "GET";
    request.path = "/";
    request.headers = {{"x-a", " one "}, {"x-a", "two"}};
    EXPECT_EQ(sigv4::canonical_request(request, {"x-a"}, "h"), "GET\n/\n\nx-a:one,two\n\nx-a\nh");
    EXPECT_EQ(sigv4::canonical_request(request, {"x-b"}, "h"), std::nullopt);
}

TEST(SigV4, ParsesAuthorizationHeader) {
    const auto auth = sigv4::parse_authorization(
        "AWS4-HMAC-SHA256 Credential=AKID/20130524/eu-west-1/s3/aws4_request,SignedHeaders=host;x-amz-date,"
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    ASSERT_TRUE(auth);
    EXPECT_EQ(auth->access_key_id, "AKID");
    EXPECT_EQ(auth->date, "20130524");
    EXPECT_EQ(auth->region, "eu-west-1");
    EXPECT_EQ(auth->service, "s3");
    EXPECT_EQ(auth->signed_headers, (std::vector<std::string>{"host", "x-amz-date"}));

    for (const char *bad : {
             "AWS4-HMAC-SHA256",
             "AWS4-HMAC-SHA256 Credential=AKID/20130524/us-east-1/s3/aws4_request, SignedHeaders=host",
             "AWS4-HMAC-SHA256 Credential=AKID/2013052/us-east-1/s3/aws4_request, SignedHeaders=host, "
             "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
             "AWS4-HMAC-SHA256 Credential=AKID/20130524/us-east-1/s3/aws4_request, SignedHeaders=host, "
             "Signature=F0E8BDB87C964420E857BD35B5D6ED310BD44F0170ABA48DD91039C6036BDB41",
             "AWS4-HMAC-SHA256 Credential=AKID/20130524/us-east-1/s3/aws4_request, SignedHeaders=Host, "
             "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
             "AWS4-HMAC-SHA256 Credential=AKID/20130524/us-east-1/s3/aws4_request, SignedHeaders=host, "
             "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41, Extra=1",
         }) {
        EXPECT_FALSE(sigv4::parse_authorization(bad)) << bad;
    }
}

TEST(SigV4, ConstantTimeEqual) {
    EXPECT_TRUE(sigv4::constant_time_equal("abc", "abc"));
    EXPECT_FALSE(sigv4::constant_time_equal("abc", "abd"));
    EXPECT_FALSE(sigv4::constant_time_equal("abc", "ab"));
}

const sigv4::Credentials kTest{"test", "test"};

// A request signed with `credentials`, carrying `payload_hash`.
Request signed_request(const sigv4::Credentials &credentials = kTest, std::string payload_hash = kEmptySha256) {
    Request request;
    request.method = "PUT";
    request.path = "/bucket/some%20key";
    request.query = "partNumber=1&uploadId=abc";
    request.headers = {{"host", "localhost:3923"},
                       {"x-amz-date", "20261120T101500Z"},
                       {"x-amz-content-sha256", std::move(payload_hash)},
                       {"content-type", "text/plain"}};
    request.headers.emplace_back(
        "authorization", sigv4::authorization_header(request, credentials, "us-east-1",
                                                     {"host", "x-amz-date", "x-amz-content-sha256", "content-type"}));
    return request;
}

std::string error_code(const std::variant<sigv4::PayloadCheck, micros3::S3Error> &result) {
    if (const auto *error = std::get_if<micros3::S3Error>(&result)) return error->code;
    return "OK";
}

int error_status(const std::variant<sigv4::PayloadCheck, micros3::S3Error> &result) {
    if (const auto *error = std::get_if<micros3::S3Error>(&result)) return error->status;
    return 200;
}

void set_header(Request &request, const std::string &name, std::string value) {
    for (auto &[key, existing] : request.headers) {
        if (key == name) {
            existing = std::move(value);
            return;
        }
    }
    request.headers.emplace_back(name, std::move(value));
}

TEST(SigV4Authenticate, AcceptsValidSignature) {
    EXPECT_EQ(error_code(sigv4::authenticate(signed_request(), kTest)), "OK");
    const auto unsigned_payload = sigv4::authenticate(signed_request(kTest, "UNSIGNED-PAYLOAD"), kTest);
    ASSERT_EQ(error_code(unsigned_payload), "OK");
    EXPECT_FALSE(std::get<sigv4::PayloadCheck>(unsigned_payload).expected);
}

TEST(SigV4Authenticate, RejectsWrongSecret) {
    const auto result = sigv4::authenticate(signed_request({"test", "wrong"}), kTest);
    EXPECT_EQ(error_code(result), "SignatureDoesNotMatch");
    EXPECT_EQ(error_status(result), 403);
}

TEST(SigV4Authenticate, RejectsUnknownAccessKey) {
    const auto result = sigv4::authenticate(signed_request({"other", "test"}), kTest);
    EXPECT_EQ(error_code(result), "InvalidAccessKeyId");
    EXPECT_EQ(error_status(result), 403);
}

TEST(SigV4Authenticate, RejectsMissingSignature) {
    Request request = signed_request();
    request.headers.pop_back();
    const auto result = sigv4::authenticate(request, kTest);
    EXPECT_EQ(error_code(result), "AccessDenied");
    EXPECT_EQ(error_status(result), 403);
}

TEST(SigV4Authenticate, RejectsTampering) {
    const std::vector<std::pair<const char *, void (*)(Request &)>> tamper = {
        {"method", [](Request &r) { r.method = "POST"; }},
        {"path encoding", [](Request &r) { r.path = "/bucket/some+key"; }},
        {"path", [](Request &r) { r.path = "/bucket/other"; }},
        {"query", [](Request &r) { r.query = "partNumber=2&uploadId=abc"; }},
        {"added query parameter", [](Request &r) { r.query += "&x=1"; }},
        {"signed header", [](Request &r) { set_header(r, "content-type", "text/html"); }},
        {"date", [](Request &r) { set_header(r, "x-amz-date", "20261120T101501Z"); }},
        {"payload hash", [](Request &r) { set_header(r, "x-amz-content-sha256", "UNSIGNED-PAYLOAD"); }},
        {"repeated signed header", [](Request &r) { r.headers.emplace_back("content-type", "x"); }},
    };
    for (const auto &[label, change] : tamper) {
        Request request = signed_request();
        change(request);
        EXPECT_EQ(error_code(sigv4::authenticate(request, kTest)), "SignatureDoesNotMatch") << label;
    }
    // An unsigned header may change freely.
    Request request = signed_request();
    request.headers.emplace_back("user-agent", "anything");
    EXPECT_EQ(error_code(sigv4::authenticate(request, kTest)), "OK");
}

TEST(SigV4Authenticate, RejectsOtherProblems) {
    Request request = signed_request();
    set_header(request, "authorization", "AWS test:abcdef");
    EXPECT_EQ(error_code(sigv4::authenticate(request, kTest)), "InvalidArgument");

    request = signed_request();
    set_header(request, "authorization", "AWS4-HMAC-SHA256 Credential=test/20261120/us-east-1/s3/aws4_request");
    EXPECT_EQ(error_code(sigv4::authenticate(request, kTest)), "AuthorizationHeaderMalformed");

    request = signed_request();
    set_header(request, "x-amz-date", "2026-11-20");
    EXPECT_EQ(error_code(sigv4::authenticate(request, kTest)), "AccessDenied");

    request = signed_request();
    set_header(request, "x-amz-date", "20261121T101500Z");
    EXPECT_EQ(error_code(sigv4::authenticate(request, kTest)), "AuthorizationHeaderMalformed");

    request = signed_request(kTest, "STREAMING-AWS4-HMAC-SHA256-PAYLOAD");
    EXPECT_EQ(error_status(sigv4::authenticate(request, kTest)), 501);

    request = signed_request(kTest, "not-a-hash");
    EXPECT_EQ(error_code(sigv4::authenticate(request, kTest)), "InvalidArgument");
}

// An inner exchange that records what happened to it.
struct Recorder : micros3::http::Exchange {
    std::string *log;
    explicit Recorder(std::string *l) : log(l) {}
    void on_data(std::string_view chunk) override { *log += "data(" + std::string(chunk) + ")"; }
    micros3::http::Response on_end() override {
        *log += "end";
        return {};
    }
    void on_abort() override { *log += "abort"; }
};

TEST(PayloadHashExchange, PassesMatchingBody) {
    std::string log;
    Request request = signed_request();
    micros3::PayloadHashExchange exchange(std::make_unique<Recorder>(&log), digest::sha256("hello world"), request);
    exchange.on_data("hello ");
    exchange.on_data("world");
    EXPECT_EQ(exchange.on_end().status, 200);
    EXPECT_EQ(log, "data(hello )data(world)end");
}

TEST(PayloadHashExchange, AbortsInnerOnMismatch) {
    std::string log;
    Request request = signed_request();
    request.request_id = "REQ";
    micros3::PayloadHashExchange exchange(std::make_unique<Recorder>(&log), digest::sha256("hello world"), request);
    exchange.on_data("hello there");
    const auto response = exchange.on_end();
    EXPECT_EQ(response.status, 400);
    EXPECT_NE(response.body.find("<Code>XAmzContentSHA256Mismatch</Code>"), std::string::npos) << response.body;
    EXPECT_NE(response.body.find("<RequestId>REQ</RequestId>"), std::string::npos) << response.body;
    EXPECT_EQ(log, "data(hello there)abort");
}

} // namespace
