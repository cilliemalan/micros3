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

// Howard Hinnant's days-from-civil algorithm.
std::int64_t days_from_civil(std::int64_t y, int m, int d) {
    y -= m <= 2 ? 1 : 0;
    const std::int64_t era = (y >= 0 ? y : y - 399) / 400;
    const std::int64_t yoe = y - era * 400;
    const std::int64_t doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
    const std::int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + doe - 719468;
}

constexpr const char *kDays[] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};
constexpr const char *kMonths[] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                   "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};

// The value of `count` decimal digits at `pos`, or -1.
int digits(std::string_view text, std::size_t pos, std::size_t count) {
    int value = 0;
    for (std::size_t i = pos; i < pos + count; ++i) {
        if (text[i] < '0' || text[i] > '9') return -1;
        value = value * 10 + (text[i] - '0');
    }
    return value;
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
    const Civil c = to_civil(ms);
    char buffer[64];
    std::snprintf(buffer, sizeof buffer, "%s, %02d %s %04lld %02d:%02d:%02d GMT", kDays[c.weekday], c.day,
                  kMonths[c.month - 1], static_cast<long long>(c.year), c.hour, c.minute, c.second);
    return buffer;
}

std::optional<std::int64_t> parse_http_date(std::string_view text) {
    // "Sun, 06 Nov 1994 08:49:37 GMT"
    //  0123456789012345678901234567 8
    if (text.size() != 29 || text.substr(3, 2) != ", " || text[7] != ' ' || text[11] != ' ' || text[16] != ' ' ||
        text[19] != ':' || text[22] != ':' || text.substr(25) != " GMT") {
        return std::nullopt;
    }
    int weekday = -1;
    for (int i = 0; i < 7; ++i) {
        if (text.substr(0, 3) == kDays[i]) weekday = i;
    }
    int month = 0;
    for (int i = 0; i < 12; ++i) {
        if (text.substr(8, 3) == kMonths[i]) month = i + 1;
    }
    const int day = digits(text, 5, 2);
    const int year = digits(text, 12, 4);
    const int hour = digits(text, 17, 2);
    const int minute = digits(text, 20, 2);
    const int second = digits(text, 23, 2);
    if (weekday < 0 || month == 0 || day < 1 || year < 0 || hour < 0 || hour > 23 || minute < 0 || minute > 59 ||
        second < 0 || second > 60) {
        return std::nullopt;
    }
    static constexpr int kMonthDays[] = {31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    const bool leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    if (day > kMonthDays[month - 1] || (month == 2 && day == 29 && !leap)) return std::nullopt;
    // A leap second is read as the last second of its minute.
    const std::int64_t days = days_from_civil(year, month, day);
    const std::int64_t seconds = days * 86400 + hour * 3600 + minute * 60 + (second == 60 ? 59 : second);
    return seconds * 1000;
}

} // namespace micros3::clock
