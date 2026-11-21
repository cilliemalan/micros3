// Tests for the web UI's JSON API: the bucket routes (docs/todo.md, U8).

#include "micros3/buckets.h"
#include "micros3/clock.h"
#include "micros3/objects.h"
#include "micros3/store.h"
#include "micros3/ui_api.h"

#include "temp_dir.h"

#include <gtest/gtest.h>

#include <nlohmann/json.hpp>

#include <cstdio>
#include <optional>
#include <string>

namespace {

using micros3::http::Request;
using micros3::http::Response;
using nlohmann::json;

constexpr std::uint16_t kPort = 3924;

class UiApi : public ::testing::Test {
protected:
    micros3::test::TempDir dir;
    micros3::Store store{dir.path()};
    micros3::UiService service{store, kPort};

    Response call(std::string method, std::string path, std::optional<std::string> body = std::nullopt) {
        Request request;
        request.method = std::move(method);
        const std::size_t q = path.find('?');
        request.path = path.substr(0, q);
        if (q != std::string::npos) request.query = path.substr(q + 1);
        request.request_id = "TEST";
        request.headers.emplace_back("host", "localhost:3924");
        auto exchange = service.begin(request);
        if (body) exchange->on_data(*body);
        return exchange->on_end();
    }

    static json parse(const Response &response) { return json::parse(response.body); }

    static void expect_error(const Response &response, int status, const std::string &code) {
        EXPECT_EQ(response.status, status) << response.body;
        const json body = parse(response);
        EXPECT_EQ(body["error"]["code"], code) << response.body;
        EXPECT_TRUE(body["error"]["message"].is_string());
        EXPECT_FALSE(body["error"]["message"].get<std::string>().empty());
    }

    static std::optional<std::string> header(const Response &response, const std::string &name) {
        for (const auto &[n, v] : response.headers) {
            if (n == name) return v;
        }
        return std::nullopt;
    }

    void make_bucket(const std::string &name, const std::string &region = "us-east-1") {
        ASSERT_FALSE(micros3::buckets::create(store, name, region, 1700000000000));
    }

    void put_object(const std::string &bucket, const std::string &key) {
        const std::string blob_id = "blob" + std::to_string(++blobs_);
        std::FILE *f = std::fopen(store.blob_path(blob_id).c_str(), "w");
        ASSERT_NE(f, nullptr);
        std::fputs("x", f);
        std::fclose(f);
        micros3::objects::Object object;
        object.bucket = bucket;
        object.key = key;
        object.blob_id = blob_id;
        object.size = 1;
        object.etag = "\"etag\"";
        object.last_modified_ms = 1700000000000;
        std::optional<std::string> replaced;
        micros3::objects::put(store, object, replaced);
    }

