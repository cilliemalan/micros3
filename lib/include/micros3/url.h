#pragma once

// Percent-decoding and query-string parsing for request URLs.

#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace micros3::url {

// Decodes %XX escapes. When `plus_is_space` is set, `+` decodes to a space
// (form encoding, used in query strings). Returns nullopt when an escape is
// malformed. The result is raw bytes and need not be valid UTF-8.
std::optional<std::string> decode(std::string_view text, bool plus_is_space);

struct QueryParam {
    std::string name;
    std::string value;
    // False for a bare name such as `?uploads`, true for `?uploads=` or `?a=b`.
    bool has_value = false;
};

// A parsed query string, in request order. Names and values are decoded.
class Query {
public:
    Query() = default;
    explicit Query(std::vector<QueryParam> params) : params_(std::move(params)) {}

    // Parses a raw query string (without the leading `?`). Returns nullopt
    // when a name or value has a malformed escape. Empty segments are skipped.
    static std::optional<Query> parse(std::string_view raw);

    bool has(std::string_view name) const;
    // The value of the first parameter called `name`, or nullopt.
    std::optional<std::string> get(std::string_view name) const;
    const std::vector<QueryParam> &params() const { return params_; }

private:
    std::vector<QueryParam> params_;
};

} // namespace micros3::url
