#include "micros3/server.h"
#include "micros3/service.h"
#include "micros3/sigv4.h"
#include "micros3/store.h"

#include "temp_dir.h"

#include <gtest/gtest.h>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <future>
#include <memory>
#include <optional>
#include <filesystem>
#include <random>
#include <regex>
#include <tuple>
#include <string>
#include <thread>

namespace {

// Records how the body arrived and echoes it in the response.
class RecordingService : public micros3::http::Service {
public:
    std::atomic<int> chunks_before_end{0};

    std::unique_ptr<micros3::http::Exchange> begin(const micros3::http::Request &request) override {
        return std::make_unique<Recorder>(*this, request);
    }

private:
    class Recorder : public micros3::http::Exchange {
    public:
        Recorder(RecordingService &service, const micros3::http::Request &request)
            : service_(service), request_(request) {}
        void on_data(std::string_view chunk) override {
            ++chunks_;
            bytes_ += chunk.size();
            checksum_ = checksum_ * 31 + std::hash<std::string_view>{}(chunk);
        }
        micros3::http::Response on_end() override {
            service_.chunks_before_end = chunks_;
            micros3::http::Response response;
            if (auto status = request_.header("x-test-status")) response.status = std::stoi(std::string(*status));
            if (auto length = request_.header("x-test-length")) {
                response.reported_length = std::stoull(std::string(*length));
            }
            response.set_header("x-test-bytes", std::to_string(bytes_));
            response.set_header("x-test-method", request_.method);
            response.set_header("x-test-path", request_.path);
            response.set_header("x-test-query", request_.query);
            response.set_header("x-test-request-id", request_.request_id);
            response.body = "bytes=" + std::to_string(bytes_);
            return response;
        }

    private:
        RecordingService &service_;
        micros3::http::Request request_;
        int chunks_ = 0;
        std::size_t bytes_ = 0;
        std::size_t checksum_ = 0;
    };
};

class RunningServer {
public:
    explicit RunningServer(micros3::http::Service &service) : server_(service) {
        std::promise<int> bound;
        auto future = bound.get_future();
        thread_ = std::thread([this, &bound] { server_.run(0, [&bound](int port) { bound.set_value(port); }); });
        port_ = future.get();
    }
    ~RunningServer() {
        server_.stop();
        thread_.join();
    }
    int port() const { return port_; }

private:
    micros3::Server server_;
    std::thread thread_;
    int port_ = 0;
};

// Sends `request` on a fresh connection and reads until the server closes it.
std::string exchange(int port, const std::string &request) {
    const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    EXPECT_GE(fd, 0);
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<std::uint16_t>(port));
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    EXPECT_EQ(::connect(fd, reinterpret_cast<sockaddr *>(&address), sizeof address), 0);
    std::size_t sent = 0;
    while (sent < request.size()) {
        const ssize_t n = ::send(fd, request.data() + sent, request.size() - sent, MSG_NOSIGNAL);
        if (n <= 0) break;
        sent += static_cast<std::size_t>(n);
    }
    std::string response;
    char buffer[65536];
    for (;;) {
        const ssize_t n = ::recv(fd, buffer, sizeof buffer, 0);
        if (n <= 0) break;
        response.append(buffer, static_cast<std::size_t>(n));
    }
    ::close(fd);
    return response;
}

std::string head_of(const std::string &response) { return response.substr(0, response.find("\r\n\r\n") + 4); }
std::string body_of(const std::string &response) { return response.substr(response.find("\r\n\r\n") + 4); }

std::string header_value(const std::string &response, const std::string &name) {
    std::smatch match;
    const std::string head = head_of(response);
    if (std::regex_search(head, match, std::regex("\r\n" + name + ": ([^\r]*)\r\n", std::regex::icase))) {
        return match[1];
    }
    return "<missing>";
}

} // namespace

TEST(Server, StreamsLargeBodiesInChunks) {
    RecordingService service;
    RunningServer server(service);
    const std::string body(4 * 1024 * 1024, 'x');
    const std::string response = exchange(server.port(), "PUT /b/k HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n"
                                                          "Content-Length: " +
                                                              std::to_string(body.size()) + "\r\n\r\n" + body);
    EXPECT_EQ(response.rfind("HTTP/1.1 200 OK\r\n", 0), 0u) << head_of(response);
    EXPECT_EQ(header_value(response, "x-test-bytes"), std::to_string(body.size()));
    EXPECT_EQ(body_of(response), "bytes=" + std::to_string(body.size()));
    EXPECT_GT(service.chunks_before_end.load(), 1);
}

TEST(Server, AcceptsChunkedBodies) {
    RecordingService service;
    RunningServer server(service);
    const std::string response =
        exchange(server.port(), "PUT /b/k HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n"
                                "Transfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n");
    EXPECT_EQ(header_value(response, "x-test-bytes"), "11");
}

