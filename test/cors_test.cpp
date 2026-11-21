// Tests for parsing, writing and storing bucket CORS configurations.

#include "micros3/buckets.h"
#include "micros3/cors.h"

#include "temp_dir.h"

#include <gtest/gtest.h>

namespace cors = micros3::cors;

namespace {

std::string rule(const std::string &fields) { return "<CORSRule>" + fields + "</CORSRule>"; }

std::string config(const std::string &rules) {
    return "<CORSConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">" + rules + "</CORSConfiguration>";
}

const std::string kGet = "<AllowedOrigin>https://example.com</AllowedOrigin><AllowedMethod>GET</AllowedMethod>";

std::string error_code(std::string_view body) {
    auto parsed = cors::parse(body);
    if (auto *e = std::get_if<micros3::S3Error>(&parsed)) {
        EXPECT_EQ(e->status, 400);
        return e->code;
    }
    return "";
}

} // namespace

TEST(CorsConfig, ParsesRulesInOrder) {
    auto parsed = cors::parse(config(
        rule("<ID>read</ID><AllowedOrigin>https://app.example.com</AllowedOrigin>"
             "<AllowedOrigin>https://*.example.net</AllowedOrigin><AllowedMethod>GET</AllowedMethod>"
             "<AllowedMethod>HEAD</AllowedMethod><AllowedHeader>x-custom-*</AllowedHeader>"
             "<ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds> 3600 </MaxAgeSeconds>") +
        rule("<AllowedOrigin>*</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><MaxAgeSeconds>0</MaxAgeSeconds>")));
    ASSERT_TRUE(std::holds_alternative<cors::Configuration>(parsed));
    const auto &rules = std::get<cors::Configuration>(parsed);
    ASSERT_EQ(rules.size(), 2u);
    EXPECT_EQ(rules[0].id, "read");
    EXPECT_EQ(rules[0].allowed_origins, (std::vector<std::string>{"https://app.example.com", "https://*.example.net"}));
    EXPECT_EQ(rules[0].allowed_methods, (std::vector<std::string>{"GET", "HEAD"}));
    EXPECT_EQ(rules[0].allowed_headers, (std::vector<std::string>{"x-custom-*"}));
    EXPECT_EQ(rules[0].expose_headers, (std::vector<std::string>{"ETag"}));
    EXPECT_EQ(rules[0].max_age_seconds, 3600);
    EXPECT_FALSE(rules[1].id);
    EXPECT_EQ(rules[1].max_age_seconds, 0);
    EXPECT_TRUE(rules[1].allowed_headers.empty());
}

TEST(CorsConfig, WritesWhatItParses) {
    auto parsed = cors::parse(config(rule("<ID>a&amp;b</ID>" + kGet + "<ExposeHeader>ETag</ExposeHeader>") +
                                     rule("<AllowedOrigin>*</AllowedOrigin><AllowedMethod>DELETE</AllowedMethod>"
                                          "<MaxAgeSeconds>0</MaxAgeSeconds>")));
    ASSERT_TRUE(std::holds_alternative<cors::Configuration>(parsed));
    const auto &rules = std::get<cors::Configuration>(parsed);
    const std::string xml = cors::to_xml(rules);
    EXPECT_NE(xml.find("<CORSConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><CORSRule><ID>a&amp;b"
                       "</ID><AllowedMethod>GET</AllowedMethod><AllowedOrigin>https://example.com</AllowedOrigin>"
                       "<ExposeHeader>ETag</ExposeHeader></CORSRule>"),
              std::string::npos)
        << xml;
    EXPECT_NE(xml.find("<MaxAgeSeconds>0</MaxAgeSeconds>"), std::string::npos) << xml;
    auto reparsed = cors::parse(xml);
    ASSERT_TRUE(std::holds_alternative<cors::Configuration>(reparsed));
    EXPECT_EQ(std::get<cors::Configuration>(reparsed), rules);
}

TEST(CorsConfig, RuleLimit) {
    std::string hundred;
    for (int i = 0; i < 100; ++i) hundred += rule(kGet);
    EXPECT_EQ(error_code(config(hundred)), "");
    EXPECT_EQ(error_code(config(hundred + rule(kGet))), "MalformedXML");
}

