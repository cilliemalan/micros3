#include "micros3/config.h"

#include <gtest/gtest.h>

#include <map>
#include <vector>

using namespace micros3::config;

namespace {

ParseResult run(std::vector<const char *> args, std::map<std::string, std::string> vars = {}) {
    args.insert(args.begin(), "micros3");
    EnvLookup env = [vars](const std::string &name) -> std::optional<std::string> {
        auto it = vars.find(name);
        if (it == vars.end()) {
            return std::nullopt;
        }
        return it->second;
    };
    return parse(static_cast<int>(args.size()), args.data(), env);
}

Config ok(const ParseResult &result) {
    EXPECT_TRUE(std::holds_alternative<Config>(result));
    if (auto *config = std::get_if<Config>(&result)) {
        return *config;
    }
    return {};
}

std::string error(const ParseResult &result) {
    EXPECT_TRUE(std::holds_alternative<UsageError>(result));
    if (auto *e = std::get_if<UsageError>(&result)) {
        return e->message;
    }
    return {};
}

} // namespace

TEST(Config, Defaults) {
    Config c = ok(run({}));
    EXPECT_EQ(c.data_dir, "./data");
    EXPECT_EQ(c.port, 3923);
    EXPECT_EQ(c.access_key_id, "test");
    EXPECT_EQ(c.secret_access_key, "test");
}

TEST(Config, EnvironmentOverridesDefaults) {
    Config c = ok(run({}, {{"MICROS3_DATA_DIR", "/data"},
                           {"MICROS3_PORT", "8080"},
                           {"MICROS3_ACCESS_KEY_ID", "AKID"},
                           {"MICROS3_SECRET_ACCESS_KEY", "secret"}}));
    EXPECT_EQ(c.data_dir, "/data");
    EXPECT_EQ(c.port, 8080);
    EXPECT_EQ(c.access_key_id, "AKID");
    EXPECT_EQ(c.secret_access_key, "secret");
}

TEST(Config, FlagsOverrideEnvironment) {
    std::map<std::string, std::string> env{{"MICROS3_DATA_DIR", "/data"}, {"MICROS3_PORT", "8080"}};
    Config c = ok(run({"--data-dir", "/other", "--port", "9000"}, env));
    EXPECT_EQ(c.data_dir, "/other");
    EXPECT_EQ(c.port, 9000);
}

TEST(Config, FlagsWithEquals) {
    Config c = ok(run({"--data-dir=/x", "--port=1"}));
    EXPECT_EQ(c.data_dir, "/x");
    EXPECT_EQ(c.port, 1);
}

TEST(Config, LastFlagWins) {
    EXPECT_EQ(ok(run({"--port", "1000", "--port", "2000"})).port, 2000);
}

TEST(Config, FlagsOverrideInvalidEnvironmentPort) {
    EXPECT_EQ(ok(run({"--port", "4000"}, {{"MICROS3_PORT", "nope"}})).port, 4000);
}

TEST(Config, EmptyEnvironmentCountsAsUnset) {
    Config c = ok(run({}, {{"MICROS3_DATA_DIR", ""}, {"MICROS3_PORT", ""}}));
    EXPECT_EQ(c.data_dir, "./data");
    EXPECT_EQ(c.port, 3923);
}

TEST(Config, NoCredentialFlags) {
    EXPECT_NE(error(run({"--access-key-id", "x"})), "");
    EXPECT_NE(error(run({"--secret-access-key=x"})), "");
}

TEST(Config, EmptyCredentialsRejected) {
    EXPECT_NE(error(run({}, {{"MICROS3_ACCESS_KEY_ID", ""}})), "");
    EXPECT_NE(error(run({}, {{"MICROS3_SECRET_ACCESS_KEY", ""}})), "");
}

TEST(Config, InvalidPortsRejected) {
    for (const char *port : {"0", "65536", "-1", "+80", "abc", "80x", " 80", "", "999999", "0x50"}) {
        SCOPED_TRACE(port);
        EXPECT_NE(error(run({"--port", port})), "");
    }
    EXPECT_NE(error(run({}, {{"MICROS3_PORT", "70000"}})), "");
}

TEST(Config, PortBounds) {
    EXPECT_EQ(parse_port("1"), 1);
    EXPECT_EQ(parse_port("65535"), 65535);
    EXPECT_EQ(parse_port("03923"), 3923);
    EXPECT_FALSE(parse_port("65536"));
}

TEST(Config, MissingValueRejected) {
    EXPECT_NE(error(run({"--port"})), "");
    EXPECT_NE(error(run({"--data-dir"})), "");
    EXPECT_NE(error(run({"--data-dir="})), "");
}

TEST(Config, UnknownArgumentRejected) {
    EXPECT_NE(error(run({"--verbose"})), "");
    EXPECT_NE(error(run({"positional"})), "");
}

TEST(Config, Help) {
    EXPECT_TRUE(std::holds_alternative<HelpRequested>(run({"--help"})));
    EXPECT_TRUE(std::holds_alternative<HelpRequested>(run({"-h"})));
    EXPECT_NE(usage("micros3").find("--data-dir"), std::string::npos);
}

TEST(Config, UiPortDefault) {
    EXPECT_EQ(ok(run({})).ui_port, 3924);
    EXPECT_EQ(ok(run({}, {{"MICROS3_UI_PORT", ""}})).ui_port, 3924);
}

TEST(Config, UiPortFromEnvironmentAndFlags) {
    EXPECT_EQ(ok(run({}, {{"MICROS3_UI_PORT", "8081"}})).ui_port, 8081);
    EXPECT_EQ(ok(run({"--ui-port", "9001"}, {{"MICROS3_UI_PORT", "8081"}})).ui_port, 9001);
    EXPECT_EQ(ok(run({"--ui-port=9002"})).ui_port, 9002);
    EXPECT_EQ(ok(run({"--ui-port", "9001"}, {{"MICROS3_UI_PORT", "nope"}})).ui_port, 9001);
}

TEST(Config, InvalidUiPortsRejected) {
    for (const char *port : {"0", "65536", "-1", "abc", ""}) {
        SCOPED_TRACE(port);
        EXPECT_NE(error(run({"--ui-port", port})).find("--ui-port"), std::string::npos);
    }
    EXPECT_NE(error(run({}, {{"MICROS3_UI_PORT", "70000"}})).find("MICROS3_UI_PORT"), std::string::npos);
    EXPECT_NE(error(run({"--ui-port"})), "");
}

TEST(Config, UiPortMustDifferFromS3Port) {
    EXPECT_NE(error(run({"--ui-port", "3923"})), "");
    EXPECT_NE(error(run({"--port", "3924"})), "");
    EXPECT_NE(error(run({"--port", "5000", "--ui-port", "5000"})), "");
    EXPECT_NE(error(run({}, {{"MICROS3_PORT", "5000"}, {"MICROS3_UI_PORT", "5000"}})), "");
    // Moving both apart is fine.
    Config c = ok(run({"--port", "3924", "--ui-port", "3923"}));
    EXPECT_EQ(c.port, 3924);
    EXPECT_EQ(c.ui_port, 3923);
}

TEST(Config, UsageNamesUiPort) {
    EXPECT_NE(usage("micros3").find("--ui-port"), std::string::npos);
    EXPECT_NE(usage("micros3").find("MICROS3_UI_PORT"), std::string::npos);
}
