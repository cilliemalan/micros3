// Tests for object rows, stored metadata and staged blobs.

#include "micros3/objects.h"

#include "temp_dir.h"

#include <gtest/gtest.h>

#include <algorithm>
#include <fstream>
#include <sstream>

namespace fs = std::filesystem;
using namespace micros3;

namespace {

struct Fixture {
    test::TempDir dir;
    Store store{dir.path()};
    Fixture() { store.db().exec("INSERT INTO buckets (name, created_ms) VALUES ('bucket', 0)"); }
};

std::string read_file(const fs::path &path) {
    std::ifstream in(path, std::ios::binary);
    std::ostringstream out;
    out << in.rdbuf();
    return out.str();
}

objects::Object make_object(const std::string &key, const std::string &blob) {
    objects::Object object;
    object.bucket = "bucket";
    object.key = key;
    object.blob_id = blob;
    object.size = 3;
    object.etag = "\"e\"";
    object.last_modified_ms = 1234;
    object.headers = {{"Content-Type", "text/plain"}, {"x-amz-meta-a", "b"}};
    return object;
}

} // namespace

TEST(Metadata, CollectsStoredHeadersOnly) {
    http::Request request;
    request.headers = {{"content-type", "text/plain"},    {"cache-control", "max-age=1"},
                       {"content-disposition", "inline"}, {"content-encoding", "gzip"},
                       {"content-language", "en"},        {"expires", "Thu, 01 Jan 2099 00:00:00 GMT"},
                       {"x-amz-meta-purpose", "test"},    {"content-length", "3"},
                       {"x-amz-date", "x"},               {"authorization", "y"}};
    const http::Headers metadata = objects::metadata_from(request);
    const http::Headers expected = {{"Content-Type", "text/plain"},    {"Cache-Control", "max-age=1"},
                                    {"Content-Disposition", "inline"}, {"Content-Encoding", "gzip"},
                                    {"Content-Language", "en"},        {"Expires", "Thu, 01 Jan 2099 00:00:00 GMT"},
                                    {"x-amz-meta-purpose", "test"}};
    EXPECT_EQ(metadata, expected);
    EXPECT_EQ(objects::user_metadata_bytes(metadata), std::string("purposetest").size());
}

TEST(Metadata, JsonRoundTrip) {
    const http::Headers headers = {{"Content-Type", "a/b"}, {"x-amz-meta-quote", "\"q\" \\ \xE9\x9B\xAA"}};
    http::Headers back = objects::headers_from_json(objects::headers_to_json(headers));
    std::sort(back.begin(), back.end());
    EXPECT_EQ(back, headers);
    EXPECT_TRUE(objects::headers_from_json("not json").empty());
}

TEST(ObjectStore, PutFindReplaceRemove) {
    Fixture f;
    const std::string key("nested/\xE9\x9B\xAA \0x", 12);
    std::optional<std::string> replaced;
    ASSERT_EQ(objects::put(f.store, make_object(key, "blob1"), replaced), objects::PutResult::Stored);
    EXPECT_FALSE(replaced);

    auto found = objects::find(f.store, "bucket", key);
    ASSERT_TRUE(found);
    EXPECT_EQ(found->key, key);
    EXPECT_EQ(found->blob_id, "blob1");
    EXPECT_EQ(found->size, 3u);
    EXPECT_EQ(found->etag, "\"e\"");
    EXPECT_EQ(found->last_modified_ms, 1234);
    EXPECT_FALSE(objects::find(f.store, "bucket", key.substr(0, 10)));

    ASSERT_EQ(objects::put(f.store, make_object(key, "blob2"), replaced), objects::PutResult::Stored);
    EXPECT_EQ(replaced, "blob1");
    EXPECT_EQ(objects::find(f.store, "bucket", key)->blob_id, "blob2");

    std::ofstream(f.store.blob_path("blob2")) << "abc";
    EXPECT_EQ(objects::remove(f.store, "bucket", key), objects::DeleteResult::Deleted);
    EXPECT_FALSE(objects::find(f.store, "bucket", key));
    EXPECT_FALSE(fs::exists(f.store.blob_path("blob2")));
    EXPECT_EQ(objects::remove(f.store, "bucket", key), objects::DeleteResult::Deleted);
}

TEST(ObjectStore, MissingBucket) {
    Fixture f;
    std::optional<std::string> replaced;
    objects::Object object = make_object("k", "blob");
    object.bucket = "missing";
    EXPECT_EQ(objects::put(f.store, object, replaced), objects::PutResult::NoSuchBucket);
    EXPECT_EQ(objects::remove(f.store, "missing", "k"), objects::DeleteResult::NoSuchBucket);
}

