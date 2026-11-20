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
#include <regex>
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
                       std::optional<std::string> payload_hash = std::nullopt) {
    micros3::http::Request request;
    request.method = method;
    const std::size_t question = target.find('?');
    request.path = target.substr(0, question);
    request.query = question == std::string::npos ? "" : target.substr(question + 1);
    request.headers = {{"host", "localhost"},
                       {"x-amz-date", "20261120T101500Z"},
                       {"x-amz-content-sha256",
                        payload_hash.value_or(micros3::digest::hex(micros3::digest::sha256(body)))}};
    if (credentials) {
        request.headers.emplace_back(
            "authorization", micros3::sigv4::authorization_header(request, *credentials, "us-east-1",
                                                                  {"host", "x-amz-content-sha256", "x-amz-date"}));
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
