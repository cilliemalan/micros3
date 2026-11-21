// Tests for the web UI's JSON API: the bucket routes (docs/todo.md, U8) and
// the object routes (U9).

#include "micros3/buckets.h"
#include "micros3/clock.h"
#include "micros3/objects.h"
#include "micros3/store.h"
#include "micros3/ui_api.h"

#include "temp_dir.h"

#include <gtest/gtest.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <set>
#include <vector>
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

// Percent-encodes every byte that is not unreserved, as encodeURIComponent.
std::string enc(const std::string &text) {
    static const char *hex = "0123456789ABCDEF";
    std::string out;
    for (unsigned char c : text) {
        if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
            out.push_back(static_cast<char>(c));
        } else {
            out.push_back('%');
            out.push_back(hex[c >> 4]);
            out.push_back(hex[c & 15]);
        }
    }
    return out;
}

// Keys a browser user may well type, each needing care somewhere.
const std::vector<std::string> kAwkwardKeys = {
    "with space.txt", "100%.txt", "a/b/c.txt", "caf\xc3\xa9/\xe6\x97\xa5\xe6\x9c\xac.txt", "<script>alert(1)</script>",
    "plus+and&amp=.txt",
};

TEST_F(UiApi, ListObjectsOneLevel) {
    make_bucket("photos");
    put_object("photos", "top.txt");
    put_object("photos", "a/one.txt");
    put_object("photos", "a/two.txt");
    put_object("photos", "b/c/deep.txt");
    const Response response = call("GET", "/api/buckets/photos/objects?delimiter=%2F");
    ASSERT_EQ(response.status, 200) << response.body;
    const json body = parse(response);
    EXPECT_EQ(body["folders"], json::parse(R"(["a/","b/"])"));
    ASSERT_EQ(body["objects"].size(), 1u);
    EXPECT_EQ(body["objects"][0]["key"], "top.txt");
    EXPECT_EQ(body["objects"][0]["size"], 1);
    EXPECT_EQ(body["objects"][0]["etag"], "\"etag\"");
    EXPECT_EQ(body["objects"][0]["lastModified"], micros3::clock::iso8601(1700000000000));
    EXPECT_FALSE(body.contains("next"));

    const json inside = parse(call("GET", "/api/buckets/photos/objects?prefix=a%2F&delimiter=%2F"));
    EXPECT_EQ(inside["folders"], json::array());
    ASSERT_EQ(inside["objects"].size(), 2u);
    EXPECT_EQ(inside["objects"][0]["key"], "a/one.txt");
    EXPECT_EQ(inside["objects"][1]["key"], "a/two.txt");

    // With no delimiter, every key is listed.
    EXPECT_EQ(parse(call("GET", "/api/buckets/photos/objects"))["objects"].size(), 4u);
}

TEST_F(UiApi, ListObjectsPages) {
    make_bucket("photos");
    for (const char *key : {"a", "b/x", "b/y", "c", "d"}) put_object("photos", key);
    std::vector<std::string> seen;
    std::string after;
    for (int page = 0; page < 10; ++page) {
        std::string path = "/api/buckets/photos/objects?delimiter=/&limit=2";
        if (!after.empty()) path += "&after=" + enc(after);
        const json body = parse(call("GET", path));
        for (const auto &f : body["folders"]) seen.push_back(f.get<std::string>());
        for (const auto &o : body["objects"]) seen.push_back(o["key"].get<std::string>());
        if (!body.contains("next")) break;
        after = body["next"].get<std::string>();
    }
    // Folders come before objects within a page, so compare in order.
    std::sort(seen.begin(), seen.end());
    EXPECT_EQ(seen, (std::vector<std::string>{"a", "b/", "c", "d"}));
}

TEST_F(UiApi, ListObjectsErrors) {
    expect_error(call("GET", "/api/buckets/nope/objects"), 404, "NoSuchBucket");
    make_bucket("photos");
    expect_error(call("GET", "/api/buckets/photos/objects?limit=0"), 400, "InvalidArgument");
    expect_error(call("GET", "/api/buckets/photos/objects?limit=1001"), 400, "InvalidArgument");
    expect_error(call("GET", "/api/buckets/photos/objects?limit=x"), 400, "InvalidArgument");
    expect_error(call("GET", "/api/buckets/photos/objects?limit=99999999999999999999"), 400, "InvalidArgument");
    expect_error(call("GET", "/api/buckets/photos/objects?prefix=%zz"), 400, "InvalidURI");
    expect_error(call("POST", "/api/buckets/photos/objects"), 405, "MethodNotAllowed");
    EXPECT_EQ(call("GET", "/api/buckets/photos/objects?limit=1000").status, 200);
}