TEST(CorsConfig, RejectsInvalidConfigurations) {
    for (const std::string body :
         {std::string(), std::string("<CORSConfiguration>"), config(""), std::string("<Other>") + rule(kGet) + "</Other>",
          config(rule("<AllowedMethod>GET</AllowedMethod>")),
          config(rule("<AllowedOrigin>https://example.com</AllowedOrigin>")), config(rule(kGet + "<Unknown/>")),
          config(rule(kGet) + "<NotARule/>"), config(rule(kGet + "<MaxAgeSeconds>soon</MaxAgeSeconds>")),
          config(rule(kGet + "<MaxAgeSeconds>-1</MaxAgeSeconds>")),
          config(rule(kGet + "<MaxAgeSeconds>1</MaxAgeSeconds><MaxAgeSeconds>2</MaxAgeSeconds>")),
          config(rule(kGet + "<ID>a</ID><ID>b</ID>")), config(rule(kGet + "<ID>" + std::string(256, 'x') + "</ID>")),
          config(rule(kGet + "<AllowedHeader><x/></AllowedHeader>"))}) {
        EXPECT_EQ(error_code(body), "MalformedXML") << body;
    }
    for (const std::string body :
         {config(rule("<AllowedOrigin>*</AllowedOrigin><AllowedMethod>TRACE</AllowedMethod>")),
          config(rule("<AllowedOrigin>*</AllowedOrigin><AllowedMethod>get</AllowedMethod>")),
          config(rule("<AllowedOrigin>https://*.*.com</AllowedOrigin><AllowedMethod>GET</AllowedMethod>")),
          config(rule(kGet + "<AllowedHeader>x-*-*</AllowedHeader>"))}) {
        EXPECT_EQ(error_code(body), "InvalidRequest") << body;
    }
}

TEST(CorsStore, SaveLoadAndRemove) {
    micros3::test::TempDir dir;
    micros3::Store store(dir.path());
    EXPECT_FALSE(cors::load(store, "bucket").bucket_exists);
    EXPECT_FALSE(cors::save(store, "bucket", std::nullopt));

    ASSERT_FALSE(micros3::buckets::create(store, "bucket", "us-east-1", 0));
    ASSERT_FALSE(micros3::buckets::create(store, "other", "us-east-1", 0));
    cors::Lookup lookup = cors::load(store, "bucket");
    EXPECT_TRUE(lookup.bucket_exists);
    EXPECT_FALSE(lookup.config);

    cors::Rule rule;
    rule.allowed_origins = {"*"};
    rule.allowed_methods = {"GET"};
    rule.max_age_seconds = 0;
    ASSERT_TRUE(cors::save(store, "bucket", cors::Configuration{rule}));
    lookup = cors::load(store, "bucket");
    ASSERT_TRUE(lookup.config);
    EXPECT_EQ(*lookup.config, cors::Configuration{rule});
    EXPECT_FALSE(cors::load(store, "other").config);

    ASSERT_TRUE(cors::save(store, "bucket", std::nullopt));
    EXPECT_FALSE(cors::load(store, "bucket").config);
}

// Matching requests against rules.

namespace {

cors::Configuration behavior_rules() {
    cors::Rule read;
    read.id = "read";
    read.allowed_origins = {"https://app.example.com", "https://*.example.net"};
    read.allowed_methods = {"GET", "HEAD"};
    read.allowed_headers = {"authorization", "x-custom-*"};
    read.expose_headers = {"ETag"};
    read.max_age_seconds = 100;
    cors::Rule write;
    write.id = "write";
    write.allowed_origins = {"https://app.example.com"};
    write.allowed_methods = {"GET", "PUT"};
    write.allowed_headers = {"*"};
    cors::Rule any;
    any.id = "any";
    any.allowed_origins = {"*"};
    any.allowed_methods = {"GET"};
    return {read, write, any};
}

std::string matched_id(const cors::Rule *rule) { return rule ? rule->id.value_or("") : "<none>"; }

} // namespace

