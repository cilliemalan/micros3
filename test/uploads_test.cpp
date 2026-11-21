// Tests for multipart upload rows: IDs, ETags, parts and listing.

#include "micros3/uploads.h"

#include "temp_dir.h"

#include <gtest/gtest.h>

#include <filesystem>
#include <fstream>
#include <regex>
#include <sstream>

namespace fs = std::filesystem;
using namespace micros3;

namespace {

struct Fixture {
    test::TempDir dir;
    Store store{dir.path()};
    Fixture() { store.db().exec("INSERT INTO buckets (name, created_ms) VALUES ('bucket', 0)"); }

    uploads::Upload create(const std::string &key, std::int64_t initiated_ms = 1000) {
        uploads::Upload upload;
        upload.upload_id = uploads::new_upload_id(initiated_ms);
        upload.bucket = "bucket";
        upload.key = key;
        upload.initiated_ms = initiated_ms;
        upload.headers = {{"Content-Type", "text/plain"}};
        EXPECT_TRUE(uploads::create(store, upload));
        return upload;
    }

    // Stages and commits a blob holding `data`, returning its id.
    std::string blob(const std::string &data) {
        objects::StagedBlob staged(store);
        staged.write(data);
        return staged.commit();
    }

    uploads::Part part(int number, const std::string &data) {
        uploads::Part p;
        p.number = number;
        p.blob_id = blob(data);
        p.size = data.size();
        p.etag = "\"" + std::to_string(number) + "\"";
        p.last_modified_ms = 5;
        return p;
    }

    std::size_t blob_count() const {
        return static_cast<std::size_t>(std::distance(fs::directory_iterator(store.blobs_dir()), {}));
    }
};

std::vector<std::string> keys_of(const uploads::ListPage &page) {
    std::vector<std::string> keys;
    for (const auto &entry : page.entries) keys.push_back((entry.is_prefix ? "P:" : "") + entry.key);
    return keys;
}

} // namespace

TEST(Uploads, MultipartEtagIsMd5OfPartMd5s) {
    // md5("hello") and md5("world"); the expected value is md5 of their bytes.
    EXPECT_EQ(uploads::multipart_etag({"\"5d41402abc4b2a76b9719d911017c592\"", "\"7d793037a0760186574b0282f2f435e7\""}),
              "\"065947336a2f2a95ba8899f3675c3be6-2\"");
    EXPECT_EQ(uploads::multipart_etag({"\"5D41402ABC4B2A76B9719D911017C592\""}),
              uploads::multipart_etag({"\"5d41402abc4b2a76b9719d911017c592\""}));
    EXPECT_EQ(uploads::multipart_etag({"5d41402abc4b2a76b9719d911017c592"}), std::nullopt);
    EXPECT_EQ(uploads::multipart_etag({"\"5d41402abc4b2a76b9719d911017c59z\""}), std::nullopt);
}

TEST(Uploads, IdsAreHexAndSortByInitiation) {
    const std::string early = uploads::new_upload_id(1000);
    const std::string late = uploads::new_upload_id(2000);
    EXPECT_TRUE(std::regex_match(early, std::regex("[0-9a-f]{32}"))) << early;
    EXPECT_LT(early, late);
    EXPECT_NE(uploads::new_upload_id(1000), early);
}

TEST(Uploads, CreateNeedsBucketAndFindMatchesBucketAndKey) {
    Fixture f;
    uploads::Upload upload = f.create("a/b");
    uploads::Upload missing = upload;
    missing.bucket = "missing";
    missing.upload_id = uploads::new_upload_id(1);
    EXPECT_FALSE(uploads::create(f.store, missing));

    auto found = uploads::find(f.store, "bucket", "a/b", upload.upload_id);
    ASSERT_TRUE(found);
    EXPECT_EQ(found->initiated_ms, 1000);
    EXPECT_EQ(found->headers, upload.headers);
    EXPECT_FALSE(uploads::find(f.store, "bucket", "a/b/c", upload.upload_id));
    EXPECT_FALSE(uploads::find(f.store, "other", "a/b", upload.upload_id));
}

TEST(Uploads, PartsReplaceAndListInOrder) {
    Fixture f;
    uploads::Upload upload = f.create("key");
    std::optional<std::string> replaced;
    for (int n : {3, 1, 2}) {
        ASSERT_EQ(uploads::put_part(f.store, upload, f.part(n, "x"), replaced), uploads::Result::Done);
        EXPECT_FALSE(replaced);
    }
    uploads::Part again = f.part(1, "new");
    ASSERT_EQ(uploads::put_part(f.store, upload, again, replaced), uploads::Result::Done);
    ASSERT_TRUE(replaced);
    objects::remove_blob(f.store, *replaced);
    EXPECT_EQ(f.blob_count(), 3u);

    auto all = uploads::all_parts(f.store, upload.upload_id);
    ASSERT_EQ(all.size(), 3u);
    EXPECT_EQ(all[0].number, 1);
    EXPECT_EQ(all[0].size, 3u);
    EXPECT_EQ(all[0].blob_id, again.blob_id);
    EXPECT_EQ(all[2].number, 3);
    auto page = uploads::list_parts(f.store, upload.upload_id, 1, 1);
    ASSERT_EQ(page.size(), 1u);
    EXPECT_EQ(page[0].number, 2);

    uploads::Upload gone = upload;
    gone.upload_id = "missing";
    EXPECT_EQ(uploads::put_part(f.store, gone, f.part(1, "y"), replaced), uploads::Result::NoSuchUpload);
}