TEST_F(UiApi, ListObjectsWithAwkwardKeys) {
    make_bucket("photos");
    for (const std::string &key : kAwkwardKeys) put_object("photos", key);
    const json body = parse(call("GET", "/api/buckets/photos/objects"));
    std::set<std::string> keys;
    for (const auto &o : body["objects"]) keys.insert(o["key"].get<std::string>());
    EXPECT_EQ(keys, std::set<std::string>(kAwkwardKeys.begin(), kAwkwardKeys.end()));
}

TEST_F(UiApi, GetMeta) {
    make_bucket("photos");
    put_object("photos", "cat.jpg");
    ASSERT_EQ(micros3::objects::update_headers(store, "photos", "cat.jpg",
                                               {{"Content-Type", "image/jpeg"}, {"x-amz-meta-owner", "me"}}),
              micros3::objects::UpdateResult::Updated);
    const Response response = call("GET", "/api/buckets/photos/meta?key=cat.jpg");
    ASSERT_EQ(response.status, 200) << response.body;
    const json body = parse(response);
    EXPECT_EQ(body["key"], "cat.jpg");
    EXPECT_EQ(body["size"], 1);
    EXPECT_EQ(body["etag"], "\"etag\"");
    EXPECT_EQ(body["lastModified"], micros3::clock::iso8601(1700000000000));
    EXPECT_EQ(body["headers"], json::parse(R"({"Content-Type":"image/jpeg","x-amz-meta-owner":"me"})"));
}

TEST_F(UiApi, GetMetaWithAwkwardKeys) {
    make_bucket("photos");
    for (const std::string &key : kAwkwardKeys) {
        put_object("photos", key);
        const Response response = call("GET", "/api/buckets/photos/meta?key=" + enc(key));
        ASSERT_EQ(response.status, 200) << key << ": " << response.body;
        EXPECT_EQ(parse(response)["key"], key);
    }
}

TEST_F(UiApi, MetaErrors) {
    expect_error(call("GET", "/api/buckets/nope/meta?key=a"), 404, "NoSuchBucket");
    expect_error(call("PUT", "/api/buckets/nope/meta?key=a", R"({"headers":{}})"), 404, "NoSuchBucket");
    make_bucket("photos");
    expect_error(call("GET", "/api/buckets/photos/meta?key=a"), 404, "NoSuchKey");
    expect_error(call("PUT", "/api/buckets/photos/meta?key=a", R"({"headers":{}})"), 404, "NoSuchKey");
    expect_error(call("GET", "/api/buckets/photos/meta"), 400, "InvalidArgument");
    expect_error(call("GET", "/api/buckets/photos/meta?key="), 400, "InvalidArgument");
    expect_error(call("GET", "/api/buckets/photos/meta?key=" + std::string(1025, 'k')), 400, "KeyTooLongError");
    expect_error(call("GET", "/api/buckets/photos/meta?key=%zz"), 400, "InvalidURI");
    expect_error(call("DELETE", "/api/buckets/photos/meta?key=a"), 405, "MethodNotAllowed");
}

TEST_F(UiApi, PutMetaKeepsTheBlobEtagAndTime) {
    make_bucket("photos");
    const std::string key = "dir/caf\xc3\xa9 100%.txt";
    put_object("photos", key);
    const auto before = micros3::objects::find(store, "photos", key);
    ASSERT_TRUE(before);
    const Response response =
        call("PUT", "/api/buckets/photos/meta?key=" + enc(key),
             R"({"headers":{"content-type":"text/plain","Cache-Control":"no-cache","X-Amz-Meta-Owner":"me"}})");
    ASSERT_EQ(response.status, 200) << response.body;
    const json body = parse(response);
    EXPECT_EQ(body["key"], key);
    EXPECT_EQ(body["etag"], "\"etag\"");
    EXPECT_EQ(body["lastModified"], micros3::clock::iso8601(1700000000000));
    EXPECT_EQ(body["headers"],
              json::parse(R"({"Content-Type":"text/plain","Cache-Control":"no-cache","x-amz-meta-owner":"me"})"));
    const auto after = micros3::objects::find(store, "photos", key);
    ASSERT_TRUE(after);
    EXPECT_EQ(after->blob_id, before->blob_id);
    EXPECT_EQ(after->etag, before->etag);
    EXPECT_EQ(after->last_modified_ms, before->last_modified_ms);
    EXPECT_EQ(after->size, before->size);

    // An empty object clears every stored header.
    ASSERT_EQ(call("PUT", "/api/buckets/photos/meta?key=" + enc(key), R"({"headers":{}})").status, 200);
    EXPECT_TRUE(micros3::objects::find(store, "photos", key)->headers.empty());
}

