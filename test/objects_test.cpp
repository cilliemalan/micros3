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
