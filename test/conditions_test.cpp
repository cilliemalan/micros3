// Tests for HTTP dates, preconditions and Range parsing.

#include "micros3/clock.h"
#include "micros3/conditions.h"

#include <gtest/gtest.h>

using namespace micros3::conditions;
using micros3::clock::http_date;
using micros3::clock::parse_http_date;

TEST(HttpDate, ParsesImfFixdate) {
    EXPECT_EQ(parse_http_date("Sun, 06 Nov 1994 08:49:37 GMT"), 784111777000);
    EXPECT_EQ(parse_http_date("Thu, 01 Jan 1970 00:00:00 GMT"), 0);
    EXPECT_EQ(parse_http_date("Thu, 29 Feb 2024 23:59:59 GMT"), 1709251199000);
}

TEST(HttpDate, RoundTripsWithFormatter) {
    for (std::int64_t ms : {0LL, 784111777000LL, 1795213500000LL, 4102444799000LL}) {
        EXPECT_EQ(parse_http_date(http_date(ms)), ms) << http_date(ms);
    }
}

TEST(HttpDate, RejectsOtherForms) {
    for (const char *text : {"", "Sunday, 06-Nov-94 08:49:37 GMT", "Sun Nov  6 08:49:37 1994",
                             "Sun, 06 Nov 1994 08:49:37 UTC", "Sun, 6 Nov 1994 08:49:37 GMT",
                             "Sun, 31 Nov 1994 08:49:37 GMT", "Sun, 29 Feb 2023 08:49:37 GMT",
                             "Sun, 06 Xyz 1994 08:49:37 GMT", "Sun, 06 Nov 1994 24:00:00 GMT",
                             "Abc, 06 Nov 1994 08:49:37 GMT", "Sun, 06 Nov 1994 08:49:37 GMT "}) {
        EXPECT_FALSE(parse_http_date(text).has_value()) << text;
    }
}

TEST(Etags, MatchLists) {
    const std::string etag = "\"abc\"";
    EXPECT_TRUE(etag_matches("\"abc\"", etag, false));
    EXPECT_TRUE(etag_matches("abc", etag, false));
    EXPECT_TRUE(etag_matches("*", etag, false));
    EXPECT_TRUE(etag_matches("\"x\", \"abc\"", etag, false));
    EXPECT_FALSE(etag_matches("\"abcd\"", etag, false));
    EXPECT_FALSE(etag_matches("W/\"abc\"", etag, false));
    EXPECT_TRUE(etag_matches("W/\"abc\"", etag, true));
    EXPECT_FALSE(etag_matches("", etag, true));
}

namespace {

constexpr std::int64_t kModified = 1795213500123; // Fri, 20 Nov 2026 22:25:00.123 GMT
constexpr std::int64_t kNow = kModified + 86400000;
const std::string kEtag = "\"abc\"";
const std::string kAtModified = micros3::clock::http_date(kModified);
const std::string kDayBefore = micros3::clock::http_date(kModified - 86400000);
const std::string kFuture = micros3::clock::http_date(kNow + 86400000);

// Preconditions in evaluation order: If-Match, If-Unmodified-Since,
// If-None-Match, If-Modified-Since.
Preconditions conds(std::optional<std::string_view> if_match, std::optional<std::string_view> if_unmodified_since = {},
                    std::optional<std::string_view> if_none_match = {},
                    std::optional<std::string_view> if_modified_since = {}) {
    return Preconditions{if_match, if_unmodified_since, if_none_match, if_modified_since};
}

Outcome eval(const Preconditions &p) { return evaluate(p, kEtag, kModified, kNow); }

} // namespace

TEST(Preconditions, NoneProceeds) { EXPECT_EQ(eval({}), Outcome::Proceed); }

TEST(Preconditions, IfMatch) {
    EXPECT_EQ(eval(conds(kEtag)), Outcome::Proceed);
    EXPECT_EQ(eval(conds("\"other\"")), Outcome::PreconditionFailed);
}