TEST_F(UiApi, PutMetaRefusesBadHeaders) {
    make_bucket("photos");
    put_object("photos", "a");
    const std::string path = "/api/buckets/photos/meta?key=a";
    expect_error(call("PUT", path, "nope"), 400, "MalformedJSON");
    expect_error(call("PUT", path, R"({})"), 400, "MalformedJSON");
    expect_error(call("PUT", path, R"({"headers":[]})"), 400, "MalformedJSON");
    expect_error(call("PUT", path, R"({"headers":{"Content-Type":1}})"), 400, "MalformedJSON");
    expect_error(call("PUT", path, R"({"headers":{"Content-Length":"1"}})"), 400, "InvalidArgument");
    expect_error(call("PUT", path, R"({"headers":{"x-amz-meta-":"1"}})"), 400, "InvalidArgument");
    expect_error(call("PUT", path, R"({"headers":{"x-amz-meta-a b":"1"}})"), 400, "InvalidArgument");
    expect_error(call("PUT", path, R"({"headers":{"x-amz-meta-a":"1\r\nSet-Cookie: x"}})"), 400, "InvalidArgument");
    expect_error(call("PUT", path, R"({"headers":{"x-amz-meta-a":"1","X-Amz-Meta-A":"2"}})"), 400,
                 "InvalidArgument");
    expect_error(call("PUT", path, R"({"headers":{"x-amz-meta-big":")" + std::string(2100, 'v') + R"("}})"), 400,
                 "MetadataTooLarge");
    EXPECT_TRUE(micros3::objects::find(store, "photos", "a")->headers.empty());
}

TEST_F(UiApi, DeleteObjects) {
    make_bucket("photos");
    for (const std::string &key : kAwkwardKeys) put_object("photos", key);
    json keys = json::array();
    for (const std::string &key : kAwkwardKeys) keys.push_back(key);
    keys.push_back("missing");
    keys.push_back("");
    const Response response = call("POST", "/api/buckets/photos/delete", json{{"keys", keys}}.dump());
    ASSERT_EQ(response.status, 200) << response.body;
    const json body = parse(response);
    EXPECT_EQ(body["deleted"].size(), kAwkwardKeys.size() + 1);
    ASSERT_EQ(body["errors"].size(), 1u);
    EXPECT_EQ(body["errors"][0]["key"], "");
    EXPECT_EQ(body["errors"][0]["code"], "InvalidArgument");
    for (const std::string &key : kAwkwardKeys) EXPECT_FALSE(micros3::objects::find(store, "photos", key)) << key;
}

TEST_F(UiApi, DeleteObjectsErrors) {
    expect_error(call("POST", "/api/buckets/nope/delete", R"({"keys":["a"]})"), 404, "NoSuchBucket");
    make_bucket("photos");
    put_object("photos", "a");
    expect_error(call("POST", "/api/buckets/photos/delete", "nope"), 400, "MalformedJSON");
    expect_error(call("POST", "/api/buckets/photos/delete", R"({"keys":"a"})"), 400, "MalformedJSON");
    expect_error(call("POST", "/api/buckets/photos/delete", R"({"keys":["a",1]})"), 400, "MalformedJSON");
    json many = json::array();
    for (int i = 0; i < 1001; ++i) many.push_back("a");
    expect_error(call("POST", "/api/buckets/photos/delete", json{{"keys", many}}.dump()), 400, "MalformedJSON");
    EXPECT_TRUE(micros3::objects::find(store, "photos", "a"));
    many.erase(many.begin());
    EXPECT_EQ(call("POST", "/api/buckets/photos/delete", json{{"keys", many}}.dump()).status, 200);
    EXPECT_FALSE(micros3::objects::find(store, "photos", "a"));
    expect_error(call("GET", "/api/buckets/photos/delete"), 405, "MethodNotAllowed");
}

