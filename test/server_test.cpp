#include "micros3/server.h"
#include "micros3/service.h"

#include <gtest/gtest.h>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <future>
#include <memory>
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

TEST(S3Service, UnsupportedSubresourceIsNotImplementedXml) {
    micros3::S3Service service;
    RunningServer server(service);
    const std::string response = exchange(server.port(), "PUT /bucket/key?tagging HTTP/1.1\r\nHost: localhost\r\n"
                                                         "Connection: close\r\nContent-Length: 5\r\n\r\nhello");
    EXPECT_EQ(response.rfind("HTTP/1.1 501 Not Implemented\r\n", 0), 0u) << response;
    EXPECT_EQ(header_value(response, "Content-Type"), "application/xml");
    const std::string id = header_value(response, "x-amz-request-id");
    const std::string body = body_of(response);
    EXPECT_NE(body.find("<Code>NotImplemented</Code>"), std::string::npos) << body;
    EXPECT_NE(body.find("<Resource>/bucket/key</Resource>"), std::string::npos) << body;
    EXPECT_NE(body.find("<RequestId>" + id + "</RequestId>"), std::string::npos) << body;
}

TEST(S3Service, HeadErrorHasNoBody) {
    micros3::S3Service service;
    RunningServer server(service);
    const std::string response =
        exchange(server.port(), "HEAD /bucket/key?acl HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    EXPECT_EQ(response.rfind("HTTP/1.1 501 Not Implemented\r\n", 0), 0u) << response;
    EXPECT_EQ(body_of(response), "");
}

TEST(S3Service, InvalidUriIsBadRequest) {
    micros3::S3Service service;
    RunningServer server(service);
    const std::string response =
        exchange(server.port(), "GET /bucket/%zz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    EXPECT_EQ(response.rfind("HTTP/1.1 400 Bad Request\r\n", 0), 0u) << response;
    EXPECT_NE(body_of(response).find("<Code>InvalidURI</Code>"), std::string::npos);
}
