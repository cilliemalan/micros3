#pragma once

// Bucket CORS configurations: parsing and validating a CORSConfiguration
// document, writing it back out, and the `buckets.cors_xml` column that holds
// it. The column keeps the document this module writes, so what is stored has
// always been validated, and rule order (first match wins) is kept.

#include "micros3/http.h"
#include "micros3/s3error.h"
#include "micros3/store.h"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

namespace micros3::cors {

// The most rules one configuration may hold.
inline constexpr std::size_t kMaxRules = 100;

struct Rule {
    std::optional<std::string> id;
    std::vector<std::string> allowed_origins; // at least one
    std::vector<std::string> allowed_methods; // at least one of GET, PUT, HEAD, POST, DELETE
    std::vector<std::string> allowed_headers;
    std::vector<std::string> expose_headers;
    std::optional<std::int64_t> max_age_seconds;

    bool operator==(const Rule &other) const {
        return id == other.id && allowed_origins == other.allowed_origins &&
               allowed_methods == other.allowed_methods && allowed_headers == other.allowed_headers &&
               expose_headers == other.expose_headers && max_age_seconds == other.max_age_seconds;
    }
};

// The rules in order. Never empty once parsed.
using Configuration = std::vector<Rule>;

// Parses a CORSConfiguration body. A document that is not well-formed, has
// the wrong root, no rules, more than kMaxRules rules, a rule without an
// origin or a method, or an unknown or repeated element is MalformedXML. An
// unsupported method, or an origin or header with more than one `*`, is
// InvalidRequest. All errors are 400.
std::variant<Configuration, S3Error> parse(std::string_view body);

// The CORSConfiguration document for `config`, as GetBucketCors returns it.
std::string to_xml(const Configuration &config);

// The stored configuration of a bucket.
struct Lookup {
    bool bucket_exists = false;
    std::optional<Configuration> config; // nullopt when none is set
};
Lookup load(Store &store, std::string_view bucket);

// Replaces (or with nullopt, removes) a bucket's configuration. Returns false
// when the bucket does not exist.
bool save(Store &store, std::string_view bucket, const std::optional<Configuration> &config);

// True when `value` matches `pattern`, in which a single `*` matches any run
// of characters (including none). Header names compare case-insensitively,
// origins exactly.
bool wildcard_match(std::string_view pattern, std::string_view value, bool ignore_case);

// The first rule that allows an actual (non-preflight) request with this
// origin and method, or nullptr.
const Rule *match_request(const Configuration &config, std::string_view origin, std::string_view method);

// A preflight that matched a rule.
struct PreflightMatch {
    const Rule *rule = nullptr;
    std::vector<std::string> headers; // the requested headers, lower case
};

// The first rule that allows a preflight with this origin, requested method
// and `Access-Control-Request-Headers` value (a comma-separated list, each of
// which must match one of the rule's AllowedHeader entries), or nullopt.
std::optional<PreflightMatch> match_preflight(const Configuration &config, std::string_view origin,
                                              std::string_view method, std::string_view request_headers);

// Adds `Access-Control-Allow-Origin` (`*` when the rule allows any origin,
// else `origin` with `Access-Control-Allow-Credentials`), and the rule's
// methods, expose headers and max age, to `response`. `allow_headers` is
// sent as `Access-Control-Allow-Headers` when not empty.
void add_headers(http::Response &response, const Rule &rule, std::string_view origin,
                 const std::vector<std::string> &allow_headers = {});

// Adds `names` to the response's Vary header, keeping any already there.
void add_vary(http::Response &response, std::string_view names);

} // namespace micros3::cors
