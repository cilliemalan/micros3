#pragma once

// Object listings (ListObjects and ListObjectsV2) over the objects table.
//
// Keys are compared as raw bytes (SQLite BLOB order is memcmp), which is
// UTF-8 code point order. With a delimiter, keys that contain it after the
// prefix roll up into one common prefix entry. An entry's position in the
// listing is its key, or its common prefix, so a marker skips exactly the
// entries that sort at or before it.

#include "micros3/store.h"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace micros3::listing {

// The most entries one page returns, and the default page size.
inline constexpr std::size_t kMaxKeys = 1000;

struct Entry {
    // True for a common prefix, which has only `key` (the prefix) set.
    bool is_prefix = false;
    std::string key;
    std::uint64_t size = 0;
    std::string etag; // quoted
    std::int64_t last_modified_ms = 0;
};

struct Page {
    std::vector<Entry> entries;
    // More entries follow the last one in `entries`.
    bool truncated = false;
};

struct Request {
    std::string prefix;
    std::string delimiter; // empty for none
    std::string after;     // exclusive marker; empty for none
    std::size_t max_keys = kMaxKeys;
};

// One page of the listing of `bucket`, or nullopt when the bucket is missing.
std::optional<Page> list(Store &store, std::string_view bucket, const Request &request);

// The smallest byte string greater than every string that starts with
// `prefix`, or nullopt when there is none (the prefix is all 0xFF bytes or
// empty).
std::optional<std::string> prefix_end(std::string_view prefix);

// URL-encodes a listing value for EncodingType=url: unreserved characters and
// `/` stay as they are, a space becomes `+`, and every other byte is %XX.
std::string url_encode(std::string_view value);

} // namespace micros3::listing
