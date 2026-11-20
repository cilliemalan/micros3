#include "micros3/store.h"

#include <set>
#include <utility>

namespace fs = std::filesystem;

namespace micros3 {

namespace {

constexpr const char *kSchema = R"sql(
CREATE TABLE IF NOT EXISTS buckets (
  name TEXT PRIMARY KEY,
  created_ms INTEGER NOT NULL,
  cors_xml TEXT,
  region TEXT NOT NULL DEFAULT 'us-east-1'
);
CREATE TABLE IF NOT EXISTS objects (
  bucket TEXT NOT NULL REFERENCES buckets(name),
  key BLOB NOT NULL,
  blob_id TEXT NOT NULL,
  size INTEGER NOT NULL,
  etag TEXT NOT NULL,
  last_modified_ms INTEGER NOT NULL,
  headers TEXT NOT NULL,
  PRIMARY KEY (bucket, key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS uploads (
  upload_id TEXT PRIMARY KEY,
  bucket TEXT NOT NULL REFERENCES buckets(name) ON DELETE CASCADE,
  key BLOB NOT NULL,
  initiated_ms INTEGER NOT NULL,
  headers TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS parts (
  upload_id TEXT NOT NULL REFERENCES uploads(upload_id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  blob_id TEXT NOT NULL,
  size INTEGER NOT NULL,
  etag TEXT NOT NULL,
  last_modified_ms INTEGER NOT NULL,
  PRIMARY KEY (upload_id, part_number)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS uploads_by_bucket_key ON uploads(bucket, key);
)sql";

fs::path make_dir(const fs::path &path) {
    fs::create_directories(path);
    return path;
}

std::set<std::string> referenced_blobs(db::Database &db) {
    std::set<std::string> ids;
    db::Statement stmt = db.prepare("SELECT blob_id FROM objects UNION SELECT blob_id FROM parts");
    while (stmt.step()) {
        ids.insert(stmt.column_text(0));
    }
    return ids;
}

} // namespace

namespace store {

void configure(db::Database &db) {
    const std::string mode = db.query_text("PRAGMA journal_mode=WAL");
    if (mode != "wal") {
        throw db::Error("cannot enable WAL mode (journal_mode is '" + mode + "')");
    }
    db.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    if (db.query_text("PRAGMA foreign_keys") != "1") {
        throw db::Error("cannot enable foreign keys");
    }
}

void create_schema(db::Database &db) {
    db::Transaction txn(db);
    db.exec(kSchema);
    // Databases created before buckets had a region get the column added.
    bool has_region = false;
    {
        db::Statement columns = db.prepare("SELECT name FROM pragma_table_info('buckets')");
        while (columns.step()) {
            if (columns.column_text(0) == "region") has_region = true;
        }
    }
    if (!has_region) db.exec("ALTER TABLE buckets ADD COLUMN region TEXT NOT NULL DEFAULT 'us-east-1'");
    txn.commit();
}

} // namespace store

Store::Store(fs::path data_dir)
    : data_dir_(make_dir(data_dir)), blobs_dir_(make_dir(data_dir_ / "blobs")),
      staging_dir_(make_dir(data_dir_ / "staging")), db_((data_dir_ / "micros3.db").string()) {
    store::configure(db_);
    store::create_schema(db_);

    for (const fs::directory_entry &entry : fs::directory_iterator(staging_dir_)) {
        scan_.staging_removed += fs::remove_all(entry.path()) > 0 ? 1 : 0;
    }

    const std::set<std::string> referenced = referenced_blobs(db_);
    for (const fs::directory_entry &entry : fs::directory_iterator(blobs_dir_)) {
        if (!entry.is_regular_file() || referenced.count(entry.path().filename().string()) == 0) {
            scan_.orphan_blobs_removed += fs::remove_all(entry.path()) > 0 ? 1 : 0;
        }
    }
}

} // namespace micros3
