#pragma once

// AWS Signature Version 4 header authentication (design.md, "Authentication").
//
// The server rebuilds the canonical request from the request as received:
// the path and query are decoded and re-encoded the SigV4 way, so a request
// whose target was encoded differently from what the client signed fails.
// Query-string (presigned) signing is not accepted.
//
// See https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html

#include "micros3/digest.h"
#include "micros3/http.h"
#include "micros3/s3error.h"

#include <optional>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

namespace micros3::sigv4 {

inline constexpr std::string_view kAlgorithm = "AWS4-HMAC-SHA256";
inline constexpr std::string_view kUnsignedPayload = "UNSIGNED-PAYLOAD";

struct Credentials {
    std::string access_key_id;
    std::string secret_access_key;
};

// The parts of an `Authorization: AWS4-HMAC-SHA256 ...` header.
struct Authorization {
    std::string access_key_id;
    std::string date;    // YYYYMMDD, from the credential scope
    std::string region;
    std::string service;
    std::vector<std::string> signed_headers; // lower case, as listed
    std::string signed_headers_text;         // the list as sent, `;`-separated
    std::string signature;                   // lowercase hex, 64 characters
};

// Parses a SigV4 Authorization header value. Returns nullopt when malformed.
std::optional<Authorization> parse_authorization(std::string_view value);

// SigV4 URI encoding: every byte except A-Z a-z 0-9 - _ . ~ becomes %XX with
// upper-case hex. With `keep_slash`, `/` is also left as is.
std::string uri_encode(std::string_view bytes, bool keep_slash = false);

// The canonical URI: each `/`-separated segment of the raw path decoded and
// re-encoded. Returns nullopt for a malformed escape.
std::optional<std::string> canonical_uri(std::string_view raw_path);

// The canonical query string: names and values decoded, re-encoded, and
// sorted by name then value. A bare name becomes `name=`. Returns nullopt for
// a malformed escape.
std::optional<std::string> canonical_query(std::string_view raw_query);

// A header value as signed: leading and trailing whitespace removed, and
// internal runs of whitespace collapsed to one space.
std::string canonical_header_value(std::string_view value);

// The canonical request for `request`, signing `signed_headers` (lower case,
// sorted) with `payload_hash` as the hashed payload. Repeated headers are
// joined with `,`. Returns nullopt when the path or query cannot be decoded
// or a signed header is missing.
std::optional<std::string> canonical_request(const http::Request &request,
                                             const std::vector<std::string> &signed_headers,
                                             std::string_view payload_hash);

// "AWS4-HMAC-SHA256\n<amz_date>\n<scope>\n<hex sha256 of canonical request>".
std::string string_to_sign(std::string_view amz_date, std::string_view scope, std::string_view canonical_request);

// The derived signing key, HMAC chained over date, region, service and
// "aws4_request" starting from "AWS4" + secret.
digest::Sha256Digest signing_key(std::string_view secret, std::string_view date, std::string_view region,
                                 std::string_view service);

// Lowercase hex HMAC-SHA256 of `string_to_sign` under `key`.
std::string signature(const digest::Sha256Digest &key, std::string_view string_to_sign);

// Builds the Authorization header value for `request`, signing the given
// headers (which must be present in the request; `x-amz-date` among them and
// `x-amz-content-sha256` giving the payload hash). For tests and tools.
std::string authorization_header(const http::Request &request, const Credentials &credentials,
                                 std::string_view region, std::vector<std::string> signed_headers);

// Compares two strings in time that depends only on their lengths.
bool constant_time_equal(std::string_view a, std::string_view b);

// What the body must hash to once authentication has passed.
struct PayloadCheck {
    // The SHA-256 the body must have, or nullopt for UNSIGNED-PAYLOAD.
    std::optional<digest::Sha256Digest> expected;
};

// Authenticates `request` against the one configured credential pair.
// Errors: AccessDenied (missing signature or date), InvalidAccessKeyId,
// SignatureDoesNotMatch (403); AuthorizationHeaderMalformed, InvalidRequest
// and InvalidArgument (400); NotImplemented (501) for streaming payloads.
std::variant<PayloadCheck, S3Error> authenticate(const http::Request &request, const Credentials &credentials);

// The error for a body whose SHA-256 differs from x-amz-content-sha256.
S3Error content_sha256_mismatch();

} // namespace micros3::sigv4
