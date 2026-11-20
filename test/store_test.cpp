// Tests for the SQLite wrapper, the schema and the startup scan.

#include "micros3/store.h"

#include "temp_dir.h"

#include <gtest/gtest.h>

#include <fstream>
#include <random>
#include <string>
#include <vector>

namespace fs = std::filesystem;
using micros3::Store;
using micros3::db::Database;
using micros3::db::Error;
using micros3::db::Statement;
using micros3::db::Transaction;

namespace {

using micros3::test::TempDir;

void touch(const fs::path &path, const std::string &contents = "x") {
    std::ofstream(path, std::ios::binary) << contents;
}

void add_bucket(Database &db, const std::string &name) {
    db.prepare("INSERT INTO buckets (name, created_ms) VALUES (?, 0)").bind_text(1, name).run();
}

void add_object(Database &db, const std::string &bucket, const std::string &key, const std::string &blob) {
    db.prepare("INSERT INTO objects VALUES (?, ?, ?, 1, 'e', 0, '{}')")
        .bind_text(1, bucket)
        .bind_blob(2, key)
        .bind_text(3, blob)
        .run();
}

void add_upload(Database &db, const std::string &id, const std::string &bucket) {
    db.prepare("INSERT INTO uploads VALUES (?, ?, 'k', 0, '{}')").bind_text(1, id).bind_text(2, bucket).run();
}

void add_part(Database &db, const std::string &upload, int number, const std::string &blob) {
    db.prepare("INSERT INTO parts VALUES (?, ?, ?, 1, 'e', 0)")
        .bind_text(1, upload)
        .bind_int(2, number)
        .bind_text(3, blob)
        .run();
}

std::int64_t count(Database &db, const std::string &table) {
    Statement stmt = db.prepare("SELECT count(*) FROM " + table);
    stmt.step();
    return stmt.column_int(0);
}

} // namespace

TEST(Store, CreatesLayout) {
    TempDir tmp;
    const fs::path dir = tmp.path() / "nested" / "data";
    Store store(dir);
    EXPECT_TRUE(fs::is_directory(dir / "blobs"));
    EXPECT_TRUE(fs::is_directory(dir / "staging"));
    EXPECT_TRUE(fs::is_regular_file(dir / "micros3.db"));
    EXPECT_EQ(store.blob_path("abc"), dir / "blobs" / "abc");
}

TEST(Store, ConnectionSettings) {
    TempDir tmp;
    Store store(tmp.path());
    Database &db = store.db();
    EXPECT_EQ(db.query_text("PRAGMA journal_mode"), "wal");
    EXPECT_EQ(db.query_text("PRAGMA synchronous"), "2"); // FULL
    EXPECT_EQ(db.query_text("PRAGMA foreign_keys"), "1");
}

TEST(Store, CreatesTablesAndReopens) {
    TempDir tmp;
    {
        Store store(tmp.path());
        Database &db = store.db();
        for (const char *table : {"buckets", "objects", "uploads", "parts"}) {
            EXPECT_EQ(db.query_text(std::string("SELECT name FROM sqlite_master WHERE type='table' AND name='") +
                                    table + "'"),
                      table);
        }
        add_bucket(db, "b");
    }
    // Reopening keeps the data and does not fail on the existing schema.
    Store store(tmp.path());
    EXPECT_EQ(count(store.db(), "buckets"), 1);
}

TEST(Store, ForeignKeysEnforced) {
    TempDir tmp;
    Store store(tmp.path());
    EXPECT_THROW(add_object(store.db(), "missing", "k", "blob"), Error);
    EXPECT_THROW(add_upload(store.db(), "u", "missing"), Error);
}

TEST(Store, DeletingBucketCascadesToUploadsAndParts) {
    TempDir tmp;
    Store store(tmp.path());
    Database &db = store.db();
    add_bucket(db, "b");
    add_bucket(db, "other");
    add_upload(db, "u1", "b");
    add_upload(db, "u2", "other");
    add_part(db, "u1", 1, "p1");
    add_part(db, "u1", 2, "p2");
    add_part(db, "u2", 1, "p3");

    db.prepare("DELETE FROM buckets WHERE name = ?").bind_text(1, "b").run();
    EXPECT_EQ(count(db, "uploads"), 1);
    EXPECT_EQ(count(db, "parts"), 1);
}

