// Tests for object listings: byte order, prefixes, delimiters and markers.

#include "micros3/listing.h"
#include "micros3/objects.h"

#include "temp_dir.h"

#include <gtest/gtest.h>

#include <cstdio>

using namespace micros3;

namespace {

struct Fixture {
    test::TempDir dir;
    Store store{dir.path()};
    Fixture() { store.db().exec("INSERT INTO buckets (name, created_ms) VALUES ('bucket', 0)"); }

    void put(const std::string &key) {
        objects::Object object;
        object.bucket = "bucket";
        object.key = key;
        object.blob_id = objects::new_blob_id();
        object.size = key.size();
        object.etag = "\"e\"";
        object.last_modified_ms = 1000;
        std::optional<std::string> replaced;
        ASSERT_EQ(objects::put(store, object, replaced), objects::PutResult::Stored);
    }

    // Entries as strings, with common prefixes marked by a leading "P:".
    std::vector<std::string> names(const listing::Request &request, bool *truncated = nullptr) {
        auto page = listing::list(store, "bucket", request);
        EXPECT_TRUE(page);
        std::vector<std::string> out;
        for (const auto &entry : page->entries) out.push_back((entry.is_prefix ? "P:" : "") + entry.key);
        if (truncated) *truncated = page->truncated;
        return out;
    }
};

listing::Request req(std::string prefix = "", std::string delimiter = "", std::string after = "",
                     std::size_t max = listing::kMaxKeys) {
    listing::Request r;
    r.prefix = std::move(prefix);
    r.delimiter = std::move(delimiter);
    r.after = std::move(after);
    r.max_keys = max;
    return r;
}

using V = std::vector<std::string>;

} // namespace

TEST(Listing, MissingBucket) {
    Fixture f;
    EXPECT_FALSE(listing::list(f.store, "nope", req()));
    EXPECT_EQ(f.names(req()), V{});
}

TEST(Listing, Utf8ByteOrder) {
    Fixture f;
    // U+FF21 (EF BC A1) sorts before U+1F600 (F0 9F 98 80) in UTF-8, though
    // not in UTF-16; and 0x7F and above sort after ASCII letters.
    for (const char *key : {"\xF0\x9F\x98\x80", "\xEF\xBC\xA1", "z", "A", "a\x7F", "a", "\xC3\xBC"}) f.put(key);
    EXPECT_EQ(f.names(req()), (V{"A", "a", "a\x7F", "z", "\xC3\xBC", "\xEF\xBC\xA1", "\xF0\x9F\x98\x80"}));
}

TEST(Listing, PrefixAndMarker) {
    Fixture f;
    for (const char *key : {"alpha/one", "alpha/two", "beta/x", "root"}) f.put(key);
    EXPECT_EQ(f.names(req("alpha/")), (V{"alpha/one", "alpha/two"}));
    EXPECT_EQ(f.names(req("missing/")), V{});
    EXPECT_EQ(f.names(req("", "", "alpha/two")), (V{"beta/x", "root"}));
    EXPECT_EQ(f.names(req("alpha/", "", "a")), (V{"alpha/one", "alpha/two"}));
    EXPECT_EQ(f.names(req("alpha/", "", "zzz")), V{});
}

TEST(Listing, PagesAndTruncation) {
    Fixture f;
    for (const char *key : {"a", "b", "c"}) f.put(key);
    bool truncated = false;
    EXPECT_EQ(f.names(req("", "", "", 2), &truncated), (V{"a", "b"}));
    EXPECT_TRUE(truncated);
    EXPECT_EQ(f.names(req("", "", "b", 2), &truncated), (V{"c"}));
    EXPECT_FALSE(truncated);
    EXPECT_EQ(f.names(req("", "", "", 3), &truncated), (V{"a", "b", "c"}));
    EXPECT_FALSE(truncated);
    EXPECT_EQ(f.names(req("", "", "", 0), &truncated), V{});
    EXPECT_FALSE(truncated);
}