TEST(ObjectStore, CopyGetsItsOwnBlob) {
    Fixture f;
    f.store.db().exec("INSERT INTO buckets (name, created_ms) VALUES ('other', 0)");
    std::ofstream(f.store.blob_path("src")) << "abc";
    std::optional<std::string> replaced;
    ASSERT_EQ(objects::put(f.store, make_object("src", "src"), replaced), objects::PutResult::Stored);
    std::ofstream(f.store.blob_path("old")) << "old";
    objects::Object existing = make_object("dst", "old");
    existing.bucket = "other";
    ASSERT_EQ(objects::put(f.store, existing, replaced), objects::PutResult::Stored);

    const auto source = objects::find(f.store, "bucket", "src");
    ASSERT_TRUE(source);
    objects::Object copied;
    ASSERT_EQ(objects::copy(f.store, *source, "other", "dst", std::nullopt, copied), objects::CopyResult::Copied);
    EXPECT_EQ(copied.bucket, "other");
    EXPECT_EQ(copied.key, "dst");
    EXPECT_NE(copied.blob_id, "src");
    EXPECT_EQ(copied.etag, source->etag);
    EXPECT_EQ(copied.headers, source->headers);
    EXPECT_GT(copied.last_modified_ms, source->last_modified_ms);
    EXPECT_EQ(read_file(f.store.blob_path(copied.blob_id)), "abc");
    EXPECT_EQ(read_file(f.store.blob_path("src")), "abc");
    EXPECT_FALSE(fs::exists(f.store.blob_path("old"))); // the replaced row's blob
    const auto found = objects::find(f.store, "other", "dst");
    ASSERT_TRUE(found);
    EXPECT_EQ(found->blob_id, copied.blob_id);

    const http::Headers replacement = {{"Content-Type", "image/png"}};
    ASSERT_EQ(objects::copy(f.store, *source, "bucket", "src", replacement, copied), objects::CopyResult::Copied);
    EXPECT_EQ(objects::find(f.store, "bucket", "src")->headers, replacement);
    EXPECT_FALSE(fs::exists(f.store.blob_path("src")));
}

TEST(ObjectStore, CopyToMissingBucketLeavesNoBlob) {
    Fixture f;
    std::ofstream(f.store.blob_path("src")) << "abc";
    std::optional<std::string> replaced;
    ASSERT_EQ(objects::put(f.store, make_object("src", "src"), replaced), objects::PutResult::Stored);
    objects::Object copied;
    EXPECT_EQ(objects::copy(f.store, *objects::find(f.store, "bucket", "src"), "missing", "k", std::nullopt, copied),
              objects::CopyResult::NoSuchBucket);
    EXPECT_TRUE(fs::is_empty(f.store.staging_dir()));
    std::size_t blobs = 0;
    for ([[maybe_unused]] const auto &entry : fs::recursive_directory_iterator(f.store.blobs_dir())) {
        if (entry.is_regular_file()) ++blobs;
    }
    EXPECT_EQ(blobs, 1u);
}

TEST(ObjectStore, UpdateHeadersInPlace) {
    Fixture f;
    const std::string key = "a b/%<script>\xE9";
    std::optional<std::string> replaced;
    ASSERT_EQ(objects::put(f.store, make_object(key, "blob"), replaced), objects::PutResult::Stored);
    const http::Headers headers = {{"Cache-Control", "no-cache"}, {"x-amz-meta-new", "v"}};
    EXPECT_EQ(objects::update_headers(f.store, "bucket", key, headers), objects::UpdateResult::Updated);
    const auto found = objects::find(f.store, "bucket", key);
    ASSERT_TRUE(found);
    http::Headers stored = found->headers;
    std::sort(stored.begin(), stored.end());
    EXPECT_EQ(stored, headers);
    EXPECT_EQ(found->blob_id, "blob");
    EXPECT_EQ(found->etag, "\"e\"");
    EXPECT_EQ(found->last_modified_ms, 1234);
    EXPECT_EQ(found->size, 3u);

    EXPECT_EQ(objects::update_headers(f.store, "bucket", "nope", headers), objects::UpdateResult::NoSuchKey);
    EXPECT_EQ(objects::update_headers(f.store, "missing", key, headers), objects::UpdateResult::NoSuchBucket);
}

TEST(ObjectStore, BlobIdsAreRandomHex) {
    const std::string a = objects::new_blob_id();
    const std::string b = objects::new_blob_id();
    EXPECT_EQ(a.size(), 32u);
    EXPECT_NE(a, b);
    EXPECT_EQ(a.find_first_not_of("0123456789abcdef"), std::string::npos);
}

TEST(StagedBlob, CommitMovesIntoBlobs) {
    Fixture f;
    std::string id;
    {
        objects::StagedBlob blob(f.store);
        blob.write("hello ");
        blob.write("world");
        EXPECT_EQ(blob.size(), 11u);
        EXPECT_TRUE(fs::exists(f.store.staging_dir() / blob.id()));
        id = blob.commit();
        EXPECT_EQ(id, blob.id());
    }
    EXPECT_TRUE(fs::is_empty(f.store.staging_dir()));
    EXPECT_EQ(read_file(f.store.blob_path(id)), "hello world");
}

TEST(StagedBlob, DiscardAndDestructionRemoveTheFile) {
    Fixture f;
    {
        objects::StagedBlob blob(f.store);
        blob.write("partial");
        blob.discard();
        EXPECT_TRUE(fs::is_empty(f.store.staging_dir()));
        blob.discard();
    }
    {
        objects::StagedBlob blob(f.store);
        blob.write("abandoned");
    }
    EXPECT_TRUE(fs::is_empty(f.store.staging_dir()));
    EXPECT_TRUE(fs::is_empty(f.store.blobs_dir()));
}