TEST(Store, BucketWithObjectsCannotBeDeleted) {
    TempDir tmp;
    Store store(tmp.path());
    Database &db = store.db();
    add_bucket(db, "b");
    add_object(db, "b", "k", "blob");
    EXPECT_THROW(db.prepare("DELETE FROM buckets WHERE name = 'b'").run(), Error);
}

TEST(Store, KeysSortInByteOrder) {
    TempDir tmp;
    Store store(tmp.path());
    Database &db = store.db();
    add_bucket(db, "b");
    // "Z" < "a" < "\xc3\xa9" (é) < "\xef\xbf\xbd" in UTF-8 byte order.
    add_object(db, "b", "\xc3\xa9", "1");
    add_object(db, "b", "a", "2");
    add_object(db, "b", std::string("a\0b", 3), "3");
    add_object(db, "b", "Z", "4");
    add_object(db, "b", "\xef\xbf\xbd", "5");
    add_object(db, "b", "", "6");

    Statement stmt = db.prepare("SELECT key FROM objects WHERE bucket = 'b' ORDER BY key");
    std::vector<std::string> keys;
    while (stmt.step()) {
        keys.push_back(stmt.column_blob(0));
    }
    const std::vector<std::string> expected = {"", "Z", "a", std::string("a\0b", 3), "\xc3\xa9", "\xef\xbf\xbd"};
    EXPECT_EQ(keys, expected);
}

TEST(Store, TransactionRollsBackUnlessCommitted) {
    TempDir tmp;
    Store store(tmp.path());
    Database &db = store.db();
    {
        Transaction txn(db);
        add_bucket(db, "rolled-back");
    }
    {
        Transaction txn(db);
        add_bucket(db, "kept");
        txn.commit();
    }
    EXPECT_EQ(count(db, "buckets"), 1);
    EXPECT_EQ(db.query_text("SELECT name FROM buckets"), "kept");
}

TEST(Store, StartupScanRemovesStagingAndOrphanBlobs) {
    TempDir tmp;
    {
        Store store(tmp.path());
        Database &db = store.db();
        add_bucket(db, "b");
        add_object(db, "b", "k", "obj-blob");
        add_upload(db, "u", "b");
        add_part(db, "u", 1, "part-blob");
    }
    touch(tmp.path() / "blobs" / "obj-blob", "object");
    touch(tmp.path() / "blobs" / "part-blob", "part");
    touch(tmp.path() / "blobs" / "orphan");
    fs::create_directories(tmp.path() / "blobs" / "stray-dir");
    touch(tmp.path() / "staging" / "upload-1");
    touch(tmp.path() / "staging" / "upload-2");

    Store store(tmp.path());
    EXPECT_EQ(store.startup_scan().staging_removed, 2u);
    EXPECT_EQ(store.startup_scan().orphan_blobs_removed, 2u);
    EXPECT_TRUE(fs::is_empty(tmp.path() / "staging"));
    EXPECT_TRUE(fs::exists(tmp.path() / "blobs" / "obj-blob"));
    EXPECT_TRUE(fs::exists(tmp.path() / "blobs" / "part-blob"));
    EXPECT_FALSE(fs::exists(tmp.path() / "blobs" / "orphan"));
    EXPECT_FALSE(fs::exists(tmp.path() / "blobs" / "stray-dir"));
}

TEST(Store, StatementBindingRoundTrip) {
    TempDir tmp;
    Database db((tmp.path() / "t.db").string());
    db.exec("CREATE TABLE t (a INTEGER, b TEXT, c BLOB)");
    Statement insert = db.prepare("INSERT INTO t VALUES (?, ?, ?)");
    insert.bind_int(1, 1LL << 40).bind_text(2, "text").bind_blob(3, "").run();
    insert.reset();
    insert.bind_null(1).bind_null(2).bind_blob(3, std::string("\0\xff", 2)).run();

    Statement select = db.prepare("SELECT a, b, c, typeof(c) FROM t ORDER BY rowid");
    ASSERT_TRUE(select.step());
    EXPECT_EQ(select.column_int(0), 1LL << 40);
    EXPECT_EQ(select.column_text(1), "text");
    EXPECT_EQ(select.column_blob(2), "");
    EXPECT_EQ(select.column_text(3), "blob"); // an empty blob is not NULL
    ASSERT_TRUE(select.step());
    EXPECT_TRUE(select.column_is_null(0));
    EXPECT_EQ(select.column_blob(2), std::string("\0\xff", 2));
    EXPECT_FALSE(select.step());

    EXPECT_THROW(db.prepare("SELECT nonsense FROM"), Error);
}