TEST(Listing, DelimiterRollsUpCommonPrefixes) {
    Fixture f;
    for (const char *key : {"alpha/one.txt", "alpha/sub/second.txt", "alpha/sub/three.txt", "alpha/third/deep.txt",
                            "alpha/two.txt", "beta/four.txt"}) {
        f.put(key);
    }
    EXPECT_EQ(f.names(req("alpha/", "/")),
              (V{"alpha/one.txt", "P:alpha/sub/", "P:alpha/third/", "alpha/two.txt"}));
    EXPECT_EQ(f.names(req("", "/")), (V{"P:alpha/", "P:beta/"}));

    // One entry per page, resuming from the last entry each time.
    bool truncated = false;
    EXPECT_EQ(f.names(req("alpha/", "/", "", 1), &truncated), V{"alpha/one.txt"});
    EXPECT_TRUE(truncated);
    EXPECT_EQ(f.names(req("alpha/", "/", "alpha/one.txt", 1), &truncated), V{"P:alpha/sub/"});
    EXPECT_TRUE(truncated);
    EXPECT_EQ(f.names(req("alpha/", "/", "alpha/sub/", 1), &truncated), V{"P:alpha/third/"});
    EXPECT_TRUE(truncated);
    EXPECT_EQ(f.names(req("alpha/", "/", "alpha/third/", 1), &truncated), V{"alpha/two.txt"});
    EXPECT_FALSE(truncated);

    // A marker inside a common prefix skips the rest of that prefix.
    EXPECT_EQ(f.names(req("alpha/", "/", "alpha/sub/second.txt")), (V{"P:alpha/third/", "alpha/two.txt"}));
}

TEST(Listing, MultiCharacterDelimiter) {
    Fixture f;
    for (const char *key : {"a--b--c", "a--d", "a-e"}) f.put(key);
    EXPECT_EQ(f.names(req("", "--")), (V{"P:a--", "a-e"}));
    EXPECT_EQ(f.names(req("a--", "--")), (V{"P:a--b--", "a--d"}));
}

TEST(Listing, ManyKeysAcrossBatches) {
    Fixture f;
    f.store.db().exec("BEGIN");
    db::Statement insert = f.store.db().prepare(
        "INSERT INTO objects (bucket, key, blob_id, size, etag, last_modified_ms, headers) "
        "VALUES ('bucket', ?, 'b', 0, '\"e\"', 0, '{}')");
    for (int i = 0; i < 2500; ++i) {
        char key[16];
        std::snprintf(key, sizeof key, "k%05d", i);
        insert.reset();
        insert.bind_blob(1, key);
        insert.run();
    }
    f.store.db().exec("COMMIT");
    bool truncated = false;
    auto all = f.names(req("", "", "", 1000), &truncated);
    ASSERT_EQ(all.size(), 1000u);
    EXPECT_TRUE(truncated);
    EXPECT_EQ(all.back(), "k00999");
    all = f.names(req("", "", "k01999", 1000), &truncated);
    ASSERT_EQ(all.size(), 500u);
    EXPECT_FALSE(truncated);
}

TEST(Listing, PrefixEnd) {
    EXPECT_EQ(listing::prefix_end("ab"), "ac");
    EXPECT_EQ(listing::prefix_end("a/"), "a0");
    EXPECT_EQ(listing::prefix_end("a\xFF\xFF"), "b");
    EXPECT_EQ(listing::prefix_end("\xFF"), std::nullopt);
    EXPECT_EQ(listing::prefix_end(""), std::nullopt);
}

TEST(Listing, UrlEncode) {
    EXPECT_EQ(listing::url_encode("a/b-c_d.e~f"), "a/b-c_d.e~f");
    EXPECT_EQ(listing::url_encode("a b+c%&"), "a+b%2Bc%25%26");
    EXPECT_EQ(listing::url_encode("\t\n\x01\x7F"), "%09%0A%01%7F");
    EXPECT_EQ(listing::url_encode("\xE9\x9B\xAA"), "%E9%9B%AA");
}
