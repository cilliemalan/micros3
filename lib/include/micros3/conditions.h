#pragma once

// Conditional requests (RFC 9110 section 13) and single byte ranges (section
// 14), as GetObject, HeadObject and CopyObject use them.

#include <cstdint>
#include <optional>
#include <string_view>

namespace micros3::conditions {

// The four precondition headers. For CopyObject these are the
// x-amz-copy-source-if-* headers.
struct Preconditions {
    std::optional<std::string_view> if_match;
    std::optional<std::string_view> if_unmodified_since;
    std::optional<std::string_view> if_none_match;
    std::optional<std::string_view> if_modified_since;
};

enum class Outcome {
    Proceed,
    // If-None-Match or If-Modified-Since failed: 304 for GET and HEAD.
    NotModified,
    // If-Match or If-Unmodified-Since failed: 412.
    PreconditionFailed,
};

// Evaluates the preconditions in RFC 9110 section 13.2.2 order against an
// existing representation with the quoted `etag`. If-Unmodified-Since is
// ignored when If-Match is present, and If-Modified-Since when If-None-Match
// is. Dates compare at one-second resolution; a date that is not an
// IMF-fixdate, or lies after `now_ms`, is ignored.
Outcome evaluate(const Preconditions &conditions, std::string_view etag, std::int64_t last_modified_ms,
                 std::int64_t now_ms);

// True when the comma-separated entity-tag list `header` contains `etag` or
// is `*`. With `weak`, W/ prefixes are ignored (If-None-Match); otherwise weak
// tags never match (If-Match). Unquoted tags are accepted as if quoted.
bool etag_matches(std::string_view header, std::string_view etag, bool weak);

// An inclusive byte range within an object.
struct ByteRange {
    std::uint64_t first = 0;
    std::uint64_t last = 0;
    std::uint64_t length() const { return last - first + 1; }
};

enum class RangeKind {
    // No Range header, or one that is ignored: the whole object, 200.
    Whole,
    // One satisfiable range: 206 with Content-Range.
    Partial,
    // 416 InvalidRange.
    Unsatisfiable,
};

struct RangeResult {
    RangeKind kind = RangeKind::Whole;
    ByteRange range;
};

// Interprets a Range header for an object of `size` bytes. Only one range in
// the `bytes` unit is honored: `bytes=a-b`, `bytes=a-` or `bytes=-n`. A header
// with several ranges, another unit or invalid syntax is ignored (D6).
RangeResult parse_range(std::optional<std::string_view> header, std::uint64_t size);

} // namespace micros3::conditions