    int blobs_ = 0;
};

const char *kCorsXml = "<CORSConfiguration><CORSRule><AllowedOrigin>http://example.com</AllowedOrigin>"
                       "<AllowedMethod>GET</AllowedMethod></CORSRule></CORSConfiguration>";

TEST_F(UiApi, Health) {
    const Response response = call("GET", "/api/health");
    EXPECT_EQ(response.status, 200);
    EXPECT_EQ(parse(response)["status"], "ok");
    EXPECT_EQ(header(response, "Content-Type"), "application/json; charset=utf-8");
    expect_error(call("POST", "/api/health"), 405, "MethodNotAllowed");
}

TEST_F(UiApi, ListBucketsEmpty) {
    const Response response = call("GET", "/api/buckets");
    EXPECT_EQ(response.status, 200);
    EXPECT_EQ(parse(response), json::parse(R"({"buckets":[]})"));
}

TEST_F(UiApi, ListBucketsInNameOrder) {
    make_bucket("zeta", "eu-west-1");
    make_bucket("alpha");
    const json body = parse(call("GET", "/api/buckets"));
    ASSERT_EQ(body["buckets"].size(), 2u);
    EXPECT_EQ(body["buckets"][0]["name"], "alpha");
    EXPECT_EQ(body["buckets"][0]["region"], "us-east-1");
    EXPECT_EQ(body["buckets"][0]["created"], micros3::clock::iso8601(1700000000000));
    EXPECT_EQ(body["buckets"][1]["name"], "zeta");
    EXPECT_EQ(body["buckets"][1]["region"], "eu-west-1");
}

TEST_F(UiApi, CreateBucket) {
    const Response response = call("POST", "/api/buckets", R"({"name":"photos","region":"eu-west-1"})");
    ASSERT_EQ(response.status, 200) << response.body;
    const json body = parse(response);
    EXPECT_EQ(body["name"], "photos");
    EXPECT_EQ(body["region"], "eu-west-1");
    EXPECT_TRUE(body["created"].is_string());
    const auto bucket = micros3::buckets::find(store, "photos");
    ASSERT_TRUE(bucket);
    EXPECT_EQ(bucket->region, "eu-west-1");
    EXPECT_EQ(body["created"], micros3::clock::iso8601(bucket->created_ms));
}

TEST_F(UiApi, CreateBucketDefaultsTheRegion) {
    EXPECT_EQ(parse(call("POST", "/api/buckets", R"({"name":"one"})"))["region"], "us-east-1");
    EXPECT_EQ(parse(call("POST", "/api/buckets", R"({"name":"two","region":null})"))["region"], "us-east-1");
    EXPECT_EQ(parse(call("POST", "/api/buckets", R"({"name":"three","region":""})"))["region"], "us-east-1");
}

TEST_F(UiApi, CreateExistingBucketIsAConflict) {
    make_bucket("photos");
    expect_error(call("POST", "/api/buckets", R"({"name":"photos"})"), 409, "BucketAlreadyOwnedByYou");
}

TEST_F(UiApi, CreateBucketRefusesBadNamesAndRegions) {
    expect_error(call("POST", "/api/buckets", R"({"name":"Bad_Name"})"), 400, "InvalidBucketName");
    expect_error(call("POST", "/api/buckets", R"({"name":"ab"})"), 400, "InvalidBucketName");
    expect_error(call("POST", "/api/buckets", R"({"name":"ok-name","region":"Mars 1"})"), 400,
                 "InvalidLocationConstraint");
    EXPECT_FALSE(micros3::buckets::find(store, "ok-name"));
}

TEST_F(UiApi, CreateBucketRefusesMalformedBodies) {
    expect_error(call("POST", "/api/buckets", "not json"), 400, "MalformedJSON");
    expect_error(call("POST", "/api/buckets", ""), 400, "MalformedJSON");
    expect_error(call("POST", "/api/buckets", R"(["photos"])"), 400, "MalformedJSON");
    expect_error(call("POST", "/api/buckets", R"({"name":5})"), 400, "MalformedJSON");
    expect_error(call("POST", "/api/buckets", R"({"name":"photos","region":5})"), 400, "MalformedJSON");
    expect_error(call("POST", "/api/buckets", std::string(1024 * 1024 + 1, ' ')), 400, "MaxMessageLengthExceeded");
}

TEST_F(UiApi, BucketsMethodNotAllowed) {
    expect_error(call("PUT", "/api/buckets"), 405, "MethodNotAllowed");
    expect_error(call("DELETE", "/api/buckets"), 405, "MethodNotAllowed");
}

TEST_F(UiApi, GetBucket) {
    make_bucket("photos", "eu-west-1");
    json body = parse(call("GET", "/api/buckets/photos"));
    EXPECT_EQ(body["name"], "photos");
    EXPECT_EQ(body["region"], "eu-west-1");
    EXPECT_EQ(body["created"], micros3::clock::iso8601(1700000000000));
    EXPECT_EQ(body["encryption"], "AES256");
    EXPECT_EQ(body["cors"], false);

    EXPECT_EQ(call("PUT", "/api/buckets/photos/cors", kCorsXml).status, 204);
    EXPECT_EQ(parse(call("GET", "/api/buckets/photos"))["cors"], true);
}

TEST_F(UiApi, GetMissingBucket) { expect_error(call("GET", "/api/buckets/nope"), 404, "NoSuchBucket"); }

TEST_F(UiApi, BucketNameIsPercentDecoded) {
    make_bucket("my.bucket");
    EXPECT_EQ(parse(call("GET", "/api/buckets/my%2Ebucket"))["name"], "my.bucket");
    expect_error(call("GET", "/api/buckets/bad%zz"), 400, "InvalidURI");
    expect_error(call("GET", "/api/buckets/a%2Fb"), 404, "NoSuchBucket");
}

TEST_F(UiApi, DeleteBucket) {
    make_bucket("photos");
    const Response response = call("DELETE", "/api/buckets/photos");
    EXPECT_EQ(response.status, 204);
    EXPECT_TRUE(response.body.empty());
    EXPECT_FALSE(micros3::buckets::find(store, "photos"));
    expect_error(call("DELETE", "/api/buckets/photos"), 404, "NoSuchBucket");
}

TEST_F(UiApi, DeleteNonEmptyBucketThenEmptyAndDelete) {
    make_bucket("photos");
    put_object("photos", "a.txt");
    put_object("photos", "dir/b.txt");
    expect_error(call("DELETE", "/api/buckets/photos"), 409, "BucketNotEmpty");
    EXPECT_TRUE(micros3::buckets::find(store, "photos"));

    EXPECT_EQ(call("POST", "/api/buckets/photos/empty").status, 204);
    EXPECT_TRUE(micros3::buckets::find(store, "photos"));
    EXPECT_FALSE(micros3::objects::find(store, "photos", "a.txt"));
    EXPECT_EQ(call("DELETE", "/api/buckets/photos").status, 204);
}

TEST_F(UiApi, EmptyMissingBucket) {
    expect_error(call("POST", "/api/buckets/nope/empty"), 404, "NoSuchBucket");
    expect_error(call("GET", "/api/buckets/nope/empty"), 405, "MethodNotAllowed");
}

TEST_F(UiApi, BucketMethodNotAllowed) {
    make_bucket("photos");
    expect_error(call("POST", "/api/buckets/photos"), 405, "MethodNotAllowed");
    expect_error(call("PUT", "/api/buckets/photos"), 405, "MethodNotAllowed");
}

TEST_F(UiApi, CorsLifecycle) {
    make_bucket("photos");
    expect_error(call("GET", "/api/buckets/photos/cors"), 404, "NoSuchCORSConfiguration");

    EXPECT_EQ(call("PUT", "/api/buckets/photos/cors", kCorsXml).status, 204);
    const Response got = call("GET", "/api/buckets/photos/cors");
    EXPECT_EQ(got.status, 200);
    EXPECT_EQ(header(got, "Content-Type"), "application/xml");
    EXPECT_NE(got.body.find("<AllowedOrigin>http://example.com</AllowedOrigin>"), std::string::npos);

    EXPECT_EQ(call("DELETE", "/api/buckets/photos/cors").status, 204);
    expect_error(call("GET", "/api/buckets/photos/cors"), 404, "NoSuchCORSConfiguration");
    // Removing an absent configuration succeeds, as in S3.
    EXPECT_EQ(call("DELETE", "/api/buckets/photos/cors").status, 204);
}

TEST_F(UiApi, CorsErrors) {
    expect_error(call("GET", "/api/buckets/nope/cors"), 404, "NoSuchBucket");
    expect_error(call("PUT", "/api/buckets/nope/cors", kCorsXml), 404, "NoSuchBucket");
    expect_error(call("DELETE", "/api/buckets/nope/cors"), 404, "NoSuchBucket");
    make_bucket("photos");
    expect_error(call("PUT", "/api/buckets/photos/cors", "<nope"), 400, "MalformedXML");
    expect_error(call("PUT", "/api/buckets/photos/cors",
                      "<CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin>"
                      "<AllowedMethod>PATCH</AllowedMethod></CORSRule></CORSConfiguration>"),
                 400, "InvalidRequest");
    expect_error(call("POST", "/api/buckets/photos/cors"), 405, "MethodNotAllowed");
}

TEST_F(UiApi, UnknownPathsAreNotFound) {
    expect_error(call("GET", "/api/nope"), 404, "NotFound");
    expect_error(call("GET", "/api/buckets/"), 404, "NotFound");
    expect_error(call("GET", "/api/buckets/photos/nope"), 404, "NotFound");
    expect_error(call("GET", "/api"), 404, "NotFound");
    expect_error(call("GET", "/photos"), 404, "NotFound");
}

TEST_F(UiApi, HeadIsAllowedWhereGetIs) {
    make_bucket("photos");
    EXPECT_EQ(call("HEAD", "/api/buckets").status, 200);
    EXPECT_EQ(call("HEAD", "/api/buckets/photos").status, 200);
}

TEST_F(UiApi, ChangingRoutesWaitForTheBodyToEnd) {
    make_bucket("photos");
    Request request;
    request.method = "DELETE";
    request.path = "/api/buckets/photos";
    request.request_id = "TEST";
    request.headers.emplace_back("host", "localhost:3924");
    auto exchange = service.begin(request);
    EXPECT_TRUE(micros3::buckets::find(store, "photos"));
    exchange->on_abort();
    exchange.reset();
    EXPECT_TRUE(micros3::buckets::find(store, "photos"));
}

} // namespace
