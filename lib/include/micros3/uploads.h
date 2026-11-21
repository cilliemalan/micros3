#pragma once

// Multipart uploads and their parts: the `uploads` and `parts` rows of the
// store.
//
// An upload belongs to one bucket and key; a request that names the upload ID
// with another bucket or key does not find it. Part bodies are blobs, staged
// and committed as object bodies are. Completing an upload assembles the
// chosen parts into a new blob, then in one transaction stores the object and
// deletes the upload and part rows; the part blobs are deleted after the
// commit.

#include "micros3/http.h"
#include "micros3/objects.h"
#include "micros3/store.h"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace micros3::uploads {

// The part numbers S3 accepts.
inline constexpr int kMinPartNumber = 1;
inline constexpr int kMaxPartNumber = 10000;

// The smallest size of every part of a completed upload but the last.
inline constexpr std::uint64_t kMinPartSize = 5 * 1024 * 1024;

// The most parts or uploads one listing page returns, and the default.
inline constexpr std::size_t kMaxListing = 1000;

struct Upload {
    std::string upload_id;
    std::string bucket;
    std::string key; // raw UTF-8 bytes
    std::int64_t initiated_ms = 0;
    http::Headers headers; // the metadata headers the object will store
};

struct Part {
    int number = 0;
    std::string blob_id;
    std::uint64_t size = 0;
    std::string etag; // quoted
    std::int64_t last_modified_ms = 0;
};

// A new upload ID: 32 lowercase hex characters. The first 12 are the
// initiation time in milliseconds, so IDs for one key sort in initiation
// order; the rest are random.
std::string new_upload_id(std::int64_t initiated_ms);

// Stores a new upload. Returns false when the bucket does not exist.
bool create(Store &store, const Upload &upload);

// The upload with this ID, bucket and key, or nullopt.
std::optional<Upload> find(Store &store, std::string_view bucket, std::string_view key, std::string_view upload_id);

enum class Result { Done, NoSuchUpload };

// Upserts a part of an upload of `bucket` and `key`, in one transaction. When
// it replaces a part, the old part's blob id is stored in `replaced_blob`; the
// caller deletes that file.
Result put_part(Store &store, const Upload &upload, const Part &part, std::optional<std::string> &replaced_blob);

// Up to `limit` parts with numbers above `after`, in part number order.
std::vector<Part> list_parts(Store &store, std::string_view upload_id, int after, std::size_t limit);

// Every part of the upload, in part number order.
std::vector<Part> all_parts(Store &store, std::string_view upload_id);

// Deletes the upload and its part rows in one transaction, then the part
// blobs.
Result abort(Store &store, const Upload &upload);

// Stores `object` (whose blob is already committed) and deletes the upload
// and part rows in one transaction, then the part blobs and the blob of any
// replaced object. Returns NoSuchUpload, and stores nothing, when the upload
// no longer exists.
Result complete(Store &store, const Upload &upload, const objects::Object &object);

// The multipart ETag: the hex MD5 of the concatenated binary MD5s of the
// parts, then `-` and the part count, quoted. Each part ETag is a quoted hex
// MD5. Returns nullopt when one is not.
std::optional<std::string> multipart_etag(const std::vector<std::string> &part_etags);

// ListMultipartUploads.
struct ListRequest {
    std::string prefix;
    std::string delimiter; // empty for none
    std::string key_marker;
    std::string upload_id_marker; // used only with a key marker
    std::size_t max_uploads = kMaxListing;
};

struct ListEntry {
    // True for a common prefix, which has only `key` (the prefix) set.
    bool is_prefix = false;
    std::string key;
    std::string upload_id;
    std::int64_t initiated_ms = 0;
};

struct ListPage {
    std::vector<ListEntry> entries;
    bool truncated = false;
};

// One page of the uploads of `bucket`, ordered by key bytes and then by upload
// ID (initiation order), or nullopt when the bucket is missing. With a
// delimiter, keys that contain it after the prefix roll up into one common
// prefix entry, which counts towards `max_uploads`. A key marker inside a
// common prefix resumes after the whole prefix.
std::optional<ListPage> list(Store &store, std::string_view bucket, const ListRequest &request);

} // namespace micros3::uploads
