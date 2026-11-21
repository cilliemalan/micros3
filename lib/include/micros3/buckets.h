#pragma once

// Bucket names and the bucket rows of the store.

#include "micros3/store.h"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace micros3::buckets {

// True when `name` follows the AWS general purpose bucket naming rules:
// 3 to 63 characters of lowercase letters, digits, dots and hyphens; a letter
// or digit at each end; no adjacent dots; not an IPv4 address; and none of
// the reserved prefixes (`xn--`, `sthree-`, `amzn-s3-demo-`) or suffixes
// (`-s3alias`, `--ol-s3`, `.mrap`, `--x-s3`, `--table-s3`).
bool valid_name(std::string_view name);

// The region a bucket was created in.
inline constexpr std::string_view kDefaultRegion = "us-east-1";

struct Bucket {
    std::string name;
    std::int64_t created_ms = 0;
    std::string region;
};

// The bucket called `name`, or nullopt.
std::optional<Bucket> find(Store &store, std::string_view name);

// Creates a bucket. Returns nullopt when it was created, or the existing
// bucket (unchanged) when one already has that name.
std::optional<Bucket> create(Store &store, std::string_view name, std::string_view region, std::int64_t created_ms);

// Buckets in name order whose names start with `prefix` and sort after
// `after`, optionally only those in `region`. At most `limit` are returned.
std::vector<Bucket> list(Store &store, std::string_view prefix, std::string_view after,
                         const std::optional<std::string> &region, std::size_t limit);

enum class DeleteResult { Deleted, NoSuchBucket, NotEmpty };

// Deletes a bucket that holds no objects, with its multipart uploads and
// their parts (D1). The part blob files are removed after the commit.
DeleteResult remove(Store &store, std::string_view name);

enum class EmptyResult { Emptied, NoSuchBucket };

// Deletes every object in a bucket, in batches of `kEmptyBatch` keys, then
// its multipart uploads and their parts. The bucket itself stays. Blob files
// are removed after each commit.
inline constexpr std::size_t kEmptyBatch = 1000;
EmptyResult empty(Store &store, std::string_view name);

} // namespace micros3::buckets
