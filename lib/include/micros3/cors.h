#pragma once

// Bucket CORS configurations: parsing and validating a CORSConfiguration
// document, writing it back out, and the `buckets.cors_xml` column that holds
// it. The column keeps the document this module writes, so what is stored has
// always been validated, and rule order (first match wins) is kept.

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

} // namespace micros3::cors