TEST_F(UiApi, CopyObject) {
    make_bucket("photos");
    make_bucket("backup");
    put_object("photos", "a/cat.jpg");
    ASSERT_EQ(micros3::objects::update_headers(store, "photos", "a/cat.jpg", {{"Content-Type", "image/jpeg"}}),
              micros3::objects::UpdateResult::Updated);
    for (const std::string &key : kAwkwardKeys) {
        const json request = {{"source", {{"bucket", "photos"}, {"key", "a/cat.jpg"}}},
                              {"destination", {{"bucket", "backup"}, {"key", key}}}};
        const Response response = call("POST", "/api/buckets/photos/copy", request.dump());
        ASSERT_EQ(response.status, 200) << key << ": " << response.body;
        const json body = parse(response);
        EXPECT_EQ(body["key"], key);
        EXPECT_EQ(body["size"], 1);
        EXPECT_EQ(body["etag"], "\"etag\"");
        const auto copy = micros3::objects::find(store, "backup", key);
        ASSERT_TRUE(copy) << key;
        EXPECT_EQ(body["lastModified"], micros3::clock::iso8601(copy->last_modified_ms));
        EXPECT_EQ(copy->headers, (micros3::http::Headers{{"Content-Type", "image/jpeg"}}));
    }
    EXPECT_TRUE(micros3::objects::find(store, "photos", "a/cat.jpg"));
}

TEST_F(UiApi, CopyDefaultsToThePathBucket) {
    make_bucket("photos");
    put_object("photos", "a");
    const Response response =
        call("POST", "/api/buckets/photos/copy", R"({"source":{"key":"a"},"destination":{"key":"b"}})");
    ASSERT_EQ(response.status, 200) << response.body;
    EXPECT_TRUE(micros3::objects::find(store, "photos", "a"));
    EXPECT_TRUE(micros3::objects::find(store, "photos", "b"));
}

TEST_F(UiApi, MoveObject) {
    make_bucket("photos");
    make_bucket("backup");
    const std::string key = "<script>x</script> 100%/caf\xc3\xa9";
    put_object("photos", key);
    const json request = {{"source", {{"bucket", "photos"}, {"key", key}}},
                          {"destination", {{"bucket", "backup"}, {"key", "moved/" + key}}},
                          {"move", true}};
    const Response response = call("POST", "/api/buckets/photos/copy", request.dump());
    ASSERT_EQ(response.status, 200) << response.body;
    EXPECT_EQ(parse(response)["key"], "moved/" + key);
    EXPECT_FALSE(micros3::objects::find(store, "photos", key));
    EXPECT_TRUE(micros3::objects::find(store, "backup", "moved/" + key));
}

TEST_F(UiApi, CopyErrors) {
    make_bucket("photos");
    put_object("photos", "a");
    const std::string path = "/api/buckets/photos/copy";
    expect_error(call("POST", path, "nope"), 400, "MalformedJSON");
    expect_error(call("POST", path, R"({"destination":{"key":"b"}})"), 400, "MalformedJSON");
    expect_error(call("POST", path, R"({"source":{"key":"a"}})"), 400, "MalformedJSON");
    expect_error(call("POST", path, R"({"source":{"key":"a"},"destination":{"key":2}})"), 400, "MalformedJSON");
    expect_error(call("POST", path, R"({"source":{"key":"a"},"destination":{"key":"b"},"move":"yes"})"), 400,
                 "MalformedJSON");
    expect_error(call("POST", path, R"({"source":{"key":"a"},"destination":{"key":""}})"), 400, "InvalidArgument");
    expect_error(call("POST", path,
                      json{{"source", {{"key", "a"}}}, {"destination", {{"key", std::string(1025, 'k')}}}}.dump()),
                 400, "KeyTooLongError");
    expect_error(call("POST", path, R"({"source":{"key":"missing"},"destination":{"key":"b"}})"), 404, "NoSuchKey");
    expect_error(call("POST", path, R"({"source":{"key":"a"},"destination":{"bucket":"nope","key":"b"}})"), 404,
                 "NoSuchBucket");
    expect_error(call("POST", path, R"({"source":{"bucket":"nope","key":"a"},"destination":{"key":"b"}})"), 404,
                 "NoSuchBucket");
    expect_error(call("POST", path, R"({"source":{"key":"a"},"destination":{"key":"a"},"move":true})"), 400,
                 "InvalidRequest");
    EXPECT_TRUE(micros3::objects::find(store, "photos", "a"));
    expect_error(call("GET", path), 405, "MethodNotAllowed");
}

} // namespace
