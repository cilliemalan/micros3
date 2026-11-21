#pragma once

// Object rows of the store, their stored metadata headers, and blob files.
//
// A PutObject streams its body into a StagedBlob in staging/. Once the body
// is validated, the blob is fsynced and renamed into blobs/, and then the
// object row is upserted in one transaction. The blob a replaced row referred
// to is deleted after the commit (design.md, "PutObject crash safety").

#include "micros3/http.h"
#include "micros3/store.h"

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace micros3::objects {

// The longest key S3 accepts, in UTF-8 bytes.
inline constexpr std::size_t kMaxKeyBytes = 1024;

// The most user metadata (x-amz-meta-* names without the prefix, plus
// values) S3 accepts, in bytes.
inline constexpr std::size_t kMaxUserMetadataBytes = 2048;

struct Object {
    std::string bucket;
    std::string key; // raw UTF-8 bytes
    std::string blob_id;
    std::uint64_t size = 0;
    std::string etag; // quoted
    std::int64_t last_modified_ms = 0;
    http::Headers headers; // stored metadata headers, see metadata_from()
};

// The metadata headers of a request that an object stores: Content-Type,
// Cache-Control, Content-Disposition, Content-Encoding, Content-Language,
// Expires (with those names) and x-amz-meta-* (in lower case).
http::Headers metadata_from(const http::Request &request);

// The total size of the user metadata in `headers`, as S3 counts it.
std::size_t user_metadata_bytes(const http::Headers &headers);

// The metadata headers as stored in the `headers` column (a JSON object), and
// back again.
std::string headers_to_json(const http::Headers &headers);
http::Headers headers_from_json(std::string_view json);

// The object at `key`, or nullopt.
std::optional<Object> find(Store &store, std::string_view bucket, std::string_view key);

// Upserts the object row, inside a transaction the caller holds, in a bucket
// that exists. Returns the blob id of the row it replaced, if any; the caller
// deletes that file after the commit.
std::optional<std::string> upsert(Store &store, const Object &object);

enum class PutResult { Stored, NoSuchBucket };

// Upserts the object row in one transaction. When it replaces a row, the old
// row's blob id is stored in `replaced_blob`; the caller deletes that file.
PutResult put(Store &store, const Object &object, std::optional<std::string> &replaced_blob);

enum class DeleteResult { Deleted, NoSuchBucket };

// Deletes the object row, then its blob file. A missing key counts as deleted.
DeleteResult remove(Store &store, std::string_view bucket, std::string_view key);

// Deletes the object rows for `keys` in one transaction, then their blob
// files. Missing keys count as deleted.
DeleteResult remove_many(Store &store, std::string_view bucket, const std::vector<std::string> &keys);

enum class CopyResult { Copied, NoSuchBucket };

// Copies `source` (an object row, as find() returned it) to
// `bucket`/`key`. The copy gets a blob of its own and a new last-modified
// time; its ETag is the source's. When `headers` is given it replaces the
// stored metadata headers, otherwise the source's are kept. On success the
// new row is stored in `copied` and the blob of any row it replaced is
// deleted. NoSuchBucket means the destination bucket does not exist.
// Throws std::system_error when the blob cannot be copied.
CopyResult copy(Store &store, const Object &source, std::string_view bucket, std::string_view key,
                const std::optional<http::Headers> &headers, Object &copied);

enum class UpdateResult { Updated, NoSuchBucket, NoSuchKey };

// Replaces the stored metadata headers of an object in place (UI7). The
// blob, size, ETag and last-modified time stay the same. The caller
// validates `headers`.
UpdateResult update_headers(Store &store, std::string_view bucket, std::string_view key,
                            const http::Headers &headers);

// A new random blob id: 32 lowercase hex characters.
std::string new_blob_id();

// Deletes a blob file, ignoring errors. A file left behind is removed by the
// startup scan.
void remove_blob(Store &store, const std::string &blob_id);

// A file in staging/ that becomes a blob. Unless committed, the file is
// deleted when the StagedBlob is destroyed or discarded.
class StagedBlob {
public:
    // Creates staging/<new blob id>. Throws std::system_error on failure.
    explicit StagedBlob(Store &store);
    ~StagedBlob();
    StagedBlob(const StagedBlob &) = delete;
    StagedBlob &operator=(const StagedBlob &) = delete;

    // Appends to the file. Throws std::system_error on failure.
    void write(std::string_view data);
    // Appends the whole of the file at `path`. Throws std::system_error on
    // failure.
    void copy_from(const std::filesystem::path &path);
    std::uint64_t size() const { return size_; }
    const std::string &id() const { return id_; }

    // Fsyncs the file, renames it into blobs/ and fsyncs that directory.
    // Returns the blob id. Throws std::system_error on failure, after
    // deleting the staging file.
    std::string commit();
    // Closes and deletes the staging file. Safe to call more than once.
    void discard();

private:
    Store &store_;
    std::string id_;
    int fd_ = -1;
    std::uint64_t size_ = 0;
    bool done_ = false;
};

} // namespace micros3::objects
