#include "micros3/sigv4.h"

#include "micros3/url.h"

#include <algorithm>
#include <utility>

namespace micros3::sigv4 {

namespace {

bool is_space(char c) { return c == ' ' || c == '\t'; }

std::string_view trim(std::string_view text) {
    while (!text.empty() && is_space(text.front())) text.remove_prefix(1);
    while (!text.empty() && is_space(text.back())) text.remove_suffix(1);
    return text;
}

bool all_of(std::string_view text, bool (*pred)(char)) {
    return std::all_of(text.begin(), text.end(), pred);
}

bool is_digit(char c) { return c >= '0' && c <= '9'; }
bool is_lower_hex(char c) { return is_digit(c) || (c >= 'a' && c <= 'f'); }
bool is_header_name_char(char c) {
    return (c >= 'a' && c <= 'z') || is_digit(c) || c == '-' || c == '_' || c == '.';
}

int hex_value(char c) {
    if (is_digit(c)) return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

std::optional<digest::Sha256Digest> parse_sha256_hex(std::string_view text) {
    if (text.size() != 64) return std::nullopt;
    digest::Sha256Digest out{};
    for (std::size_t i = 0; i < out.size(); ++i) {
        const int hi = hex_value(text[2 * i]);
        const int lo = hex_value(text[2 * i + 1]);
        if (hi < 0 || lo < 0) return std::nullopt;
        out[i] = static_cast<std::uint8_t>(hi * 16 + lo);
    }
    return out;
}

// "YYYYMMDDTHHMMSSZ"
bool is_amz_date(std::string_view text) {
    return text.size() == 16 && all_of(text.substr(0, 8), is_digit) && text[8] == 'T' &&
           all_of(text.substr(9, 6), is_digit) && text[15] == 'Z';
}

std::vector<std::string_view> split(std::string_view text, char separator) {
    std::vector<std::string_view> parts;
    std::size_t start = 0;
    for (;;) {
        const std::size_t end = text.find(separator, start);
        parts.push_back(text.substr(start, end == std::string_view::npos ? std::string_view::npos : end - start));
        if (end == std::string_view::npos) break;
        start = end + 1;
    }
    return parts;
}

S3Error access_denied(std::string message) { return {403, "AccessDenied", std::move(message)}; }

S3Error malformed(std::string message) { return {400, "AuthorizationHeaderMalformed", std::move(message)}; }

S3Error does_not_match() {
    return {403, "SignatureDoesNotMatch",
            "The request signature we calculated does not match the signature you provided. Check your key and "
            "signing method."};
}

} // namespace

std::optional<Authorization> parse_authorization(std::string_view value) {
    value = trim(value);
    if (value.substr(0, kAlgorithm.size()) != kAlgorithm) return std::nullopt;
    value.remove_prefix(kAlgorithm.size());
    if (value.empty() || !is_space(value.front())) return std::nullopt;

    std::optional<std::string_view> credential, signed_headers, signature;
    for (std::string_view part : split(value, ',')) {
        part = trim(part);
        const std::size_t eq = part.find('=');
        if (eq == std::string_view::npos) return std::nullopt;
        const std::string_view name = part.substr(0, eq);
        const std::string_view text = part.substr(eq + 1);
        std::optional<std::string_view> *slot = name == "Credential"      ? &credential
                                                : name == "SignedHeaders" ? &signed_headers
                                                : name == "Signature"     ? &signature
                                                                          : nullptr;
        if (slot == nullptr || slot->has_value()) return std::nullopt;
        *slot = text;
    }
    if (!credential || !signed_headers || !signature) return std::nullopt;

    Authorization auth;
    // Credential=<key id>/<date>/<region>/<service>/aws4_request. The key ID
    // cannot contain `/`, so split from the left.
    const auto scope = split(*credential, '/');
    if (scope.size() != 5 || scope[0].empty() || scope[4] != "aws4_request") return std::nullopt;
    if (scope[1].size() != 8 || !all_of(scope[1], is_digit) || scope[2].empty() || scope[3].empty()) {
        return std::nullopt;
    }
    auth.access_key_id = scope[0];
    auth.date = scope[1];
    auth.region = scope[2];
    auth.service = scope[3];

    if (signed_headers->empty()) return std::nullopt;
    for (std::string_view name : split(*signed_headers, ';')) {
        if (name.empty() || !all_of(name, is_header_name_char)) return std::nullopt;
        auth.signed_headers.emplace_back(name);
    }
    auth.signed_headers_text = *signed_headers;

    if (signature->size() != 64 || !all_of(*signature, is_lower_hex)) return std::nullopt;
    auth.signature = *signature;
    return auth;
}

std::string uri_encode(std::string_view bytes, bool keep_slash) {
    static constexpr char kHex[] = "0123456789ABCDEF";
    std::string out;
    out.reserve(bytes.size());
    for (const char c : bytes) {
        const auto u = static_cast<unsigned char>(c);
        if ((u >= 'A' && u <= 'Z') || (u >= 'a' && u <= 'z') || (u >= '0' && u <= '9') || u == '-' || u == '_' ||
            u == '.' || u == '~' || (keep_slash && u == '/')) {
            out.push_back(c);
        } else {
            out.push_back('%');
            out.push_back(kHex[u >> 4]);
            out.push_back(kHex[u & 0xF]);
        }
    }
    return out;
}

std::optional<std::string> canonical_uri(std::string_view raw_path) {
    std::string out;
    bool first = true;
    for (std::string_view segment : split(raw_path, '/')) {
        if (!first) out.push_back('/');
        first = false;
        auto decoded = url::decode(segment, false);
        if (!decoded) return std::nullopt;
        out += uri_encode(*decoded);
    }
    if (out.empty()) out = "/";
    return out;
}

std::optional<std::string> canonical_query(std::string_view raw_query) {
    std::vector<std::pair<std::string, std::string>> pairs;
    for (std::string_view segment : split(raw_query, '&')) {
        if (segment.empty()) continue;
        const std::size_t eq = segment.find('=');
        auto name = url::decode(segment.substr(0, eq), false);
        auto value = url::decode(eq == std::string_view::npos ? std::string_view() : segment.substr(eq + 1), false);
        if (!name || !value) return std::nullopt;
        pairs.emplace_back(uri_encode(*name), uri_encode(*value));
    }
    std::sort(pairs.begin(), pairs.end());
    std::string out;
    for (const auto &[name, value] : pairs) {
        if (!out.empty()) out.push_back('&');
        out += name;
        out.push_back('=');
        out += value;
    }
    return out;
}

std::string canonical_header_value(std::string_view value) {
    value = trim(value);
    std::string out;
    out.reserve(value.size());
    for (const char c : value) {
        if (is_space(c)) {
            if (out.back() != ' ') out.push_back(' ');
        } else {
            out.push_back(c);
        }
    }
    return out;
}

std::optional<std::string> canonical_request(const http::Request &request,
                                             const std::vector<std::string> &signed_headers,
                                             std::string_view payload_hash) {
    auto uri = canonical_uri(request.path);
    auto query = canonical_query(request.query);
    if (!uri || !query) return std::nullopt;

    std::string out = request.method + "\n" + *uri + "\n" + *query + "\n";
    std::string list;
    for (const std::string &name : signed_headers) {
        bool found = false;
        std::string values;
        for (const auto &[key, value] : request.headers) {
            if (key != name) continue;
            if (found) values.push_back(',');
            values += canonical_header_value(value);
            found = true;
        }
        if (!found) return std::nullopt;
        out += name + ":" + values + "\n";
        if (!list.empty()) list.push_back(';');
        list += name;
    }
    out += "\n" + list + "\n";
    out += payload_hash;
    return out;
}

std::string string_to_sign(std::string_view amz_date, std::string_view scope, std::string_view canonical_request) {
    std::string out(kAlgorithm);
    out += "\n";
    out += amz_date;
    out += "\n";
    out += scope;
    out += "\n";
    out += digest::hex(digest::sha256(canonical_request));
    return out;
}

digest::Sha256Digest signing_key(std::string_view secret, std::string_view date, std::string_view region,
                                 std::string_view service) {
    const auto as_view = [](const digest::Sha256Digest &d) {
        return std::string_view(reinterpret_cast<const char *>(d.data()), d.size());
    };
    const digest::Sha256Digest k_date = digest::hmac_sha256("AWS4" + std::string(secret), date);
    const digest::Sha256Digest k_region = digest::hmac_sha256(as_view(k_date), region);
    const digest::Sha256Digest k_service = digest::hmac_sha256(as_view(k_region), service);
    return digest::hmac_sha256(as_view(k_service), "aws4_request");
}

std::string signature(const digest::Sha256Digest &key, std::string_view string_to_sign) {
    const std::string_view key_view(reinterpret_cast<const char *>(key.data()), key.size());
    return digest::hex(digest::hmac_sha256(key_view, string_to_sign));
}

std::string authorization_header(const http::Request &request, const Credentials &credentials,
                                 std::string_view region, std::vector<std::string> signed_headers) {
    std::sort(signed_headers.begin(), signed_headers.end());
    const std::string amz_date(request.header("x-amz-date").value_or(""));
    const std::string date = amz_date.substr(0, 8);
    const std::string payload_hash(request.header("x-amz-content-sha256").value_or(kUnsignedPayload));
    const std::string canonical = canonical_request(request, signed_headers, payload_hash).value_or("");
    const std::string scope = date + "/" + std::string(region) + "/s3/aws4_request";
    const std::string sig = signature(signing_key(credentials.secret_access_key, date, region, "s3"),
                                      string_to_sign(amz_date, scope, canonical));
    std::string list;
    for (const std::string &name : signed_headers) {
        if (!list.empty()) list.push_back(';');
        list += name;
    }
    return std::string(kAlgorithm) + " Credential=" + credentials.access_key_id + "/" + scope +
           ", SignedHeaders=" + list + ", Signature=" + sig;
}

bool constant_time_equal(std::string_view a, std::string_view b) {
    if (a.size() != b.size()) return false;
    unsigned char diff = 0;
    for (std::size_t i = 0; i < a.size(); ++i) {
        diff |= static_cast<unsigned char>(a[i] ^ b[i]);
    }
    return diff == 0;
}

std::variant<PayloadCheck, S3Error> authenticate(const http::Request &request, const Credentials &credentials) {
    const auto header = request.header("authorization");
    if (!header) {
        return access_denied(request.query.find("X-Amz-Signature") != std::string::npos
                                 ? "Query-string authentication is not supported."
                                 : "Access Denied");
    }
    if (trim(*header).substr(0, kAlgorithm.size()) != kAlgorithm) {
        return S3Error{400, "InvalidArgument",
                       "The authorization mechanism you have provided is not supported. Please use "
                       "AWS4-HMAC-SHA256."};
    }
    const auto auth = parse_authorization(*header);
    if (!auth) return malformed("The authorization header is malformed.");
    if (!constant_time_equal(auth->access_key_id, credentials.access_key_id)) {
        return S3Error{403, "InvalidAccessKeyId",
                       "The AWS Access Key Id you provided does not exist in our records."};
    }
    if (auth->service != "s3") {
        return malformed("The authorization header is malformed; incorrect service \"" + auth->service +
                         "\". This endpoint belongs to \"s3\".");
    }
    if (!std::is_sorted(auth->signed_headers.begin(), auth->signed_headers.end()) ||
        std::find(auth->signed_headers.begin(), auth->signed_headers.end(), "host") == auth->signed_headers.end()) {
        return does_not_match();
    }

    const auto amz_date = request.header("x-amz-date");
    if (!amz_date || !is_amz_date(*amz_date)) {
        return access_denied("AWS authentication requires a valid Date or x-amz-date header");
    }
    if (amz_date->substr(0, 8) != auth->date) {
        return malformed("The authorization header is malformed; the credential date does not match "
                         "x-amz-date.");
    }

    const auto payload_hash = request.header("x-amz-content-sha256");
    if (!payload_hash) {
        return S3Error{400, "InvalidRequest", "Missing required header for this request: x-amz-content-sha256"};
    }
    PayloadCheck check;
    if (*payload_hash != kUnsignedPayload) {
        if (payload_hash->substr(0, 10) == "STREAMING-") {
            return not_implemented("Streaming (aws-chunked) payload signing is not implemented.");
        }
        check.expected = parse_sha256_hex(*payload_hash);
        if (!check.expected) {
            return S3Error{400, "InvalidArgument",
                           "x-amz-content-sha256 must be UNSIGNED-PAYLOAD or a valid SHA-256 value."};
        }
    }

    const auto canonical = canonical_request(request, auth->signed_headers, *payload_hash);
    if (!canonical) return does_not_match();
    const std::string scope = auth->date + "/" + auth->region + "/" + auth->service + "/aws4_request";
    const std::string expected =
        signature(signing_key(credentials.secret_access_key, auth->date, auth->region, auth->service),
                  string_to_sign(*amz_date, scope, *canonical));
    if (!constant_time_equal(expected, auth->signature)) return does_not_match();
    return check;
}

S3Error content_sha256_mismatch() {
    return {400, "XAmzContentSHA256Mismatch",
            "The provided 'x-amz-content-sha256' header does not match what was computed."};
}

} // namespace micros3::sigv4
