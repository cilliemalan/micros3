#pragma once

// Wall-clock time and the two date formats S3 uses.

#include <cstdint>
#include <string>

namespace micros3::clock {

// Milliseconds since the Unix epoch, now.
std::int64_t now_ms();

// ISO 8601 in UTC with milliseconds, as XML bodies use it:
// "2026-11-20T10:15:00.000Z".
std::string iso8601(std::int64_t ms);

// IMF-fixdate (RFC 9110), as headers such as Last-Modified use it:
// "Fri, 20 Nov 2026 10:15:00 GMT". Milliseconds are truncated.
std::string http_date(std::int64_t ms);

} // namespace micros3::clock