TEST(Preconditions, IfUnmodifiedSinceAtOneSecondResolution) {
    EXPECT_EQ(eval(conds(std::nullopt, kAtModified)), Outcome::Proceed);
    EXPECT_EQ(eval(conds(std::nullopt, kDayBefore)), Outcome::PreconditionFailed);
    // A matching If-Match overrides a failing If-Unmodified-Since.
    EXPECT_EQ(eval(conds(kEtag, kDayBefore)), Outcome::Proceed);
}

TEST(Preconditions, IfNoneMatch) {
    EXPECT_EQ(eval(conds(std::nullopt, std::nullopt, kEtag)), Outcome::NotModified);
    EXPECT_EQ(eval(conds(std::nullopt, std::nullopt, "*")), Outcome::NotModified);
    EXPECT_EQ(eval(conds(std::nullopt, std::nullopt, "\"other\"")), Outcome::Proceed);
}

TEST(Preconditions, IfModifiedSince) {
    EXPECT_EQ(eval(conds(std::nullopt, std::nullopt, std::nullopt, kAtModified)), Outcome::NotModified);
    EXPECT_EQ(eval(conds(std::nullopt, std::nullopt, std::nullopt, kDayBefore)), Outcome::Proceed);
    // If-None-Match that does not match overrides If-Modified-Since.
    EXPECT_EQ(eval(conds(std::nullopt, std::nullopt, "\"other\"", kAtModified)), Outcome::Proceed);
}

TEST(Preconditions, IfMatchIsEvaluatedFirst) {
    EXPECT_EQ(eval(conds("\"other\"", std::nullopt, kEtag)), Outcome::PreconditionFailed);
}

TEST(Preconditions, BadAndFutureDatesAreIgnored) {
    EXPECT_EQ(eval(conds(std::nullopt, std::nullopt, std::nullopt, "yesterday")), Outcome::Proceed);
    EXPECT_EQ(eval(conds(std::nullopt, "yesterday")), Outcome::Proceed);
    EXPECT_EQ(eval(conds(std::nullopt, std::nullopt, std::nullopt, kFuture)), Outcome::Proceed);
}

namespace {

RangeResult range(const char *header, std::uint64_t size = 7) { return parse_range(header, size); }

void expect_partial(const RangeResult &r, std::uint64_t first, std::uint64_t last) {
    ASSERT_EQ(r.kind, RangeKind::Partial);
    EXPECT_EQ(r.range.first, first);
    EXPECT_EQ(r.range.last, last);
}

} // namespace

TEST(Range, SingleRanges) {
    expect_partial(range("bytes=1-3"), 1, 3);
    expect_partial(range("bytes=4-"), 4, 6);
    expect_partial(range("bytes=-2"), 5, 6);
    expect_partial(range("bytes=0-0"), 0, 0);
    expect_partial(range("bytes=2-100"), 2, 6);
    expect_partial(range("bytes=-100"), 0, 6);
    EXPECT_EQ(range("bytes=1-3").range.length(), 3u);
}

TEST(Range, Unsatisfiable) {
    EXPECT_EQ(range("bytes=100-200").kind, RangeKind::Unsatisfiable);
    EXPECT_EQ(range("bytes=7-").kind, RangeKind::Unsatisfiable);
    EXPECT_EQ(range("bytes=-0").kind, RangeKind::Unsatisfiable);
    EXPECT_EQ(range("bytes=0-0", 0).kind, RangeKind::Unsatisfiable);
    EXPECT_EQ(range("bytes=-5", 0).kind, RangeKind::Unsatisfiable);
}

TEST(Range, IgnoredHeaders) {
    EXPECT_EQ(parse_range(std::nullopt, 7).kind, RangeKind::Whole);
    for (const char *header : {"bytes=0-1,3-4", "items=0-1", "bytes=3-1", "bytes=a-b", "bytes=", "bytes=-",
                               "bytes=1", "0-1", "bytes=99999999999999999999999-"}) {
        EXPECT_EQ(range(header).kind, RangeKind::Whole) << header;
    }
}
