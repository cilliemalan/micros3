#include "micros3/clock.h"

#include <chrono>
#include <cstdio>

namespace micros3::clock {

namespace {

struct Civil {
    std::int64_t year;
    int month; // 1..12
    int day;   // 1..31
    int hour, minute, second, millis;
    int weekday; // 0 = Sunday
};

// Howard Hinnant's days-to-civil algorithm, valid for any day count.
Civil to_civil(std::int64_t ms) {
    std::int64_t days = ms / 86400000;
    std::int64_t rem = ms % 86400000;
    if (rem < 0) {
        rem += 86400000;
        --days;
    }
    Civil c{};
    c.millis = static_cast<int>(rem % 1000);
    c.second = static_cast<int>(rem / 1000 % 60);
    c.minute = static_cast<int>(rem / 60000 % 60);
    c.hour = static_cast<int>(rem / 3600000);
    c.weekday = static_cast<int>(((days % 7) + 11) % 7); // 1970-01-01 was a Thursday

    const std::int64_t z = days + 719468;
    const std::int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    const std::int64_t doe = z - era * 146097;
    const std::int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const std::int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const std::int64_t mp = (5 * doy + 2) / 153;
    c.day = static_cast<int>(doy - (153 * mp + 2) / 5 + 1);
    c.month = static_cast<int>(mp < 10 ? mp + 3 : mp - 9);
    c.year = yoe + era * 400 + (c.month <= 2 ? 1 : 0);
    return c;
}

} // namespace

std::int64_t now_ms() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

std::string iso8601(std::int64_t ms) {
    const Civil c = to_civil(ms);
    char buffer[64];
    std::snprintf(buffer, sizeof buffer, "%04lld-%02d-%02dT%02d:%02d:%02d.%03dZ", static_cast<long long>(c.year),
                  c.month, c.day, c.hour, c.minute, c.second, c.millis);
    return buffer;
}

std::string http_date(std::int64_t ms) {
    static constexpr const char *kDays[] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};
    static constexpr const char *kMonths[] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                              "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
    const Civil c = to_civil(ms);
    char buffer[64];
    std::snprintf(buffer, sizeof buffer, "%s, %02d %s %04lld %02d:%02d:%02d GMT", kDays[c.weekday], c.day,
                  kMonths[c.month - 1], static_cast<long long>(c.year), c.hour, c.minute, c.second);
    return buffer;
}

} // namespace micros3::clock
