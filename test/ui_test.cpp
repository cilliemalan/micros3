// Tests for the web UI port: the request guards (UI6).

#include "micros3/store.h"
#include "micros3/ui_api.h"

#include "temp_dir.h"

#include <gtest/gtest.h>

#include <nlohmann/json.hpp>

#include <optional>
#include <string>

namespace {

using micros3::http::Request;
using micros3::http::Response;
using micros3::ui::guard;
using micros3::ui::host_allowed;

constexpr std::uint16_t kPort = 3924;

Request make_request(std::string method, std::optional<std::string> host,
                     std::optional<std::string> origin = std::nullopt) {
    Request request;
    request.method = std::move(method);
    request.path = "/api/health";
    request.request_id = "TEST";
    if (host) request.headers.emplace_back("host", *host);
    if (origin) request.headers.emplace_back("origin", *origin);
    return request;
}

void expect_forbidden(const std::optional<Response> &response) {
    ASSERT_TRUE(response.has_value());
    EXPECT_EQ(response->status, 403);
    const auto body = nlohmann::json::parse(response->body);
    EXPECT_EQ(body["error"]["code"], "AccessForbidden");
    EXPECT_FALSE(body["error"]["message"].get<std::string>().empty());
}

TEST(UiGuard, LocalhostPasses) {
    EXPECT_TRUE(host_allowed("localhost", kPort));
    EXPECT_TRUE(host_allowed("LocalHost", kPort));
    EXPECT_TRUE(host_allowed("localhost:3924", kPort));
    EXPECT_FALSE(guard(make_request("GET", "localhost:3924"), kPort));
}

TEST(UiGuard, IpLiteralsPass) {
    EXPECT_TRUE(host_allowed("127.0.0.1", kPort));
    EXPECT_TRUE(host_allowed("127.0.0.1:3924", kPort));
    EXPECT_TRUE(host_allowed("192.168.1.20:3924", kPort));
    EXPECT_TRUE(host_allowed("[::1]", kPort));
    EXPECT_TRUE(host_allowed("[::1]:3924", kPort));
    EXPECT_TRUE(host_allowed("[fe80::1:2]:3924", kPort));
    EXPECT_FALSE(guard(make_request("GET", "10.0.0.5:3924"), kPort));
    EXPECT_FALSE(guard(make_request("DELETE", "[::1]:3924"), kPort));
}

TEST(UiGuard, RebindingNameIsRefused) {
    EXPECT_FALSE(host_allowed("attacker.example", kPort));
    EXPECT_FALSE(host_allowed("attacker.example:3924", kPort));
    EXPECT_FALSE(host_allowed("localhost.attacker.example:3924", kPort));
    EXPECT_FALSE(host_allowed("localhost.", kPort));
    EXPECT_FALSE(host_allowed("127.0.0.1.nip.io:3924", kPort));
    expect_forbidden(guard(make_request("GET", "attacker.example:3924"), kPort));
}

TEST(UiGuard, ProxyRewrittenHostIsRefused) {
    expect_forbidden(guard(make_request("GET", "micros3-ui.internal"), kPort));
}

TEST(UiGuard, MissingHostIsRefused) {
    EXPECT_FALSE(host_allowed("", kPort));
    expect_forbidden(guard(make_request("GET", std::nullopt), kPort));
}

TEST(UiGuard, WrongPortIsRefused) {
    EXPECT_FALSE(host_allowed("localhost:3923", kPort));
    EXPECT_FALSE(host_allowed("127.0.0.1:80", kPort));
    EXPECT_FALSE(host_allowed("[::1]:3923", kPort));
    EXPECT_FALSE(host_allowed("localhost:", kPort));
    EXPECT_FALSE(host_allowed("localhost:03924x", kPort));
    EXPECT_FALSE(host_allowed("localhost:3924:3924", kPort));
    EXPECT_FALSE(host_allowed("localhost:1003924", kPort));
    expect_forbidden(guard(make_request("GET", "localhost:3923"), kPort));
}

TEST(UiGuard, MalformedHostIsRefused) {
    EXPECT_FALSE(host_allowed("[::1", kPort));
    EXPECT_FALSE(host_allowed("[::1]x", kPort));
    EXPECT_FALSE(host_allowed("[localhost]", kPort));
    EXPECT_FALSE(host_allowed("[127.0.0.1]", kPort));
    EXPECT_FALSE(host_allowed("::1", kPort));
    EXPECT_FALSE(host_allowed("[fe80::1%25eth0]", kPort));
    EXPECT_FALSE(host_allowed("256.0.0.1", kPort));
    EXPECT_FALSE(host_allowed("user@localhost", kPort));
}

TEST(UiGuard, PostWithForeignOriginIsRefused) {
    expect_forbidden(guard(make_request("POST", "localhost:3924", "http://attacker.example"), kPort));
    expect_forbidden(guard(make_request("PUT", "localhost:3924", "http://attacker.example"), kPort));
    expect_forbidden(guard(make_request("DELETE", "localhost:3924", "http://attacker.example"), kPort));
    // Same host, but another scheme or port is another origin.
    expect_forbidden(guard(make_request("POST", "localhost:3924", "https://localhost:3924"), kPort));
    expect_forbidden(guard(make_request("POST", "localhost:3924", "http://localhost:3923"), kPort));
    expect_forbidden(guard(make_request("POST", "localhost:3924", "http://localhost"), kPort));
    // Sandboxed frames and some redirects send "null".
    expect_forbidden(guard(make_request("POST", "localhost:3924", "null"), kPort));
}

TEST(UiGuard, PostWithOwnOriginPasses) {
    EXPECT_FALSE(guard(make_request("POST", "localhost:3924", "http://localhost:3924"), kPort));
    EXPECT_FALSE(guard(make_request("PUT", "127.0.0.1:3924", "http://127.0.0.1:3924"), kPort));
    EXPECT_FALSE(guard(make_request("DELETE", "localhost", "http://localhost"), kPort));
}

TEST(UiGuard, PostWithNoOriginPasses) {
    EXPECT_FALSE(guard(make_request("POST", "localhost:3924"), kPort));
    EXPECT_FALSE(guard(make_request("PUT", "127.0.0.1"), kPort));
    EXPECT_FALSE(guard(make_request("DELETE", "[::1]:3924"), kPort));
}

TEST(UiGuard, GetWithForeignOriginPasses) {
    EXPECT_FALSE(guard(make_request("GET", "localhost:3924", "http://attacker.example"), kPort));
    EXPECT_FALSE(guard(make_request("HEAD", "localhost:3924", "http://attacker.example"), kPort));
}

TEST(UiGuard, OtherChangingMethodsAreCheckedToo) {
    expect_forbidden(guard(make_request("PATCH", "localhost:3924", "http://attacker.example"), kPort));
}

TEST(UiGuard, ForeignOriginDoesNotHelpABadHost) {
    expect_forbidden(guard(make_request("POST", "attacker.example", "http://attacker.example"), kPort));
}

// The service runs the guards before routing, so even an unknown path is
// refused with 403, not 404.
TEST(UiService, GuardsRunBeforeRouting) {
    micros3::test::TempDir dir;
    micros3::Store store(dir.path());
    micros3::UiService service(store, kPort);

    auto refused = service.begin(make_request("GET", "attacker.example:3924"));
    EXPECT_EQ(refused->on_end().status, 403);

    Request unknown = make_request("GET", "attacker.example:3924");
    unknown.path = "/no/such/path";
    EXPECT_EQ(service.begin(unknown)->on_end().status, 403);

    auto passed = service.begin(make_request("GET", "localhost:3924"));
    EXPECT_EQ(passed->on_end().status, 200);

    service.set_port(4000);
    EXPECT_EQ(service.begin(make_request("GET", "localhost:3924"))->on_end().status, 403);
    EXPECT_EQ(service.begin(make_request("GET", "localhost:4000"))->on_end().status, 200);
}

} // namespace
