#pragma once

// The data directory: the SQLite metadata database and the blob files.
//
//   <data-dir>/
//     micros3.db          SQLite metadata (WAL mode)
//     blobs/<blob-id>     object and part bodies, named by random hex id
//     staging/            uploads in progress, before their rename into blobs/
//
// Opening a store creates whatever is missing, then runs the startup scan:
// every file in staging/ is deleted, as is every file in blobs/ that no
// `objects` or `parts` row refers to.

#include "micros3/db.h"

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <string>

namespace micros3 {

// The largest body S3 accepts in one PutObject or UploadPart: 5 GiB.
inline constexpr std::uint64_t kMaxBodyBytes = std::uint64_t{5} << 30;

// What the startup scan removed.
struct StartupScan {
    std::size_t staging_removed = 0;
    std::size_t orphan_blobs_removed = 0;
};

class Store {
public:
    // Opens or creates the store in `data_dir`. Throws db::Error or
    // std::filesystem::filesystem_error on failure.
    explicit Store(std::filesystem::path data_dir);

    db::Database &db() { return db_; }
    const std::filesystem::path &data_dir() const { return data_dir_; }
    const std::filesystem::path &blobs_dir() const { return blobs_dir_; }
    const std::filesystem::path &staging_dir() const { return staging_dir_; }
    const StartupScan &startup_scan() const { return scan_; }

    // The path of a blob file, from its id.
    std::filesystem::path blob_path(const std::string &blob_id) const { return blobs_dir_ / blob_id; }

    // The largest body a single PutObject or UploadPart may carry, in bytes.
    // Larger bodies are EntityTooLarge. Tests lower it.
    std::uint64_t max_body_bytes() const { return max_body_bytes_; }
    void set_max_body_bytes(std::uint64_t bytes) { max_body_bytes_ = bytes; }

private:
    std::filesystem::path data_dir_;
    std::filesystem::path blobs_dir_;
    std::filesystem::path staging_dir_;
    db::Database db_;
    StartupScan scan_;
    std::uint64_t max_body_bytes_ = kMaxBodyBytes;
};

namespace store {

// Applies the per-connection settings: WAL mode, synchronous=FULL and
// foreign keys on.
void configure(db::Database &db);

// Creates the four tables if they are missing, and adds columns that older
// databases lack (buckets.region).
void create_schema(db::Database &db);

} // namespace store

} // namespace micros3