TEST(Server, PassesMethodPathAndQueryRaw) {
    RecordingService service;
    RunningServer server(service);
    const std::string response = exchange(
        server.port(), "get /b/a%20b?prefix=x%2Fy&list-type=2 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    EXPECT_EQ(header_value(response, "x-test-method"), "GET");
    EXPECT_EQ(header_value(response, "x-test-path"), "/b/a%20b");
    EXPECT_EQ(header_value(response, "x-test-query"), "prefix=x%2Fy&list-type=2");
    EXPECT_EQ(header_value(response, "x-test-bytes"), "0");
}

TEST(Server, SetsRequestIdHeader) {
    RecordingService service;
    RunningServer server(service);
    const std::string response = exchange(server.port(), "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    const std::string id = header_value(response, "x-amz-request-id");
    EXPECT_TRUE(std::regex_match(id, std::regex("[0-9A-F]{16}"))) << id;
    EXPECT_EQ(header_value(response, "x-test-request-id"), id);
}

TEST(Server, HeadHasNoBodyButReportsLength) {
    RecordingService service;
    RunningServer server(service);
    const std::string response = exchange(
        server.port(), "HEAD /b/k HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nx-test-length: 1234\r\n\r\n");
    EXPECT_EQ(response.rfind("HTTP/1.1 200 OK\r\n", 0), 0u) << response;
    EXPECT_EQ(header_value(response, "Content-Length"), "1234");
    EXPECT_EQ(body_of(response), "");
}

TEST(Server, NoBodyFor204And304) {
    RecordingService service;
    RunningServer server(service);
    for (const char *status : {"204", "304"}) {
        const std::string response = exchange(
            server.port(), std::string("GET /b/k HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nx-test-status: ") +
                               status + "\r\n\r\n");
        EXPECT_EQ(response.rfind(std::string("HTTP/1.1 ") + status, 0), 0u) << response;
        EXPECT_EQ(body_of(response), "") << status;
        EXPECT_EQ(header_value(response, "Content-Length"), "<missing>") << status;
    }
}

TEST(Server, KeepAliveServesSeveralRequests) {
    RecordingService service;
    RunningServer server(service);
    const std::string response = exchange(server.port(),
                                          "PUT /b/1 HTTP/1.1\r\nHost: localhost\r\nContent-Length: 3\r\n\r\nabc"
                                          "PUT /b/2 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n"
                                          "Content-Length: 2\r\n\r\nde");
    EXPECT_NE(response.find("bytes=3"), std::string::npos) << response;
    EXPECT_NE(response.find("bytes=2"), std::string::npos) << response;
}

const micros3::sigv4::Credentials kCredentials{"test", "test"};

// An S3Service over a store in a fresh temporary directory.
struct TestService {
    micros3::test::TempDir dir;
    micros3::Store store{dir.path()};
    micros3::S3Service service{store, kCredentials};
};

// A raw HTTP/1.1 request, signed with `credentials` when they are given.
std::string s3_request(const std::string &method, const std::string &target, const std::string &body = "",
                       const std::optional<micros3::sigv4::Credentials> &credentials = kCredentials,
                       std::optional<std::string> payload_hash = std::nullopt,
                       const micros3::http::Headers &extra = {}) {
    micros3::http::Request request;
    request.method = method;
    const std::size_t question = target.find('?');
    request.path = target.substr(0, question);
    request.query = question == std::string::npos ? "" : target.substr(question + 1);
    request.headers = {{"host", "localhost"},
                       {"x-amz-date", "20261120T101500Z"},
                       {"x-amz-content-sha256",
                        payload_hash.value_or(micros3::digest::hex(micros3::digest::sha256(body)))}};
    std::vector<std::string> signed_headers = {"host", "x-amz-content-sha256", "x-amz-date"};
    for (const auto &[name, value] : extra) {
        request.headers.emplace_back(name, value);
        signed_headers.push_back(name);
    }
    if (credentials) {
        request.headers.emplace_back(
            "authorization", micros3::sigv4::authorization_header(request, *credentials, "us-east-1", signed_headers));
    }
    std::string text = method + " " + target + " HTTP/1.1\r\n";
    for (const auto &[name, value] : request.headers) text += name + ": " + value + "\r\n";
    text += "Connection: close\r\n";
    if (!body.empty() || method == "PUT" || method == "POST") {
        text += "Content-Length: " + std::to_string(body.size()) + "\r\n";
    }
    return text + "\r\n" + body;
}

TEST(S3Service, UnsupportedSubresourceIsNotImplementedXml) {
    TestService s3;
    RunningServer server(s3.service);
    const std::string response = exchange(server.port(), s3_request("PUT", "/bucket/key?tagging", "hello"));
    EXPECT_EQ(response.rfind("HTTP/1.1 501 Not Implemented\r\n", 0), 0u) << response;
    EXPECT_EQ(header_value(response, "Content-Type"), "application/xml");
    const std::string id = header_value(response, "x-amz-request-id");
    const std::string body = body_of(response);
    EXPECT_NE(body.find("<Code>NotImplemented</Code>"), std::string::npos) << body;
    EXPECT_NE(body.find("<Resource>/bucket/key</Resource>"), std::string::npos) << body;
    EXPECT_NE(body.find("<RequestId>" + id + "</RequestId>"), std::string::npos) << body;
}

TEST(S3Service, HeadErrorHasNoBody) {
    TestService s3;
    RunningServer server(s3.service);
    const std::string response = exchange(server.port(), s3_request("HEAD", "/bucket/key?acl"));
    EXPECT_EQ(response.rfind("HTTP/1.1 501 Not Implemented\r\n", 0), 0u) << response;
    EXPECT_EQ(body_of(response), "");
}

TEST(S3Service, InvalidUriIsBadRequest) {
    TestService s3;
    RunningServer server(s3.service);
    const std::string response =
        exchange(server.port(), "GET /bucket/%zz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    EXPECT_EQ(response.rfind("HTTP/1.1 400 Bad Request\r\n", 0), 0u) << response;
    EXPECT_NE(body_of(response).find("<Code>InvalidURI</Code>"), std::string::npos);
}

TEST(S3Service, UnsignedRequestIsAccessDenied) {
    TestService s3;
    RunningServer server(s3.service);
    for (const char *target : {"/", "/bucket", "/bucket/key?tagging"}) {
        const std::string response = exchange(server.port(), s3_request("GET", target, "", std::nullopt));
        EXPECT_EQ(response.rfind("HTTP/1.1 403 Forbidden\r\n", 0), 0u) << response;
        EXPECT_NE(body_of(response).find("<Code>AccessDenied</Code>"), std::string::npos) << response;
    }
}

TEST(S3Service, WrongSecretIsSignatureDoesNotMatch) {
    TestService s3;
    RunningServer server(s3.service);
    const std::string response =
        exchange(server.port(), s3_request("GET", "/", "", micros3::sigv4::Credentials{"test", "wrong"}));
    EXPECT_EQ(response.rfind("HTTP/1.1 403 Forbidden\r\n", 0), 0u) << response;
    EXPECT_NE(body_of(response).find("<Code>SignatureDoesNotMatch</Code>"), std::string::npos) << response;
}

TEST(S3Service, SignedRequestPassesAuthentication) {
    TestService s3;
    RunningServer server(s3.service);
    const std::string response = exchange(server.port(), s3_request("GET", "/"));
    EXPECT_EQ(response.rfind("HTTP/1.1 200 OK\r\n", 0), 0u) << response;
}

TEST(S3Service, PreflightNeedsNoSignature) {
    TestService s3;
    RunningServer server(s3.service);
    const std::string response = exchange(server.port(), "OPTIONS /bucket/key HTTP/1.1\r\nHost: localhost\r\n"
                                                         "Origin: https://example.com\r\n"
                                                         "Access-Control-Request-Method: GET\r\n"
                                                         "Connection: close\r\n\r\n");
    EXPECT_EQ(response.find("AccessDenied"), std::string::npos) << response;
    EXPECT_EQ(response.rfind("HTTP/1.1 403", 0), std::string::npos) << response;
}

TEST(S3Service, BodyNotMatchingPayloadHashIsRejected) {
    TestService s3;
    RunningServer server(s3.service);
    const std::string hash = micros3::digest::hex(micros3::digest::sha256("original body"));
    const std::string response =
        exchange(server.port(), s3_request("PUT", "/bucket/key", "altered body!", kCredentials, hash));
    EXPECT_EQ(response.rfind("HTTP/1.1 400 Bad Request\r\n", 0), 0u) << response;
    EXPECT_NE(body_of(response).find("<Code>XAmzContentSHA256Mismatch</Code>"), std::string::npos) << response;
}

// Bucket operations, end to end over HTTP.

namespace {

bool status_is(const std::string &response, const std::string &status) {
    return response.rfind("HTTP/1.1 " + status, 0) == 0;
}

bool has(const std::string &text, const std::string &part) { return text.find(part) != std::string::npos; }

const std::string kEuConfig =
    "<CreateBucketConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">"
    "<LocationConstraint>eu-west-1</LocationConstraint></CreateBucketConfiguration>";

} // namespace

TEST(Buckets, ListIsEmptyAtFirst) {
    TestService s3;
    RunningServer server(s3.service);
    const std::string response = exchange(server.port(), s3_request("GET", "/"));
    ASSERT_TRUE(status_is(response, "200")) << response;
    EXPECT_EQ(header_value(response, "Content-Type"), "application/xml");
    const std::string body = body_of(response);
    EXPECT_TRUE(has(body, "<ListAllMyBucketsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">")) << body;
    EXPECT_TRUE(has(body, "<Buckets></Buckets>")) << body;
    EXPECT_TRUE(has(body, "<Owner><DisplayName>")) << body;
    EXPECT_FALSE(has(body, "<ContinuationToken>")) << body;
}

TEST(Buckets, CreateHeadLocationListDelete) {
    TestService s3;
    RunningServer server(s3.service);

    std::string response = exchange(server.port(), s3_request("PUT", "/my-bucket"));
    ASSERT_TRUE(status_is(response, "200")) << response;
    EXPECT_EQ(header_value(response, "Location"), "/my-bucket");

    response = exchange(server.port(), s3_request("HEAD", "/my-bucket"));
    EXPECT_TRUE(status_is(response, "200")) << response;
    EXPECT_EQ(header_value(response, "x-amz-bucket-region"), "us-east-1");

    response = exchange(server.port(), s3_request("GET", "/my-bucket?location"));
    EXPECT_TRUE(status_is(response, "200")) << response;
    EXPECT_TRUE(has(body_of(response),
                    "<LocationConstraint xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"></LocationConstraint>"))
        << response;

    response = exchange(server.port(), s3_request("GET", "/"));
    const std::string body = body_of(response);
    EXPECT_TRUE(std::regex_search(body, std::regex("<Bucket><Name>my-bucket</Name><CreationDate>"
                                                   "\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z</CreationDate>"
                                                   "<BucketRegion>us-east-1</BucketRegion></Bucket>")))
        << body;

    response = exchange(server.port(), s3_request("DELETE", "/my-bucket"));
    EXPECT_TRUE(status_is(response, "204")) << response;
    EXPECT_EQ(body_of(response), "");

    response = exchange(server.port(), s3_request("HEAD", "/my-bucket"));
    EXPECT_TRUE(status_is(response, "404")) << response;
    EXPECT_EQ(body_of(response), "");
}

TEST(Buckets, MissingBucketErrors) {
    TestService s3;
    RunningServer server(s3.service);
    for (const auto &[method, target] : std::vector<std::pair<std::string, std::string>>{
             {"GET", "/missing-bucket?location"}, {"DELETE", "/missing-bucket"}}) {
        const std::string response = exchange(server.port(), s3_request(method, target));
        EXPECT_TRUE(status_is(response, "404")) << response;
        EXPECT_TRUE(has(body_of(response), "<Code>NoSuchBucket</Code>")) << response;
    }
}

TEST(Buckets, InvalidNameIsRejected) {
    TestService s3;
    RunningServer server(s3.service);
    const std::string response = exchange(server.port(), s3_request("PUT", "/micros3_verify_x"));
    EXPECT_TRUE(status_is(response, "400")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>InvalidBucketName</Code>")) << response;
    EXPECT_TRUE(has(body_of(exchange(server.port(), s3_request("GET", "/"))), "<Buckets></Buckets>"));
}

TEST(Buckets, RepeatCreateInUsEast1Succeeds) {
    TestService s3;
    RunningServer server(s3.service);
    EXPECT_TRUE(status_is(exchange(server.port(), s3_request("PUT", "/repeat-bucket")), "200"));
    EXPECT_TRUE(status_is(exchange(server.port(), s3_request("PUT", "/repeat-bucket")), "200"));
}

TEST(Buckets, RegionalBucketRepeatIsAlreadyOwned) {
    TestService s3;
    RunningServer server(s3.service);
    ASSERT_TRUE(status_is(exchange(server.port(), s3_request("PUT", "/eu-bucket", kEuConfig)), "200"));

    std::string response = exchange(server.port(), s3_request("PUT", "/eu-bucket", kEuConfig));
    EXPECT_TRUE(status_is(response, "409")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>BucketAlreadyOwnedByYou</Code>")) << response;

    response = exchange(server.port(), s3_request("GET", "/eu-bucket?location"));
    EXPECT_TRUE(has(body_of(response), ">eu-west-1</LocationConstraint>")) << response;
    response = exchange(server.port(), s3_request("HEAD", "/eu-bucket"));
    EXPECT_EQ(header_value(response, "x-amz-bucket-region"), "eu-west-1");
}

TEST(Buckets, BadCreateConfiguration) {
    TestService s3;
    RunningServer server(s3.service);
    std::string response = exchange(server.port(), s3_request("PUT", "/bad-config", "<CreateBucketConfiguration>"));
    EXPECT_TRUE(status_is(response, "400")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>MalformedXML</Code>")) << response;

    response = exchange(server.port(),
                        s3_request("PUT", "/bad-config",
                                   "<CreateBucketConfiguration><LocationConstraint>Mars 1</LocationConstraint>"
                                   "</CreateBucketConfiguration>"));
    EXPECT_TRUE(status_is(response, "400")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>InvalidLocationConstraint</Code>")) << response;
}

TEST(Buckets, DeleteRefusesBucketWithObjects) {
    TestService s3;
    RunningServer server(s3.service);
    ASSERT_TRUE(status_is(exchange(server.port(), s3_request("PUT", "/full-bucket")), "200"));
    s3.store.db().exec("INSERT INTO objects VALUES ('full-bucket', 'k', 'b', 1, 'e', 0, '{}')");
    const std::string response = exchange(server.port(), s3_request("DELETE", "/full-bucket"));
    EXPECT_TRUE(status_is(response, "409")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>BucketNotEmpty</Code>")) << response;
    EXPECT_TRUE(status_is(exchange(server.port(), s3_request("HEAD", "/full-bucket")), "200"));
}

TEST(Buckets, ListPaginatesWithContinuationToken) {
    TestService s3;
    RunningServer server(s3.service);
    for (const char *name : {"/page-a", "/page-b", "/page-c", "/other"}) {
        ASSERT_TRUE(status_is(exchange(server.port(), s3_request("PUT", name)), "200"));
    }
    std::string body = body_of(exchange(server.port(), s3_request("GET", "/?max-buckets=2&prefix=page-")));
    EXPECT_TRUE(has(body, "<Name>page-a</Name>")) << body;
    EXPECT_TRUE(has(body, "<Name>page-b</Name>")) << body;
    EXPECT_FALSE(has(body, "<Name>page-c</Name>")) << body;
    EXPECT_TRUE(has(body, "<Prefix>page-</Prefix>")) << body;
    std::smatch match;
    ASSERT_TRUE(std::regex_search(body, match, std::regex("<ContinuationToken>([^<]*)</ContinuationToken>"))) << body;
    std::string token;
    for (char c : match[1].str()) {
        token += c == '+' ? "%2B" : c == '/' ? "%2F" : c == '=' ? "%3D" : std::string(1, c);
    }

    body = body_of(
        exchange(server.port(), s3_request("GET", "/?continuation-token=" + token + "&max-buckets=2&prefix=page-")));
    EXPECT_TRUE(has(body, "<Name>page-c</Name>")) << body;
    EXPECT_FALSE(has(body, "<Name>page-a</Name>")) << body;
    EXPECT_FALSE(has(body, "<ContinuationToken>")) << body;

    const std::string response = exchange(server.port(), s3_request("GET", "/?max-buckets=0"));
    EXPECT_TRUE(status_is(response, "400")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>InvalidArgument</Code>")) << response;
}

// Object operations, end to end over HTTP.

namespace {

std::string md5_base64(const std::string &body) {
    return micros3::digest::base64_encode(micros3::digest::md5(body));
}

std::string quoted_md5(const std::string &body) {
    return "\"" + micros3::digest::hex(micros3::digest::md5(body)) + "\"";
}

// A TestService with a running server and a bucket called `objects`.
struct ObjectServer {
    TestService s3;
    RunningServer server{s3.service};
    ObjectServer() { EXPECT_TRUE(status_is(send("PUT", "/objects"), "200")); }

    std::string send(const std::string &method, const std::string &target, const std::string &body = "",
                     const micros3::http::Headers &extra = {}) {
        return exchange(server.port(), s3_request(method, target, body, kCredentials, std::nullopt, extra));
    }
};

} // namespace

TEST(ObjectApi, PutGetHeadDelete) {
    ObjectServer s;
    const std::string body("\0\1\x7F\x80\xFE\xFF", 6);
    std::string response = s.send("PUT", "/objects/nested/%E9%9B%AA%20%2B%26%25.bin", body,
                                  {{"content-type", "application/octet-stream"},
                                   {"cache-control", "max-age=123"},
                                   {"x-amz-meta-purpose", "test"}});
    ASSERT_TRUE(status_is(response, "200")) << response;
    EXPECT_EQ(header_value(response, "ETag"), quoted_md5(body));
    EXPECT_EQ(header_value(response, "x-amz-server-side-encryption"), "AES256");

    response = s.send("GET", "/objects/nested/%E9%9B%AA%20%2B%26%25.bin");
    ASSERT_TRUE(status_is(response, "200")) << response;
    EXPECT_EQ(body_of(response), body);
    EXPECT_EQ(header_value(response, "Content-Length"), "6");
    EXPECT_EQ(header_value(response, "ETag"), quoted_md5(body));
    EXPECT_EQ(header_value(response, "Content-Type"), "application/octet-stream");
    EXPECT_EQ(header_value(response, "Cache-Control"), "max-age=123");
    EXPECT_EQ(header_value(response, "x-amz-meta-purpose"), "test");
    EXPECT_EQ(header_value(response, "x-amz-server-side-encryption"), "AES256");
    EXPECT_TRUE(std::regex_match(header_value(response, "Last-Modified"),
                                 std::regex("\\w{3}, \\d\\d \\w{3} \\d{4} \\d\\d:\\d\\d:\\d\\d GMT")));

    response = s.send("HEAD", "/objects/nested/%E9%9B%AA%20%2B%26%25.bin");
    ASSERT_TRUE(status_is(response, "200")) << response;
    EXPECT_EQ(header_value(response, "Content-Length"), "6");
    EXPECT_EQ(body_of(response), "");

    // An overwrite replaces the content and the metadata, and the old blob.
    response = s.send("PUT", "/objects/nested/%E9%9B%AA%20%2B%26%25.bin", "new", {{"x-amz-meta-other", "x"}});
    ASSERT_TRUE(status_is(response, "200")) << response;
    response = s.send("GET", "/objects/nested/%E9%9B%AA%20%2B%26%25.bin");
    EXPECT_EQ(body_of(response), "new");
    EXPECT_EQ(header_value(response, "Content-Type"), "binary/octet-stream");
    EXPECT_EQ(header_value(response, "Cache-Control"), "<missing>");
    EXPECT_EQ(header_value(response, "x-amz-meta-purpose"), "<missing>");
    EXPECT_EQ(header_value(response, "x-amz-meta-other"), "x");
    EXPECT_EQ(std::distance(std::filesystem::directory_iterator(s.s3.store.blobs_dir()), {}), 1);

    response = s.send("DELETE", "/objects/nested/%E9%9B%AA%20%2B%26%25.bin");
    EXPECT_TRUE(status_is(response, "204")) << response;
    EXPECT_TRUE(std::filesystem::is_empty(s.s3.store.blobs_dir()));
    response = s.send("GET", "/objects/nested/%E9%9B%AA%20%2B%26%25.bin");
    EXPECT_TRUE(status_is(response, "404")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>NoSuchKey</Code>")) << response;
    response = s.send("HEAD", "/objects/nested/%E9%9B%AA%20%2B%26%25.bin");
    EXPECT_TRUE(status_is(response, "404")) << response;
    EXPECT_EQ(body_of(response), "");
    // Deleting a missing key succeeds.
    EXPECT_TRUE(status_is(s.send("DELETE", "/objects/nested/%E9%9B%AA%20%2B%26%25.bin"), "204"));
}

TEST(ObjectApi, EmptyObject) {
    ObjectServer s;
    std::string response = s.send("PUT", "/objects/empty", "");
    ASSERT_TRUE(status_is(response, "200")) << response;
    EXPECT_EQ(header_value(response, "ETag"), "\"d41d8cd98f00b204e9800998ecf8427e\"");
    response = s.send("GET", "/objects/empty");
    ASSERT_TRUE(status_is(response, "200")) << response;
    EXPECT_EQ(header_value(response, "Content-Length"), "0");
    EXPECT_EQ(body_of(response), "");
    response = s.send("HEAD", "/objects/empty");
    EXPECT_EQ(header_value(response, "Content-Length"), "0");
}

TEST(ObjectApi, MissingBucket) {
    ObjectServer s;
    for (const auto &[method, target] : std::vector<std::pair<std::string, std::string>>{
             {"PUT", "/missing/k"}, {"GET", "/missing/k"}, {"DELETE", "/missing/k"}}) {
        const std::string response = s.send(method, target, method == "PUT" ? "data" : "");
        EXPECT_TRUE(status_is(response, "404")) << response;
        EXPECT_TRUE(has(body_of(response), "<Code>NoSuchBucket</Code>")) << response;
    }
    EXPECT_TRUE(status_is(s.send("HEAD", "/missing/k"), "404"));
}

TEST(ObjectApi, ContentMd5) {
    ObjectServer s;
    std::string response = s.send("PUT", "/objects/k", "body", {{"content-md5", md5_base64("body")}});
    EXPECT_TRUE(status_is(response, "200")) << response;

    response = s.send("PUT", "/objects/k", "changed", {{"content-md5", md5_base64("other")}});
    EXPECT_TRUE(status_is(response, "400")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>BadDigest</Code>")) << response;

    response = s.send("PUT", "/objects/k", "changed", {{"content-md5", "bm90LWEtZGlnZXN0"}});
    EXPECT_TRUE(status_is(response, "400")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>InvalidDigest</Code>")) << response;

    // Neither rejected upload changed the object or left a file behind.
    EXPECT_EQ(body_of(s.send("GET", "/objects/k")), "body");
    EXPECT_TRUE(std::filesystem::is_empty(s.s3.store.staging_dir()));
    EXPECT_EQ(std::distance(std::filesystem::directory_iterator(s.s3.store.blobs_dir()), {}), 1);
}

TEST(ObjectApi, Checksums) {
    ObjectServer s;
    const std::string body = "checksum content";
    const auto crc = [](const std::string &text) {
        const std::uint32_t value = micros3::digest::crc32(text);
        const unsigned char bytes[4] = {static_cast<unsigned char>(value >> 24), static_cast<unsigned char>(value >> 16),
                                        static_cast<unsigned char>(value >> 8), static_cast<unsigned char>(value)};
        return micros3::digest::base64_encode(bytes, 4);
    };
    const auto sha = [](const std::string &text) {
        return micros3::digest::base64_encode(micros3::digest::sha256(text));
    };

    std::string response = s.send("PUT", "/objects/crc", body, {{"x-amz-checksum-crc32", crc(body)}});
    ASSERT_TRUE(status_is(response, "200")) << response;
    EXPECT_EQ(header_value(response, "x-amz-checksum-crc32"), crc(body));
    response = s.send("PUT", "/objects/sha", body, {{"x-amz-checksum-sha256", sha(body)}});
    ASSERT_TRUE(status_is(response, "200")) << response;
    EXPECT_EQ(header_value(response, "x-amz-checksum-sha256"), sha(body));

    response = s.send("PUT", "/objects/bad-crc", body, {{"x-amz-checksum-crc32", crc("other")}});
    EXPECT_TRUE(status_is(response, "400")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>BadDigest</Code>")) << response;
    response = s.send("PUT", "/objects/sha", "replacement", {{"x-amz-checksum-sha256", sha("other")}});
    EXPECT_TRUE(status_is(response, "400")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>BadDigest</Code>")) << response;
    response = s.send("PUT", "/objects/bad-crc", body, {{"x-amz-checksum-crc32", "AAAA"}});
    EXPECT_TRUE(status_is(response, "400")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>InvalidRequest</Code>")) << response;

    EXPECT_TRUE(status_is(s.send("GET", "/objects/bad-crc"), "404"));
    EXPECT_EQ(body_of(s.send("GET", "/objects/sha")), body);
    EXPECT_TRUE(std::filesystem::is_empty(s.s3.store.staging_dir()));
}

TEST(ObjectApi, PayloadHashMismatchStoresNothing) {
    ObjectServer s;
    const std::string hash = micros3::digest::hex(micros3::digest::sha256("original body"));
    const std::string response =
        exchange(s.server.port(), s3_request("PUT", "/objects/k", "altered body!", kCredentials, hash));
    EXPECT_TRUE(has(body_of(response), "<Code>XAmzContentSHA256Mismatch</Code>")) << response;
    EXPECT_TRUE(status_is(s.send("GET", "/objects/k"), "404"));
    EXPECT_TRUE(std::filesystem::is_empty(s.s3.store.staging_dir()));
    EXPECT_TRUE(std::filesystem::is_empty(s.s3.store.blobs_dir()));
}

TEST(ObjectApi, Ranges) {
    ObjectServer s;
    ASSERT_TRUE(status_is(s.send("PUT", "/objects/r", "0123456"), "200"));
    for (const auto &[range, content, content_range] : std::vector<std::tuple<std::string, std::string, std::string>>{
             {"bytes=1-3", "123", "bytes 1-3/7"}, {"bytes=4-", "456", "bytes 4-6/7"}, {"bytes=-2", "56", "bytes 5-6/7"}}) {
        std::string response = s.send("GET", "/objects/r", "", {{"range", range}});
        EXPECT_TRUE(status_is(response, "206")) << response;
        EXPECT_EQ(body_of(response), content) << range;
        EXPECT_EQ(header_value(response, "Content-Range"), content_range);
        response = s.send("HEAD", "/objects/r", "", {{"range", range}});
        EXPECT_TRUE(status_is(response, "206")) << response;
        EXPECT_EQ(header_value(response, "Content-Length"), std::to_string(content.size()));
        EXPECT_EQ(body_of(response), "");
    }
    std::string response = s.send("GET", "/objects/r", "", {{"range", "bytes=100-200"}});
    EXPECT_TRUE(status_is(response, "416")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>InvalidRange</Code>")) << response;
    EXPECT_EQ(header_value(response, "Content-Range"), "bytes */7");
    EXPECT_TRUE(status_is(s.send("HEAD", "/objects/r", "", {{"range", "bytes=100-200"}}), "416"));

    // Several ranges are ignored.
    response = s.send("GET", "/objects/r", "", {{"range", "bytes=0-1,3-4"}});
    EXPECT_TRUE(status_is(response, "200")) << response;
    EXPECT_EQ(body_of(response), "0123456");
}

TEST(ObjectApi, Conditions) {
    ObjectServer s;
    ASSERT_TRUE(status_is(s.send("PUT", "/objects/c", "content"), "200"));
    const std::string etag = quoted_md5("content");
    EXPECT_TRUE(status_is(s.send("GET", "/objects/c", "", {{"if-match", etag}}), "200"));
    std::string response = s.send("GET", "/objects/c", "", {{"if-match", "\"other\""}});
    EXPECT_TRUE(status_is(response, "412")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>PreconditionFailed</Code>")) << response;
    response = s.send("GET", "/objects/c", "", {{"if-none-match", etag}});
    EXPECT_TRUE(status_is(response, "304")) << response;
    EXPECT_EQ(body_of(response), "");
    EXPECT_EQ(header_value(response, "ETag"), etag);
    EXPECT_TRUE(status_is(s.send("HEAD", "/objects/c", "", {{"if-none-match", etag}}), "304"));
    EXPECT_TRUE(status_is(s.send("GET", "/objects/c", "", {{"if-modified-since", "Thu, 01 Jan 1970 00:00:00 GMT"}}),
                          "200"));
    EXPECT_TRUE(status_is(s.send("GET", "/objects/c", "", {{"if-unmodified-since", "Thu, 01 Jan 1970 00:00:00 GMT"}}),
                          "412"));
}

TEST(ObjectApi, ConditionalWriteIsNotImplemented) {
    ObjectServer s;
    const std::string response = s.send("PUT", "/objects/c", "content", {{"if-none-match", "*"}});
    EXPECT_TRUE(status_is(response, "501")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>NotImplemented</Code>")) << response;
    EXPECT_TRUE(status_is(s.send("GET", "/objects/c"), "404"));
}

TEST(ObjectApi, KeyTooLong) {
    ObjectServer s;
    const std::string response = s.send("PUT", "/objects/" + std::string(1025, 'k'), "x");
    EXPECT_TRUE(status_is(response, "400")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>KeyTooLongError</Code>")) << response;
}

TEST(ObjectApi, LargeObjectStreamsBothWays) {
    ObjectServer s;
    std::string body(24 * 1024 * 1024, '\0');
    std::mt19937 engine(42);
    for (char &c : body) c = static_cast<char>(engine());
    std::string response = s.send("PUT", "/objects/large", body);
    ASSERT_TRUE(status_is(response, "200")) << head_of(response);
    EXPECT_EQ(header_value(response, "ETag"), quoted_md5(body));
    response = s.send("GET", "/objects/large");
    ASSERT_TRUE(status_is(response, "200")) << head_of(response);
    EXPECT_EQ(header_value(response, "Content-Length"), std::to_string(body.size()));
    EXPECT_TRUE(body_of(response) == body);
    response = s.send("GET", "/objects/large", "", {{"range", "bytes=1000000-"}});
    EXPECT_TRUE(status_is(response, "206")) << head_of(response);
    EXPECT_TRUE(body_of(response) == body.substr(1000000));
}

// GetBucketEncryption and object listings.

TEST(BucketApi, GetBucketEncryption) {
    ObjectServer s;
    std::string response = s.send("GET", "/objects?encryption");
    ASSERT_TRUE(status_is(response, "200")) << response;
    EXPECT_TRUE(has(body_of(response), "<ServerSideEncryptionConfiguration xmlns=\"http://s3.amazonaws.com/doc/"
                                       "2006-03-01/\"><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>"
                                       "AES256</SSEAlgorithm></ApplyServerSideEncryptionByDefault>"))
        << response;
    EXPECT_FALSE(has(body_of(response), "KMSMasterKeyID")) << response;

    response = s.send("GET", "/missing-bucket?encryption");
    EXPECT_TRUE(status_is(response, "404")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>NoSuchBucket</Code>")) << response;

    response = s.send("PUT", "/objects?encryption", "<ServerSideEncryptionConfiguration/>");
    EXPECT_TRUE(status_is(response, "501")) << response;
}

TEST(ListApi, MissingAndEmptyBucket) {
    ObjectServer s;
    for (const char *target : {"/missing-bucket", "/missing-bucket?list-type=2"}) {
        const std::string response = s.send("GET", target);
        EXPECT_TRUE(status_is(response, "404")) << response;
        EXPECT_TRUE(has(body_of(response), "<Code>NoSuchBucket</Code>")) << response;
    }
    std::string response = s.send("GET", "/objects");
    ASSERT_TRUE(status_is(response, "200")) << response;
    EXPECT_TRUE(has(body_of(response), "<ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">"
                                       "<Name>objects</Name><Prefix></Prefix><Marker></Marker>"
                                       "<MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>"))
        << response;
    response = s.send("GET", "/objects?list-type=2");
    ASSERT_TRUE(status_is(response, "200")) << response;
    EXPECT_TRUE(has(body_of(response), "<KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys>")) << response;
}

TEST(ListApi, V1PagesWithDelimiterAndNextMarker) {
    ObjectServer s;
    for (const char *key : {"a/1", "a/b/2", "a/c/3", "z"}) ASSERT_TRUE(status_is(s.send("PUT", std::string("/objects/") + key, "x"), "200"));

    std::string body = body_of(s.send("GET", "/objects?max-keys=2"));
    EXPECT_TRUE(has(body, "<IsTruncated>true</IsTruncated>")) << body;
    EXPECT_FALSE(has(body, "<NextMarker>")) << body;
    EXPECT_TRUE(has(body, "<Contents><Key>a/1</Key><LastModified>")) << body;
    EXPECT_TRUE(has(body, "<ETag>&quot;9dd4e461268c8034f5c8564e155c67a6&quot;</ETag><Size>1</Size>")) << body;
    EXPECT_TRUE(has(body, "<Owner><ID>")) << body;

    body = body_of(s.send("GET", "/objects?prefix=a%2F&delimiter=%2F&max-keys=2"));
    EXPECT_TRUE(has(body, "<Prefix>a/</Prefix>")) << body;
    EXPECT_TRUE(has(body, "<Delimiter>/</Delimiter>")) << body;
    EXPECT_TRUE(has(body, "<NextMarker>a/b/</NextMarker>")) << body;
    EXPECT_TRUE(has(body, "<CommonPrefixes><Prefix>a/b/</Prefix></CommonPrefixes>")) << body;

    body = body_of(s.send("GET", "/objects?prefix=a%2F&delimiter=%2F&max-keys=2&marker=a%2Fb%2F"));
    EXPECT_TRUE(has(body, "<Marker>a/b/</Marker>")) << body;
    EXPECT_TRUE(has(body, "<IsTruncated>false</IsTruncated>")) << body;
    EXPECT_TRUE(has(body, "<CommonPrefixes><Prefix>a/c/</Prefix></CommonPrefixes>")) << body;
    EXPECT_FALSE(has(body, "<Contents>")) << body;
}

TEST(ListApi, V2ContinuationToken) {
    ObjectServer s;
    for (const char *key : {"a", "b", "c"}) ASSERT_TRUE(status_is(s.send("PUT", std::string("/objects/") + key, "x"), "200"));
    std::string body = body_of(s.send("GET", "/objects?list-type=2&max-keys=2"));
    EXPECT_TRUE(has(body, "<KeyCount>2</KeyCount>")) << body;
    EXPECT_TRUE(has(body, "<IsTruncated>true</IsTruncated>")) << body;
    const std::string token = micros3::digest::base64_encode("b");
    EXPECT_TRUE(has(body, "<NextContinuationToken>" + token + "</NextContinuationToken>")) << body;
    EXPECT_FALSE(has(body, "<Owner>")) << body;

    body = body_of(s.send("GET", "/objects?list-type=2&max-keys=2&continuation-token=" + token));
    EXPECT_TRUE(has(body, "<ContinuationToken>" + token + "</ContinuationToken>")) << body;
    EXPECT_TRUE(has(body, "<Key>c</Key>")) << body;
    EXPECT_FALSE(has(body, "<NextContinuationToken>")) << body;

    body = body_of(s.send("GET", "/objects?list-type=2&start-after=a&fetch-owner=true"));
    EXPECT_TRUE(has(body, "<StartAfter>a</StartAfter>")) << body;
    EXPECT_TRUE(has(body, "<KeyCount>2</KeyCount>")) << body;
    EXPECT_TRUE(has(body, "<Owner>")) << body;

    std::string response = s.send("GET", "/objects?list-type=2&continuation-token=%21%21");
    EXPECT_TRUE(status_is(response, "400")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>InvalidArgument</Code>")) << response;
    response = s.send("GET", "/objects?max-keys=-1");
    EXPECT_TRUE(status_is(response, "400")) << response;
    response = s.send("GET", "/objects?encoding-type=base64");
    EXPECT_TRUE(status_is(response, "400")) << response;
}

TEST(ListApi, UrlEncodingAndXmlEscaping) {
    ObjectServer s;
    // "ctl/a\x01 b&c" and "x<y>"
    ASSERT_TRUE(status_is(s.send("PUT", "/objects/ctl/a%01%20b%26c", "x"), "200"));
    ASSERT_TRUE(status_is(s.send("PUT", "/objects/x%3Cy%3E%09", "x"), "200"));

    std::string body = body_of(s.send("GET", "/objects?encoding-type=url&prefix=ctl%2Fa%01&delimiter=%20"));
    EXPECT_TRUE(has(body, "<Prefix>ctl/a%01</Prefix>")) << body;
    EXPECT_TRUE(has(body, "<Delimiter>+</Delimiter>")) << body;
    EXPECT_TRUE(has(body, "<EncodingType>url</EncodingType>")) << body;
    EXPECT_TRUE(has(body, "<CommonPrefixes><Prefix>ctl/a%01+</Prefix></CommonPrefixes>")) << body;

    body = body_of(s.send("GET", "/objects?list-type=2&encoding-type=url"));
    EXPECT_TRUE(has(body, "<Key>ctl/a%01+b%26c</Key>")) << body;
    EXPECT_TRUE(has(body, "<Key>x%3Cy%3E%09</Key>")) << body;

    body = body_of(s.send("GET", "/objects?prefix=x"));
    EXPECT_TRUE(has(body, "<Key>x&lt;y&gt;&#x9;</Key>")) << body;
}

// DeleteObjects and CopyObject.

namespace {

std::string delete_body(const std::vector<std::string> &keys, std::optional<bool> quiet = std::nullopt) {
    std::string body = "<Delete xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">";
    if (quiet) body += *quiet ? "<Quiet>true</Quiet>" : "<Quiet>false</Quiet>";
    for (const auto &key : keys) body += "<Object><Key>" + key + "</Key></Object>";
    return body + "</Delete>";
}

std::size_t count(const std::string &text, const std::string &needle) {
    std::size_t n = 0;
    for (std::size_t at = text.find(needle); at != std::string::npos; at = text.find(needle, at + 1)) ++n;
    return n;
}

} // namespace

TEST(DeleteObjectsApi, VerboseQuietAndMissingKeys) {
    ObjectServer s;
    ASSERT_TRUE(status_is(s.send("PUT", "/objects/a%20%26b", "one"), "200"));
    ASSERT_TRUE(status_is(s.send("PUT", "/objects/empty", ""), "200"));
    ASSERT_TRUE(status_is(s.send("PUT", "/objects/keep", "keep"), "200"));

    std::string body = delete_body({"a &amp;b", "empty", "absent"});
    std::string response = s.send("POST", "/objects?delete", body, {{"content-md5", md5_base64(body)}});
    ASSERT_TRUE(status_is(response, "200")) << response;
    EXPECT_TRUE(has(body_of(response), "<Deleted><Key>a &amp;b</Key></Deleted>")) << response;
    EXPECT_TRUE(has(body_of(response), "<Deleted><Key>empty</Key></Deleted>")) << response;
    EXPECT_TRUE(has(body_of(response), "<Deleted><Key>absent</Key></Deleted>")) << response;
    EXPECT_FALSE(has(body_of(response), "<Error>")) << response;
    EXPECT_TRUE(status_is(s.send("GET", "/objects/a%20%26b"), "404"));
    EXPECT_TRUE(status_is(s.send("GET", "/objects/empty"), "404"));
    EXPECT_EQ(body_of(s.send("GET", "/objects/keep")), "keep");
    EXPECT_EQ(std::distance(std::filesystem::directory_iterator(s.s3.store.blobs_dir()), {}), 1);

    ASSERT_TRUE(status_is(s.send("PUT", "/objects/empty", ""), "200"));
    body = delete_body({"empty", "absent"}, true);
    response = s.send("POST", "/objects?delete", body, {{"content-md5", md5_base64(body)}});
    ASSERT_TRUE(status_is(response, "200")) << response;
    EXPECT_FALSE(has(body_of(response), "<Deleted>")) << response;
    EXPECT_TRUE(status_is(s.send("GET", "/objects/empty"), "404"));
}

TEST(DeleteObjectsApi, KeyLimit) {
    ObjectServer s;
    ASSERT_TRUE(status_is(s.send("PUT", "/objects/existing", "x"), "200"));
    std::vector<std::string> keys = {"existing"};
    for (int i = 0; i < 999; ++i) keys.push_back("absent-" + std::to_string(i));

    std::vector<std::string> over = keys;
    over.push_back("extra");
    std::string response = s.send("POST", "/objects?delete", delete_body(over));
    EXPECT_TRUE(status_is(response, "400")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>MalformedXML</Code>")) << response;
    EXPECT_EQ(body_of(s.send("GET", "/objects/existing")), "x");

    response = s.send("POST", "/objects?delete", delete_body(keys));
    ASSERT_TRUE(status_is(response, "200")) << response;
    EXPECT_EQ(count(body_of(response), "<Deleted>"), 1000u);
    EXPECT_TRUE(status_is(s.send("GET", "/objects/existing"), "404"));
}

TEST(DeleteObjectsApi, Errors) {
    ObjectServer s;
    std::string response = s.send("POST", "/missing?delete", delete_body({"k"}));
    EXPECT_TRUE(status_is(response, "404")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>NoSuchBucket</Code>")) << response;

    for (const std::string body : {"", "<Delete/>", "<Other><Object><Key>k</Key></Object></Other>",
                                   "<Delete><Object><VersionId>v</VersionId></Object></Delete>", "<Delete>"}) {
        response = s.send("POST", "/objects?delete", body);
        EXPECT_TRUE(status_is(response, "400")) << body << "\n" << response;
        EXPECT_TRUE(has(body_of(response), "<Code>MalformedXML</Code>")) << body << "\n" << response;
    }

    ASSERT_TRUE(status_is(s.send("PUT", "/objects/k", "x"), "200"));
    const std::string body = delete_body({"k"});
    response = s.send("POST", "/objects?delete", body, {{"content-md5", md5_base64("other")}});
    EXPECT_TRUE(status_is(response, "400")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>BadDigest</Code>")) << response;
    EXPECT_EQ(body_of(s.send("GET", "/objects/k")), "x");

    // Only the null version exists.
    response = s.send("POST", "/objects?delete",
                      "<Delete><Object><Key>k</Key><VersionId>abc</VersionId></Object></Delete>");
    ASSERT_TRUE(status_is(response, "200")) << response;
    EXPECT_TRUE(has(body_of(response), "<Error><Key>k</Key><VersionId>abc</VersionId><Code>NoSuchVersion</Code>"))
        << response;
    EXPECT_EQ(body_of(s.send("GET", "/objects/k")), "x");
}

TEST(CopyObjectApi, CopyAndReplaceMetadata) {
    ObjectServer s;
    ASSERT_TRUE(status_is(s.send("PUT", "/dest"), "200"));
    const std::string body("\0\1\x7F\x80\xFE\xFF", 6);
    const std::string source = "/objects/nested/%E9%9B%AA%20%2B%26%25%3F%23.bin";
    ASSERT_TRUE(status_is(s.send("PUT", source, body,
                                 {{"content-type", "application/octet-stream"},
                                  {"cache-control", "max-age=123"},
                                  {"x-amz-meta-purpose", "copy"}}),
                          "200"));
    ASSERT_TRUE(status_is(s.send("PUT", "/dest/copy", "old", {{"x-amz-meta-stale", "yes"}}), "200"));

    // COPY keeps the source metadata; the copy source may start with a slash.
    std::string response = s.send("PUT", "/dest/copy", "", {{"x-amz-copy-source", source}});
    ASSERT_TRUE(status_is(response, "200")) << response;
    EXPECT_TRUE(has(body_of(response), "<ETag>&quot;" + quoted_md5(body).substr(1, 32) + "&quot;</ETag>")) << response;
    EXPECT_TRUE(std::regex_search(body_of(response),
                                  std::regex("<LastModified>\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z</LastModified>")))
        << response;
    EXPECT_EQ(header_value(response, "x-amz-server-side-encryption"), "AES256");
    response = s.send("GET", "/dest/copy");
    EXPECT_EQ(body_of(response), body);
    EXPECT_EQ(header_value(response, "ETag"), quoted_md5(body));
    EXPECT_EQ(header_value(response, "Content-Type"), "application/octet-stream");
    EXPECT_EQ(header_value(response, "Cache-Control"), "max-age=123");
    EXPECT_EQ(header_value(response, "x-amz-meta-purpose"), "copy");
    EXPECT_EQ(header_value(response, "x-amz-meta-stale"), "<missing>");

    // REPLACE keeps only the metadata the request supplies.
    response = s.send("PUT", "/dest/copy", "",
                      {{"x-amz-copy-source", source.substr(1)},
                       {"x-amz-metadata-directive", "REPLACE"},
                       {"content-type", "text/plain"},
                       {"x-amz-meta-revision", "two"}});
    ASSERT_TRUE(status_is(response, "200")) << response;
    response = s.send("GET", "/dest/copy");
    EXPECT_EQ(body_of(response), body);
    EXPECT_EQ(header_value(response, "Content-Type"), "text/plain");
    EXPECT_EQ(header_value(response, "Cache-Control"), "<missing>");
    EXPECT_EQ(header_value(response, "x-amz-meta-purpose"), "<missing>");
    EXPECT_EQ(header_value(response, "x-amz-meta-revision"), "two");

    // A self-copy needs REPLACE.
    response = s.send("PUT", "/dest/copy", "", {{"x-amz-copy-source", "dest/copy"}});
    EXPECT_TRUE(status_is(response, "400")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>InvalidRequest</Code>")) << response;
    response = s.send("PUT", "/dest/copy", "",
                      {{"x-amz-copy-source", "dest/copy"}, {"x-amz-metadata-directive", "REPLACE"},
                       {"cache-control", "no-cache"}});
    ASSERT_TRUE(status_is(response, "200")) << response;
    response = s.send("GET", "/dest/copy");
    EXPECT_EQ(body_of(response), body);
    EXPECT_EQ(header_value(response, "Cache-Control"), "no-cache");
    EXPECT_EQ(header_value(response, "Content-Type"), "binary/octet-stream");

    // Each copy owns its blob: overwriting or deleting the source leaves it.
    ASSERT_TRUE(status_is(s.send("PUT", source, "new source"), "200"));
    EXPECT_TRUE(status_is(s.send("DELETE", source), "204"));
    EXPECT_EQ(body_of(s.send("GET", "/dest/copy")), body);
    EXPECT_EQ(std::distance(std::filesystem::directory_iterator(s.s3.store.blobs_dir()), {}), 1);
    EXPECT_TRUE(std::filesystem::is_empty(s.s3.store.staging_dir()));
}

TEST(CopyObjectApi, EmptyObjectAndMissingSources) {
    ObjectServer s;
    ASSERT_TRUE(status_is(s.send("PUT", "/objects/empty", ""), "200"));
    std::string response = s.send("PUT", "/objects/empty-copy", "", {{"x-amz-copy-source", "objects/empty"}});
    ASSERT_TRUE(status_is(response, "200")) << response;
    response = s.send("GET", "/objects/empty-copy");
    EXPECT_EQ(header_value(response, "Content-Length"), "0");
    EXPECT_EQ(header_value(response, "ETag"), "\"d41d8cd98f00b204e9800998ecf8427e\"");

    response = s.send("PUT", "/objects/d", "", {{"x-amz-copy-source", "objects/absent"}});
    EXPECT_TRUE(status_is(response, "404")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>NoSuchKey</Code>")) << response;
    response = s.send("PUT", "/objects/d", "", {{"x-amz-copy-source", "missing/empty"}});
    EXPECT_TRUE(status_is(response, "404")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>NoSuchBucket</Code>")) << response;
    response = s.send("PUT", "/missing/d", "", {{"x-amz-copy-source", "objects/empty"}});
    EXPECT_TRUE(status_is(response, "404")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>NoSuchBucket</Code>")) << response;
    response = s.send("PUT", "/objects/d", "", {{"x-amz-copy-source", "objects"}});
    EXPECT_TRUE(status_is(response, "400")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>InvalidArgument</Code>")) << response;
    response = s.send("PUT", "/objects/d", "",
                      {{"x-amz-copy-source", "objects/empty"}, {"x-amz-metadata-directive", "MERGE"}});
    EXPECT_TRUE(status_is(response, "400")) << response;
    EXPECT_TRUE(status_is(s.send("GET", "/objects/d"), "404"));
}

TEST(CopyObjectApi, SourceConditions) {
    ObjectServer s;
    ASSERT_TRUE(status_is(s.send("PUT", "/objects/src", "source"), "200"));
    const std::string etag = quoted_md5("source");
    const std::string last_modified = header_value(s.send("HEAD", "/objects/src"), "Last-Modified");
    const std::string before = "Mon, 01 Jan 2024 00:00:00 GMT";
    const std::vector<std::pair<micros3::http::Headers, std::string>> cases = {
        {{{"x-amz-copy-source-if-modified-since", before}}, "200"},
        {{{"x-amz-copy-source-if-modified-since", last_modified}}, "412"},
        {{{"x-amz-copy-source-if-unmodified-since", last_modified}}, "200"},
        {{{"x-amz-copy-source-if-unmodified-since", before}}, "412"},
        {{{"x-amz-copy-source-if-match", etag}, {"x-amz-copy-source-if-unmodified-since", before}}, "200"},
        {{{"x-amz-copy-source-if-match", "\"other\""}, {"x-amz-copy-source-if-unmodified-since", last_modified}},
         "412"},
        {{{"x-amz-copy-source-if-none-match", etag}, {"x-amz-copy-source-if-modified-since", before}}, "412"},
        {{{"x-amz-copy-source-if-none-match", "\"other\""}}, "200"},
    };
    for (const auto &[conditions, expected] : cases) {
        ASSERT_TRUE(status_is(s.send("PUT", "/objects/dest", "sentinel"), "200"));
        micros3::http::Headers headers = {{"x-amz-copy-source", "objects/src"}};
        headers.insert(headers.end(), conditions.begin(), conditions.end());
        const std::string response = s.send("PUT", "/objects/dest", "", headers);
        EXPECT_TRUE(status_is(response, expected)) << conditions.front().first << "\n" << response;
        EXPECT_EQ(body_of(s.send("GET", "/objects/dest")), expected == "200" ? "source" : "sentinel");
        if (expected == "412") EXPECT_TRUE(has(body_of(response), "<Code>PreconditionFailed</Code>")) << response;
    }
}

namespace {

const std::string kCorsRules =
    "<CORSConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">"
    "<CORSRule><ID>read</ID><AllowedOrigin>https://app.example.com</AllowedOrigin>"
    "<AllowedMethod>GET</AllowedMethod><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule>"
    "<CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>PUT</AllowedMethod></CORSRule>"
    "</CORSConfiguration>";

} // namespace

TEST(CorsApi, PutGetDelete) {
    ObjectServer s;
    std::string response = s.send("GET", "/objects?cors");
    EXPECT_TRUE(status_is(response, "404")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>NoSuchCORSConfiguration</Code>")) << response;

    response = s.send("PUT", "/objects?cors", kCorsRules, {{"content-md5", md5_base64(kCorsRules)}});
    ASSERT_TRUE(status_is(response, "200")) << response;
    response = s.send("GET", "/objects?cors");
    ASSERT_TRUE(status_is(response, "200")) << response;
    EXPECT_EQ(header_value(response, "Content-Type"), "application/xml");
    EXPECT_TRUE(has(body_of(response),
                    "<CORSConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><CORSRule><ID>read</ID>"
                    "<AllowedMethod>GET</AllowedMethod><AllowedOrigin>https://app.example.com</AllowedOrigin>"
                    "<MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule><CORSRule><AllowedMethod>PUT</AllowedMethod>"
                    "<AllowedOrigin>*</AllowedOrigin></CORSRule></CORSConfiguration>"))
        << response;

    // Other buckets are unaffected.
    ASSERT_TRUE(status_is(s.send("PUT", "/second"), "200"));
    EXPECT_TRUE(status_is(s.send("GET", "/second?cors"), "404"));

    response = s.send("DELETE", "/objects?cors");
    EXPECT_TRUE(status_is(response, "204")) << response;
    EXPECT_TRUE(status_is(s.send("GET", "/objects?cors"), "404"));
    EXPECT_TRUE(status_is(s.send("DELETE", "/objects?cors"), "204"));
}

TEST(CorsApi, Errors) {
    ObjectServer s;
    for (const auto &[method, body] : std::vector<std::pair<std::string, std::string>>{
             {"PUT", kCorsRules}, {"GET", ""}, {"DELETE", ""}}) {
        const std::string response = s.send(method, "/missing?cors", body);
        EXPECT_TRUE(status_is(response, "404")) << method << "\n" << response;
        EXPECT_TRUE(has(body_of(response), "<Code>NoSuchBucket</Code>")) << method << "\n" << response;
    }

    ASSERT_TRUE(status_is(s.send("PUT", "/objects?cors", kCorsRules), "200"));
    std::string response = s.send("PUT", "/objects?cors", "<CORSConfiguration/>");
    EXPECT_TRUE(status_is(response, "400")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>MalformedXML</Code>")) << response;
    response = s.send("PUT", "/objects?cors", kCorsRules, {{"content-md5", md5_base64("other")}});
    EXPECT_TRUE(status_is(response, "400")) << response;
    EXPECT_TRUE(has(body_of(response), "<Code>BadDigest</Code>")) << response;
    // A rejected configuration leaves the stored one in place.
    EXPECT_TRUE(has(body_of(s.send("GET", "/objects?cors")), "<ID>read</ID>"));
}

// Multipart uploads, end to end over HTTP.

namespace {

// The text of the first <name> element in `xml`, or "<missing>".
std::string element(const std::string &xml, const std::string &name) {
    const std::string open = "<" + name + ">";
    const std::size_t start = xml.find(open);
    if (start == std::string::npos) return "<missing>";
    const std::size_t end = xml.find("</" + name + ">", start);
    return xml.substr(start + open.size(), end - start - open.size());
}

std::string complete_body(const std::vector<std::pair<int, std::string>> &parts) {
    std::string body = "<CompleteMultipartUpload xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">";
    for (const auto &[number, etag] : parts) {
        body += "<Part><PartNumber>" + std::to_string(number) + "</PartNumber><ETag>" + etag + "</ETag></Part>";
    }
    return body + "</CompleteMultipartUpload>";
}

std::string create_upload(ObjectServer &s, const std::string &target, const micros3::http::Headers &extra = {}) {
    const std::string response = s.send("POST", target + "?uploads", "", extra);
    EXPECT_TRUE(status_is(response, "200")) << response;
    return element(body_of(response), "UploadId");
}

std::string upload_part(ObjectServer &s, const std::string &target, const std::string &id, int number,
                        const std::string &body) {
    const std::string response =
        s.send("PUT", target + "?partNumber=" + std::to_string(number) + "&uploadId=" + id, body);
    EXPECT_TRUE(status_is(response, "200")) << response;
    return header_value(response, "ETag");
}

} // namespace

TEST(MultipartApi, UploadListAndComplete) {
    ObjectServer s;
    const std::string target = "/objects/nested/%E9%9B%AA.bin";
    std::string response = s.send("POST", target + "?uploads", "",
                                  {{"content-type", "text/plain"}, {"x-amz-meta-purpose", "multipart"}});
    ASSERT_TRUE(status_is(response, "200")) << response;
    EXPECT_EQ(element(body_of(response), "Bucket"), "objects");
    EXPECT_EQ(element(body_of(response), "Key"), "nested/\xE9\x9B\xAA.bin");
    const std::string id = element(body_of(response), "UploadId");
    ASSERT_EQ(id.size(), 32u);

    const std::string first(5 * 1024 * 1024, 'Z');
    EXPECT_EQ(upload_part(s, target, id, 2, "tail"), quoted_md5("tail"));
    EXPECT_EQ(upload_part(s, target, id, 1, "replaced"), quoted_md5("replaced"));
    const std::string first_etag = upload_part(s, target, id, 1, first);
    EXPECT_EQ(first_etag, quoted_md5(first));
    EXPECT_EQ(upload_part(s, target, id, 3, "small"), quoted_md5("small"));
    // The replaced part's blob is gone: three parts, three blobs.
    EXPECT_EQ(std::distance(std::filesystem::directory_iterator(s.s3.store.blobs_dir()), {}), 3);

    response = s.send("GET", target + "?uploadId=" + id + "&max-parts=2");
    ASSERT_TRUE(status_is(response, "200")) << response;
    EXPECT_EQ(element(body_of(response), "IsTruncated"), "true");
    EXPECT_EQ(element(body_of(response), "NextPartNumberMarker"), "2");
    EXPECT_EQ(count(body_of(response), "<Part>"), 2u);
    response = s.send("GET", target + "?uploadId=" + id + "&part-number-marker=2");
    EXPECT_EQ(element(body_of(response), "IsTruncated"), "false");
    EXPECT_EQ(element(body_of(response), "PartNumber"), "3");
    EXPECT_EQ(element(body_of(response), "Size"), "5");

    response = s.send("GET", "/objects?uploads");
    ASSERT_TRUE(status_is(response, "200")) << response;
    EXPECT_EQ(element(body_of(response), "UploadId"), id);
    EXPECT_EQ(element(body_of(response), "StorageClass"), "STANDARD");

    // Failed completions leave the upload as it was.
    const std::string tail_etag = quoted_md5("tail");
    for (const auto &[parts, code] : std::vector<std::pair<std::vector<std::pair<int, std::string>>, std::string>>{
             {{{2, tail_etag}, {1, first_etag}}, "InvalidPartOrder"},
             {{{1, first_etag}, {2, "\"0123\""}}, "InvalidPart"},
             {{{1, first_etag}, {4, tail_etag}}, "InvalidPart"},
             {{{2, tail_etag}, {3, quoted_md5("small")}}, "EntityTooSmall"},
             {{}, "MalformedXML"}}) {
        response = s.send("POST", target + "?uploadId=" + id, complete_body(parts));
        EXPECT_TRUE(status_is(response, "400")) << code << "\n" << response;
        EXPECT_TRUE(has(body_of(response), "<Code>" + code + "</Code>")) << code << "\n" << response;
    }
    response = s.send("POST", target + "?uploadId=" + id, complete_body({{1, first_etag}}),
                      {{"if-none-match", "*"}});
    EXPECT_TRUE(status_is(response, "501")) << response;

    // Unquoted ETags match too.
    response = s.send("POST", target + "?uploadId=" + id,
                      complete_body({{1, first_etag}, {2, tail_etag.substr(1, 32)}}));
    ASSERT_TRUE(status_is(response, "200")) << response;
    // md5(md5(first) + md5("tail")), computed independently.
    const std::string etag = "\"c463e174662fca2243006bd772883fe7-2\"";
    EXPECT_EQ(element(body_of(response), "ETag"), "&quot;c463e174662fca2243006bd772883fe7-2&quot;") << response;
    EXPECT_EQ(element(body_of(response), "Key"), "nested/\xE9\x9B\xAA.bin");

    response = s.send("GET", target);
    ASSERT_TRUE(status_is(response, "200")) << response.substr(0, 500);
    EXPECT_TRUE(body_of(response) == first + "tail");
    EXPECT_EQ(header_value(response, "ETag"), etag);
    EXPECT_EQ(header_value(response, "Content-Type"), "text/plain");
    EXPECT_EQ(header_value(response, "x-amz-meta-purpose"), "multipart");
    // Only the object's blob remains; the unused part 3 went with the upload.
    EXPECT_EQ(std::distance(std::filesystem::directory_iterator(s.s3.store.blobs_dir()), {}), 1);

    // The upload is finished.
    for (const auto &[method, suffix, body] : std::vector<std::tuple<std::string, std::string, std::string>>{
             {"GET", "?uploadId=" + id, ""},
             {"PUT", "?partNumber=1&uploadId=" + id, "x"},
             {"POST", "?uploadId=" + id, complete_body({{1, first_etag}})},
             {"DELETE", "?uploadId=" + id, ""}}) {
        response = s.send(method, target + suffix, body);
        EXPECT_TRUE(status_is(response, "404")) << method << "\n" << response;
        EXPECT_TRUE(has(body_of(response), "<Code>NoSuchUpload</Code>")) << method << "\n" << response;
    }
    response = s.send("GET", "/objects?uploads");
    EXPECT_EQ(element(body_of(response), "UploadId"), "<missing>");
}

TEST(MultipartApi, AbortAndErrors) {
    ObjectServer s;
    const std::string id = create_upload(s, "/objects/key");
    upload_part(s, "/objects/key", id, 1, "part");
    // Upload IDs are scoped to their key.
    std::string response = s.send("DELETE", "/objects/other?uploadId=" + id);
    EXPECT_TRUE(status_is(response, "404")) << response;
    response = s.send("DELETE", "/objects/key?uploadId=" + id);
    EXPECT_TRUE(status_is(response, "204")) << response;
    EXPECT_TRUE(std::filesystem::is_empty(s.s3.store.blobs_dir()));

    for (const std::string number : {"0", "10001", "x", ""}) {
        response = s.send("PUT", "/objects/key?partNumber=" + number + "&uploadId=" + id, "x");
        EXPECT_TRUE(status_is(response, "400")) << number << "\n" << response;
        EXPECT_TRUE(has(body_of(response), "<Code>InvalidArgument</Code>")) << number << "\n" << response;
    }

    response = s.send("POST", "/missing/key?uploads");
    EXPECT_TRUE(has(body_of(response), "<Code>NoSuchBucket</Code>")) << response;
    response = s.send("GET", "/missing?uploads");
    EXPECT_TRUE(has(body_of(response), "<Code>NoSuchBucket</Code>")) << response;
    response = s.send("PUT", "/missing/key?partNumber=1&uploadId=" + id, "x");
    EXPECT_TRUE(has(body_of(response), "<Code>NoSuchBucket</Code>")) << response;

    // DeleteBucket takes a bucket's uploads with it (D1).
    const std::string other = create_upload(s, "/objects/key");
    upload_part(s, "/objects/key", other, 1, "part");
    EXPECT_TRUE(status_is(s.send("DELETE", "/objects"), "204"));
    EXPECT_TRUE(std::filesystem::is_empty(s.s3.store.blobs_dir()));
}

TEST(MultipartApi, ListUploadsWithDelimiterAndMarkers) {
    ObjectServer s;
    std::vector<std::string> ids;
    for (const char *key : {"alpha/one", "alpha/sub/a", "alpha/two"}) ids.push_back(create_upload(s, "/objects/" + std::string(key)));
    std::string response = s.send("GET", "/objects?uploads&prefix=alpha/&delimiter=/&max-uploads=2");
    ASSERT_TRUE(status_is(response, "200")) << response;
    std::string body = body_of(response);
    EXPECT_EQ(element(body, "IsTruncated"), "true");
    EXPECT_EQ(element(body, "MaxUploads"), "2");
    EXPECT_EQ(element(body, "Prefix"), "alpha/");
    EXPECT_EQ(element(body, "Delimiter"), "/");
    EXPECT_EQ(element(body, "NextKeyMarker"), "alpha/sub/");
    EXPECT_EQ(element(body, "NextUploadIdMarker"), "<missing>");
    EXPECT_TRUE(has(body, "<CommonPrefixes><Prefix>alpha/sub/</Prefix></CommonPrefixes>")) << body;

    response = s.send("GET", "/objects?uploads&max-uploads=1&key-marker=alpha/one&upload-id-marker=" + ids[0]);
    body = body_of(response);
    EXPECT_EQ(element(body, "Key"), "alpha/sub/a");
    EXPECT_EQ(element(body, "NextKeyMarker"), "alpha/sub/a");
    EXPECT_EQ(element(body, "NextUploadIdMarker"), ids[1]);

    response = s.send("GET", "/objects?uploads&encoding-type=url&prefix=alpha%2Fsub%2F");
    body = body_of(response);
    EXPECT_EQ(element(body, "EncodingType"), "url");
    EXPECT_EQ(element(body, "Key"), "alpha/sub/a");
    EXPECT_TRUE(status_is(s.send("GET", "/objects?uploads&encoding-type=xml"), "400"));
    EXPECT_TRUE(status_is(s.send("GET", "/objects?uploads&max-uploads=-1"), "400"));
}
