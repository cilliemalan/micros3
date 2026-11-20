#include "micros3/conditions.h"

#include "micros3/clock.h"

#include <limits>
#include <string>

namespace micros3::conditions {

namespace {

std::string_view trim(std::string_view text) {
    const std::size_t first = text.find_first_not_of(" \t");
    if (first == std::string_view::npos) return {};
    const std::size_t last = text.find_last_not_of(" \t");
    return text.substr(first, last - first + 1);
}

// The date in whole seconds, or nullopt when it is to be ignored.
std::optional<std::int64_t> usable_date(std::string_view header, std::int64_t now_ms) {
    const auto ms = clock::parse_http_date(trim(header));
    if (!ms || *ms > now_ms) return std::nullopt;
    return *ms / 1000;
}

// Parses decimal digits into `value`. False when empty, not digits, or too big.
bool parse_number(std::string_view text, std::uint64_t &value) {
    if (text.empty()) return false;
    value = 0;
    for (char c : text) {
        if (c < '0' || c > '9') return false;
        const std::uint64_t digit = static_cast<std::uint64_t>(c - '0');
        if (value > (std::numeric_limits<std::uint64_t>::max() - digit) / 10) return false;
        value = value * 10 + digit;
    }
    return true;
}

} // namespace

bool etag_matches(std::string_view header, std::string_view etag, bool weak) {
    std::size_t start = 0;
    while (start <= header.size()) {
        std::size_t comma = header.find(',', start);
        if (comma == std::string_view::npos) comma = header.size();
        std::string_view tag = trim(header.substr(start, comma - start));
        start = comma + 1;
        if (tag.empty()) continue;
        if (tag == "*") return true;
        if (tag.substr(0, 2) == "W/") {
            if (!weak) continue;
            tag.remove_prefix(2);
        }
        if (tag.size() >= 2 && tag.front() == '"' && tag.back() == '"') {
            if (tag == etag) return true;
        } else if (etag.size() >= 2 && tag == etag.substr(1, etag.size() - 2)) {
            return true;
        }
    }
    return false;
}

Outcome evaluate(const Preconditions &conditions, std::string_view etag, std::int64_t last_modified_ms,
                 std::int64_t now_ms) {
    const std::int64_t modified = last_modified_ms / 1000;
    if (conditions.if_match) {
        if (!etag_matches(*conditions.if_match, etag, false)) return Outcome::PreconditionFailed;
    } else if (conditions.if_unmodified_since) {
        const auto date = usable_date(*conditions.if_unmodified_since, now_ms);
        if (date && modified > *date) return Outcome::PreconditionFailed;
    }
    if (conditions.if_none_match) {
        if (etag_matches(*conditions.if_none_match, etag, true)) return Outcome::NotModified;
    } else if (conditions.if_modified_since) {
        const auto date = usable_date(*conditions.if_modified_since, now_ms);
        if (date && modified <= *date) return Outcome::NotModified;
    }
    return Outcome::Proceed;
}

RangeResult parse_range(std::optional<std::string_view> header, std::uint64_t size) {
    RangeResult whole;
    if (!header) return whole;
    std::string_view spec = trim(*header);
    constexpr std::string_view kUnit = "bytes=";
    if (spec.substr(0, kUnit.size()) != kUnit) return whole;
    spec = trim(spec.substr(kUnit.size()));
    if (spec.find(',') != std::string_view::npos) return whole;
    const std::size_t dash = spec.find('-');
    if (dash == std::string_view::npos) return whole;
    const std::string_view first_text = trim(spec.substr(0, dash));
    const std::string_view last_text = trim(spec.substr(dash + 1));

    RangeResult result;
    result.kind = RangeKind::Partial;
    if (first_text.empty()) {
        // bytes=-n: the last n bytes.
        std::uint64_t suffix = 0;
        if (!parse_number(last_text, suffix)) return whole;
        if (suffix == 0 || size == 0) return {RangeKind::Unsatisfiable, {}};
        result.range.first = suffix >= size ? 0 : size - suffix;
        result.range.last = size - 1;
        return result;
    }
    std::uint64_t first = 0;
    if (!parse_number(first_text, first)) return whole;
    std::uint64_t last = std::numeric_limits<std::uint64_t>::max();
    if (!last_text.empty()) {
        if (!parse_number(last_text, last) || last < first) return whole;
    }
    if (first >= size) return {RangeKind::Unsatisfiable, {}};
    result.range.first = first;
    result.range.last = last >= size ? size - 1 : last;
    return result;
}

} // namespace micros3::conditions