TEST(Uploads, AbortRemovesRowsAndBlobs) {
    Fixture f;
    uploads::Upload upload = f.create("key");
    std::optional<std::string> replaced;
    uploads::put_part(f.store, upload, f.part(1, "a"), replaced);
    uploads::put_part(f.store, upload, f.part(2, "b"), replaced);
    EXPECT_EQ(uploads::abort(f.store, upload), uploads::Result::Done);
    EXPECT_EQ(f.blob_count(), 0u);
    EXPECT_FALSE(uploads::find(f.store, "bucket", "key", upload.upload_id));
    EXPECT_EQ(uploads::abort(f.store, upload), uploads::Result::NoSuchUpload);
}

TEST(Uploads, CompleteStoresObjectAndRemovesParts) {
    Fixture f;
    objects::Object old;
    old.bucket = "bucket";
    old.key = "key";
    old.blob_id = f.blob("old");
    old.etag = "\"old\"";
    std::optional<std::string> replaced;
    objects::put(f.store, old, replaced);

    uploads::Upload upload = f.create("key");
    uploads::put_part(f.store, upload, f.part(1, "a"), replaced);
    objects::Object object;
    object.bucket = "bucket";
    object.key = "key";
    object.blob_id = f.blob("assembled");
    object.size = 9;
    object.etag = "\"x-1\"";
    object.headers = upload.headers;
    EXPECT_EQ(uploads::complete(f.store, upload, object), uploads::Result::Done);

    // Only the assembled blob is left: the part and the old object are gone.
    EXPECT_EQ(f.blob_count(), 1u);
    auto stored = objects::find(f.store, "bucket", "key");
    ASSERT_TRUE(stored);
    EXPECT_EQ(stored->blob_id, object.blob_id);
    EXPECT_FALSE(uploads::find(f.store, "bucket", "key", upload.upload_id));
    EXPECT_EQ(uploads::complete(f.store, upload, object), uploads::Result::NoSuchUpload);
}

TEST(Uploads, ListOrdersByKeyThenInitiation) {
    Fixture f;
    const auto b = f.create("b", 1);
    const auto a2 = f.create("a", 3);
    const auto a1 = f.create("a", 2);
    auto page = uploads::list(f.store, "bucket", {});
    ASSERT_TRUE(page);
    ASSERT_EQ(page->entries.size(), 3u);
    EXPECT_EQ(page->entries[0].upload_id, a1.upload_id);
    EXPECT_EQ(page->entries[1].upload_id, a2.upload_id);
    EXPECT_EQ(page->entries[2].upload_id, b.upload_id);
    EXPECT_FALSE(page->truncated);
    EXPECT_FALSE(uploads::list(f.store, "missing", {}));

    // Both markers resume within a key; a key marker alone skips the key.
    uploads::ListRequest request;
    request.key_marker = "a";
    request.upload_id_marker = a1.upload_id;
    page = uploads::list(f.store, "bucket", request);
    ASSERT_EQ(page->entries.size(), 2u);
    EXPECT_EQ(page->entries[0].upload_id, a2.upload_id);
    request.upload_id_marker.clear();
    page = uploads::list(f.store, "bucket", request);
    ASSERT_EQ(page->entries.size(), 1u);
    EXPECT_EQ(page->entries[0].key, "b");

    request = {};
    request.max_uploads = 2;
    page = uploads::list(f.store, "bucket", request);
    EXPECT_EQ(page->entries.size(), 2u);
    EXPECT_TRUE(page->truncated);
}

TEST(Uploads, ListRollsUpCommonPrefixes) {
    Fixture f;
    for (const char *key : {"alpha/one", "alpha/sub/a", "alpha/sub/b", "alpha/two", "beta"}) f.create(key);
    uploads::ListRequest request;
    request.prefix = "alpha/";
    request.delimiter = "/";
    auto page = uploads::list(f.store, "bucket", request);
    ASSERT_TRUE(page);
    EXPECT_EQ(keys_of(*page), (std::vector<std::string>{"alpha/one", "P:alpha/sub/", "alpha/two"}));

    // A prefix takes a slot, and a marker naming it resumes after it.
    request.max_uploads = 2;
    page = uploads::list(f.store, "bucket", request);
    EXPECT_EQ(keys_of(*page), (std::vector<std::string>{"alpha/one", "P:alpha/sub/"}));
    EXPECT_TRUE(page->truncated);
    request.key_marker = "alpha/sub/";
    page = uploads::list(f.store, "bucket", request);
    EXPECT_EQ(keys_of(*page), (std::vector<std::string>{"alpha/two"}));
    EXPECT_FALSE(page->truncated);
}
