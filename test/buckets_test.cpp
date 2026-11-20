// Tests for bucket name validation, the bucket rows of the store, and the
// date formats.

#include "micros3/buckets.h"
#include "micros3/clock.h"

#include "temp_dir.h"

#include <gtest/gtest.h>

#include <fstream>

namespace fs = std::filesystem;
namespace buckets = micros3::buckets;
using micros3::Store;
using micros3::test::TempDir;

TEST(BucketName, AcceptsValidNames) {
    for (const char *name : {"abc", "my-bucket", "my.bucket.name", "a1b2c3", "123", "micros3-verify-0a1b2c3d",
                             "xn-abc", "bucket-s3alias-not", "1.2.3", "1.2.3.4.5"}) {
        EXPECT_TRUE(buckets::valid_name(name)) << name;
    }
    EXPECT_TRUE(buckets::valid_name(std::string(63, 'a')));
}

TEST(BucketName, RejectsInvalidNames) {
    for (const char *name : {"", "ab", "My-Bucket", "my_bucket", "micros3_verify_x", "-abc", "abc-", ".abc", "abc.",
                             "a..b", "192.168.5.4", "1.2.3.4", "xn--abc", "sthree-abc", "amzn-s3-demo-abc",
                             "abc-s3alias", "abc--ol-s3", "abc.mrap", "abc--x-s3", "abc--table-s3", "a b c",
                             "abc/def", "ab\xc3\xa9"}) {
        EXPECT_FALSE(buckets::valid_name(name)) << name;
    }
    EXPECT_FALSE(buckets::valid_name(std::string(64, 'a')));
}

TEST(Clock, Iso8601) {
    EXPECT_EQ(micros3::clock::iso8601(0), "1970-01-01T00:00:00.000Z");
    EXPECT_EQ(micros3::clock::iso8601(1795169700123), "2026-11-20T10:15:00.123Z");
    EXPECT_EQ(micros3::clock::iso8601(951782400000), "2000-02-29T00:00:00.000Z");
}

TEST(Clock, HttpDate) {
    EXPECT_EQ(micros3::clock::http_date(0), "Thu, 01 Jan 1970 00:00:00 GMT");
    EXPECT_EQ(micros3::clock::http_date(1795169700999), "Fri, 20 Nov 2026 10:15:00 GMT");
    EXPECT_EQ(micros3::clock::http_date(784111777000), "Sun, 06 Nov 1994 08:49:37 GMT");
}

TEST(Buckets, CreateFindAndRepeat) {
    TempDir tmp;
    Store store(tmp.path());
    EXPECT_FALSE(buckets::find(store, "alpha"));
    EXPECT_FALSE(buckets::create(store, "alpha", "eu-west-1", 1000));
    const auto found = buckets::find(store, "alpha");
    ASSERT_TRUE(found);
    EXPECT_EQ(found->name, "alpha");
    EXPECT_EQ(found->created_ms, 1000);
    EXPECT_EQ(found->region, "eu-west-1");

    const auto repeat = buckets::create(store, "alpha", "us-east-1", 2000);
    ASSERT_TRUE(repeat);
    EXPECT_EQ(repeat->created_ms, 1000);
    EXPECT_EQ(repeat->region, "eu-west-1");
}

TEST(Buckets, ListFiltersAndPages) {
    TempDir tmp;
    Store store(tmp.path());
    for (const char *name : {"bbb", "aaa", "abc", "a_c", "ccc"}) buckets::create(store, name, "us-east-1", 0);
    buckets::create(store, "abd", "eu-west-1", 0);

    auto names = [](const std::vector<buckets::Bucket> &list) {
        std::vector<std::string> out;
        for (const auto &b : list) out.push_back(b.name);
        return out;
    };
    using V = std::vector<std::string>;
    EXPECT_EQ(names(buckets::list(store, "", "", std::nullopt, 100)), (V{"a_c", "aaa", "abc", "abd", "bbb", "ccc"}));
    EXPECT_EQ(names(buckets::list(store, "", "", std::nullopt, 2)), (V{"a_c", "aaa"}));
    EXPECT_EQ(names(buckets::list(store, "", "aaa", std::nullopt, 2)), (V{"abc", "abd"}));
    EXPECT_EQ(names(buckets::list(store, "ab", "", std::nullopt, 100)), (V{"abc", "abd"}));
    // `_` and `%` are not wildcards.
    EXPECT_EQ(names(buckets::list(store, "a_", "", std::nullopt, 100)), (V{"a_c"}));
    EXPECT_EQ(names(buckets::list(store, "", "", std::string("eu-west-1"), 100)), (V{"abd"}));
}

TEST(Buckets, RemoveEmptyMissingAndNonEmpty) {
    TempDir tmp;
    Store store(tmp.path());
    EXPECT_EQ(buckets::remove(store, "nope"), buckets::DeleteResult::NoSuchBucket);

    buckets::create(store, "full", "us-east-1", 0);
    store.db().prepare("INSERT INTO objects VALUES ('full', 'k', 'blob1', 1, 'e', 0, '{}')").run();
    EXPECT_EQ(buckets::remove(store, "full"), buckets::DeleteResult::NotEmpty);
    EXPECT_TRUE(buckets::find(store, "full"));

    buckets::create(store, "empty", "us-east-1", 0);
    EXPECT_EQ(buckets::remove(store, "empty"), buckets::DeleteResult::Deleted);
    EXPECT_FALSE(buckets::find(store, "empty"));
}

TEST(Buckets, RemoveDeletesUploadsPartsAndPartBlobs) {
    TempDir tmp;
    Store store(tmp.path());
    buckets::create(store, "uploads", "us-east-1", 0);
    buckets::create(store, "other", "us-east-1", 0);
    auto &db = store.db();
    db.exec("INSERT INTO uploads VALUES ('u1', 'uploads', 'k', 0, '{}');"
            "INSERT INTO uploads VALUES ('u2', 'other', 'k', 0, '{}');"
            "INSERT INTO parts VALUES ('u1', 1, 'p1', 1, 'e', 0);"
            "INSERT INTO parts VALUES ('u1', 2, 'p2', 1, 'e', 0);"
            "INSERT INTO parts VALUES ('u2', 1, 'p3', 1, 'e', 0);");
    for (const char *blob : {"p1", "p2", "p3"}) std::ofstream(store.blob_path(blob)) << "x";

    EXPECT_EQ(buckets::remove(store, "uploads"), buckets::DeleteResult::Deleted);
    EXPECT_FALSE(fs::exists(store.blob_path("p1")));
    EXPECT_FALSE(fs::exists(store.blob_path("p2")));
    EXPECT_TRUE(fs::exists(store.blob_path("p3")));
    EXPECT_EQ(db.query_text("SELECT count(*) FROM uploads"), "1");
    EXPECT_EQ(db.query_text("SELECT count(*) FROM parts"), "1");
}

TEST(Buckets, OldSchemaGainsRegionColumn) {
    TempDir tmp;
    {
        micros3::db::Database db((tmp.path() / "micros3.db").string());
        db.exec("CREATE TABLE buckets (name TEXT PRIMARY KEY, created_ms INTEGER NOT NULL, cors_xml TEXT);"
                "INSERT INTO buckets (name, created_ms) VALUES ('old', 5)");
    }
    Store store(tmp.path());
    const auto found = buckets::find(store, "old");
    ASSERT_TRUE(found);
    EXPECT_EQ(found->region, "us-east-1");
}