TEST(CorsMatch, Wildcards) {
    EXPECT_TRUE(cors::wildcard_match("*", "", false));
    EXPECT_TRUE(cors::wildcard_match("*", "anything", false));
    EXPECT_TRUE(cors::wildcard_match("https://*.example.net", "https://a.b.example.net", false));
    EXPECT_FALSE(cors::wildcard_match("https://*.example.net", "http://a.example.net", false));
    EXPECT_FALSE(cors::wildcard_match("https://*.example.net", "https://example.net", false));
    EXPECT_FALSE(cors::wildcard_match("ab*ba", "aba", false));
    EXPECT_TRUE(cors::wildcard_match("ab*ba", "abba", false));
    EXPECT_TRUE(cors::wildcard_match("x-custom-*", "X-Custom-Thing", true));
    EXPECT_FALSE(cors::wildcard_match("x-custom-*", "X-Custom-Thing", false));
    EXPECT_TRUE(cors::wildcard_match("exact", "exact", false));
    EXPECT_FALSE(cors::wildcard_match("exact", "exact2", false));
}

TEST(CorsMatch, ActualRequestsUseFirstMatchingRule) {
    const cors::Configuration config = behavior_rules();
    EXPECT_EQ(matched_id(cors::match_request(config, "https://app.example.com", "GET")), "read");
    EXPECT_EQ(matched_id(cors::match_request(config, "https://img.example.net", "HEAD")), "read");
    EXPECT_EQ(matched_id(cors::match_request(config, "https://app.example.com", "PUT")), "write");
    EXPECT_EQ(matched_id(cors::match_request(config, "https://other.example", "GET")), "any");
    EXPECT_EQ(matched_id(cors::match_request(config, "https://other.example", "PUT")), "<none>");
    EXPECT_EQ(matched_id(cors::match_request(config, "http://img.example.net", "HEAD")), "<none>");
    // Methods are case-sensitive.
    EXPECT_EQ(matched_id(cors::match_request(config, "https://app.example.com", "get")), "<none>");
}

TEST(CorsMatch, PreflightChecksRequestedHeaders) {
    const cors::Configuration config = behavior_rules();
    auto match = cors::match_preflight(config, "https://app.example.com", "GET", "");
    ASSERT_TRUE(match);
    EXPECT_EQ(matched_id(match->rule), "read");
    EXPECT_TRUE(match->headers.empty());

    match = cors::match_preflight(config, "https://app.example.com", "GET", " Authorization ,X-Custom-A,x-custom-a");
    ASSERT_TRUE(match);
    EXPECT_EQ(matched_id(match->rule), "read");
    EXPECT_EQ(match->headers, (std::vector<std::string>{"authorization", "x-custom-a"}));

    // A header the first rule does not allow falls through to the `*` rule.
    match = cors::match_preflight(config, "https://app.example.com", "GET", "authorization, content-type");
    ASSERT_TRUE(match);
    EXPECT_EQ(matched_id(match->rule), "write");
    EXPECT_EQ(match->headers, (std::vector<std::string>{"authorization", "content-type"}));

    // The `any` rule allows no headers.
    EXPECT_TRUE(cors::match_preflight(config, "https://other.example", "GET", ""));
    EXPECT_FALSE(cors::match_preflight(config, "https://other.example", "GET", "x-custom-a"));
    EXPECT_FALSE(cors::match_preflight(config, "https://other.example", "DELETE", ""));
}

TEST(CorsMatch, ResponseHeaders) {
    const cors::Configuration config = behavior_rules();
    micros3::http::Response response;
    cors::add_headers(response, config[0], "https://img.example.net", {"authorization"});
    const micros3::http::Headers expected = {{"Access-Control-Allow-Origin", "https://img.example.net"},
                                             {"Access-Control-Allow-Credentials", "true"},
                                             {"Access-Control-Allow-Methods", "GET, HEAD"},
                                             {"Access-Control-Allow-Headers", "authorization"},
                                             {"Access-Control-Expose-Headers", "ETag"},
                                             {"Access-Control-Max-Age", "100"}};
    EXPECT_EQ(response.headers, expected);

    micros3::http::Response any;
    cors::add_headers(any, config[2], "https://other.example");
    EXPECT_EQ(any.headers, (micros3::http::Headers{{"Access-Control-Allow-Origin", "*"},
                                                   {"Access-Control-Allow-Methods", "GET"}}));

    cors::add_vary(any, "Origin");
    any.set_header("x", "y");
    cors::add_vary(any, "Accept");
    EXPECT_EQ(any.headers.back().first, "x");
    EXPECT_EQ(any.headers[2], (std::pair<std::string, std::string>{"Vary", "Origin, Accept"}));
}
