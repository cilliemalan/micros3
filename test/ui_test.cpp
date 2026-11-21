// Tests for the web UI port: the request guards (UI6) and static serving (U11).

#include "micros3/store.h"
#include "micros3/ui_api.h"

#include "temp_dir.h"

#include <gtest/gtest.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <iterator>
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

// The value of the response header `name` (any case), or "".
std::string header(const Response &response, std::string_view name) {
    for (const auto &[key, value] : response.headers) {
        if (key.size() == name.size() &&
            std::equal(key.begin(), key.end(), name.begin(), [](char a, char b) {
                return std::tolower(static_cast<unsigned char>(a)) == std::tolower(static_cast<unsigned char>(b));
            })) {
            return value;
        }
    }
    return "";
}

// A small asset table standing in for the embedded UI build.
const unsigned char kIndex[] = {'<', 'h', '1', '>', 'h', 'i', '<', '/', 'h', '1', '>'};
const unsigned char kScript[] = {'1', ';'};
const unsigned char kStyle[] = {'a', '{', '}'};
const micros3::ui::Asset kTestAssets[] = {
    {"/assets/index-abc.css", "text/css; charset=utf-8", kStyle, sizeof(kStyle)},
    {"/assets/index-abc.js", "text/javascript; charset=utf-8", kScript, sizeof(kScript)},
    {"/favicon.ico", "image/x-icon", nullptr, 0},
    {"/index.html", "text/html; charset=utf-8", kIndex, sizeof(kIndex)},
};

class UiStatic : public ::testing::Test {
protected:
    Response get(std::string method, std::string path, std::string query = "") {
        Request request = make_request(std::move(method), "localhost:3924");
        request.path = std::move(path);
        request.query = std::move(query);
        return service.begin(request)->on_end();
    }

    void expect_not_found(const Response &response) {
        EXPECT_EQ(response.status, 404);
        const auto body = nlohmann::json::parse(response.body);
        EXPECT_EQ(body["error"]["code"], "NotFound");
        EXPECT_NE(header(response, "content-type").find("application/json"), std::string::npos);
    }

    micros3::test::TempDir dir;
    micros3::Store store{dir.path()};
    micros3::UiService service{store, kPort, micros3::ui::Assets{kTestAssets, std::size(kTestAssets)}};
};

TEST_F(UiStatic, RootServesIndexHtml) {
    const Response response = get("GET", "/");
    EXPECT_EQ(response.status, 200);
    EXPECT_EQ(response.body, "<h1>hi</h1>");
    EXPECT_EQ(header(response, "content-type"), "text/html; charset=utf-8");
    EXPECT_EQ(header(response, "cache-control"), "no-cache");
    EXPECT_EQ(header(response, "x-content-type-options"), "nosniff");
    EXPECT_EQ(header(response, "referrer-policy"), "no-referrer");
    EXPECT_NE(header(response, "content-security-policy").find("default-src 'self'"), std::string::npos);

    // index.html is also served at its own name, and a query does not matter.
    EXPECT_EQ(get("GET", "/index.html").body, "<h1>hi</h1>");
    EXPECT_EQ(get("GET", "/", "x=1").body, "<h1>hi</h1>");
}

TEST_F(UiStatic, AssetsHaveTheirContentTypes) {
    const Response script = get("GET", "/assets/index-abc.js");
    EXPECT_EQ(script.status, 200);
    EXPECT_EQ(script.body, "1;");
    EXPECT_EQ(header(script, "content-type"), "text/javascript; charset=utf-8");
    EXPECT_EQ(header(script, "cache-control"), "public, max-age=31536000, immutable");

    const Response style = get("GET", "/assets/index-abc.css");
    EXPECT_EQ(style.body, "a{}");
    EXPECT_EQ(header(style, "content-type"), "text/css; charset=utf-8");

    const Response icon = get("GET", "/favicon.ico");
    EXPECT_EQ(icon.status, 200);
    EXPECT_EQ(icon.body, "");
    EXPECT_EQ(header(icon, "cache-control"), "no-cache");
}

TEST_F(UiStatic, HeadHasNoBody) {
    const Response response = get("HEAD", "/");
    EXPECT_EQ(response.status, 200);
    EXPECT_EQ(response.body, "");
    ASSERT_TRUE(response.reported_length.has_value());
    EXPECT_EQ(*response.reported_length, sizeof(kIndex));
    EXPECT_EQ(header(response, "content-type"), "text/html; charset=utf-8");
    EXPECT_EQ(get("HEAD", "/assets/index-abc.js").reported_length, 2u);
}

TEST_F(UiStatic, UnknownPathsAreNotFound) {
    expect_not_found(get("GET", "/nope"));
    expect_not_found(get("GET", "/assets/"));
    expect_not_found(get("GET", "/assets/missing.js"));
    expect_not_found(get("GET", "/assets"));
    expect_not_found(get("GET", "//index.html"));
    expect_not_found(get("GET", "/index.html/"));
    expect_not_found(get("GET", "/assets/../index.html"));
    expect_not_found(get("GET", "/api"));
}

TEST_F(UiStatic, S3RequestsAreNotFound) {
    expect_not_found(get("GET", "/photos", "list-type=2"));
    expect_not_found(get("GET", "/photos/2026/a.jpg"));
    expect_not_found(get("PUT", "/photos"));
    expect_not_found(get("PUT", "/photos/a.jpg"));
    expect_not_found(get("DELETE", "/photos/a.jpg"));
    expect_not_found(get("POST", "/photos", "delete"));
    expect_not_found(get("HEAD", "/photos"));
}

TEST_F(UiStatic, OnlyGetAndHeadOnFiles) {
    for (const char *method : {"POST", "PUT", "DELETE", "PATCH", "OPTIONS"}) {
        for (const char *path : {"/", "/index.html", "/assets/index-abc.js"}) {
            const Response response = get(method, path);
            EXPECT_EQ(response.status, 405) << method << " " << path;
            EXPECT_EQ(nlohmann::json::parse(response.body)["error"]["code"], "MethodNotAllowed");
        }
    }
}

TEST_F(UiStatic, GuardsRunBeforeStaticFiles) {
    Request request = make_request("GET", "attacker.example:3924");
    request.path = "/";
    EXPECT_EQ(service.begin(request)->on_end().status, 403);
}

} // namespace
