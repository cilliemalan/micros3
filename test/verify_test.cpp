#include "verify.h"

#include <gtest/gtest.h>

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <optional>
#include <random>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#endif

namespace {

std::optional<std::string> get_env(const char *name) {
#ifdef _WIN32
    SetLastError(ERROR_SUCCESS);
    const DWORD size = GetEnvironmentVariableA(name, nullptr, 0);
    if (size == 0) {
        return GetLastError() == ERROR_ENVVAR_NOT_FOUND
                   ? std::nullopt
                   : std::optional<std::string>("");
    }
    std::string value(size, '\0');
    value.resize(GetEnvironmentVariableA(name, value.data(), size));
    return value;
#else
    const char *value = std::getenv(name);
    return value ? std::optional<std::string>(value) : std::nullopt;
#endif
}

void set_env(const char *name, const std::optional<std::string> &value) {
#ifdef _WIN32
    _putenv_s(name, value ? value->c_str() : "");
    if (value && value->empty()) {
        SetEnvironmentVariableA(name, "");
    }
#else
    if (value) {
        setenv(name, value->c_str(), 1);
    } else {
        unsetenv(name);
    }
#endif
}

class ScopedEnv {
public:
    explicit ScopedEnv(const char *name) : name_(name), original_(get_env(name)) {
        set_env(name_, std::nullopt);
    }
    ~ScopedEnv() {
        set_env(name_, original_);
    }

private:
    const char *name_;
    std::optional<std::string> original_;
};

struct Result {
    int status;
    std::string out;
    std::string err;
};

Result run(std::vector<std::string> args) {
    std::vector<char *> argv;
    for (auto &arg : args) {
        argv.push_back(arg.data());
    }
    std::ostringstream out;
    std::ostringstream err;
    const int status = verification::run(static_cast<int>(argv.size()), argv.data(), out, err);
    return {status, out.str(), err.str()};
}

class VerifyTest : public testing::Test {
protected:
    VerifyTest() {
        std::random_device random;
        for (int i = 0; i < 32; ++i) {
            directory_ = std::filesystem::temp_directory_path() /
                         ("micros3-verify-test-" + std::to_string(random()));
            if (std::filesystem::create_directory(directory_)) {
                file_ = directory_ / "test.env";
                return;
            }
        }
        throw std::runtime_error("Unable to create a temporary test directory");
    }

    ~VerifyTest() override {
        std::filesystem::remove(file_);
        std::filesystem::remove(directory_);
    }

    void write_file(const std::string &contents) {
        std::ofstream file(file_);
        file << contents;
        ASSERT_TRUE(file.good());
    }

    std::string file_name() const {
        return file_.string();
    }

private:
    std::filesystem::path directory_;
    std::filesystem::path file_;
};

TEST_F(VerifyTest, NoArgumentsKeepsGreeting) {
    const auto result = run({"verify"});
    EXPECT_EQ(result.status, 0);
    EXPECT_EQ(result.out, "Hello, world!\n");
    EXPECT_TRUE(result.err.empty());
}

TEST_F(VerifyTest, ShortOptionLoadsValuesAndOverridesEnvironment) {
    ScopedEnv plain("MICROS3_VERIFY_PLAIN");
    ScopedEnv quoted("MICROS3_VERIFY_QUOTED");
    ScopedEnv empty("MICROS3_VERIFY_EMPTY");
    ScopedEnv existing("MICROS3_VERIFY_EXISTING");
    ScopedEnv existing_empty("MICROS3_VERIFY_EXISTING_EMPTY");
    ScopedEnv overridden_with_empty("MICROS3_VERIFY_OVERRIDDEN_WITH_EMPTY");
    ScopedEnv untouched("MICROS3_VERIFY_UNTOUCHED");
    set_env("MICROS3_VERIFY_EXISTING", "original");
    set_env("MICROS3_VERIFY_EXISTING_EMPTY", "");
    set_env("MICROS3_VERIFY_OVERRIDDEN_WITH_EMPTY", "original");
    set_env("MICROS3_VERIFY_UNTOUCHED", "original");
    write_file("# comment\r\n"
               "export\tMICROS3_VERIFY_PLAIN = first\r\n"
               "MICROS3_VERIFY_PLAIN = last # comment\r\n"
               "MICROS3_VERIFY_QUOTED=\"hello # world\\n\\\"quoted\\\"\" # comment\r\n"
               "MICROS3_VERIFY_EMPTY=\r\n"
               "MICROS3_VERIFY_EXISTING=from-file\r\n"
               "MICROS3_VERIFY_EXISTING_EMPTY=from-file\r\n"
               "MICROS3_VERIFY_OVERRIDDEN_WITH_EMPTY=\r\n");

    const auto result = run({"verify", "-e", file_name()});
    EXPECT_EQ(result.status, 0);
    EXPECT_EQ(result.out, "Hello, world!\n");
    EXPECT_TRUE(result.err.empty());
    EXPECT_EQ(get_env("MICROS3_VERIFY_PLAIN"), "last");
    EXPECT_EQ(get_env("MICROS3_VERIFY_QUOTED"), "hello # world\n\"quoted\"");
    EXPECT_EQ(get_env("MICROS3_VERIFY_EMPTY"), "");
    EXPECT_EQ(get_env("MICROS3_VERIFY_EXISTING"), "from-file");
    EXPECT_EQ(get_env("MICROS3_VERIFY_EXISTING_EMPTY"), "from-file");
    EXPECT_EQ(get_env("MICROS3_VERIFY_OVERRIDDEN_WITH_EMPTY"), "");
    EXPECT_EQ(get_env("MICROS3_VERIFY_UNTOUCHED"), "original");
}

TEST_F(VerifyTest, LongOptionsLoadFile) {
    ScopedEnv value("MICROS3_VERIFY_LONG");
    write_file("MICROS3_VERIFY_LONG='literal # value'\n");

    EXPECT_EQ(run({"verify", "--env", file_name()}).status, 0);
    EXPECT_EQ(get_env("MICROS3_VERIFY_LONG"), "literal # value");
    set_env("MICROS3_VERIFY_LONG", std::nullopt);
    EXPECT_EQ(run({"verify", "--env=" + file_name()}).status, 0);
    EXPECT_EQ(get_env("MICROS3_VERIFY_LONG"), "literal # value");
}

TEST_F(VerifyTest, ReportsInvalidArgumentsAndMissingFiles) {
    for (const auto &args : std::vector<std::vector<std::string>>{
             {"verify", "-e"}, {"verify", "--env", ""}, {"verify", "--env="},
             {"verify", "--unknown"}, {"verify", "-e", file_name(), "--env", file_name()},
             {"verify", "-e", file_name()}}) {
        const auto result = run(args);
        EXPECT_NE(result.status, 0);
        EXPECT_TRUE(result.out.empty());
        EXPECT_FALSE(result.err.empty());
    }
}

TEST_F(VerifyTest, RejectsInvalidEntriesWithoutApplyingEarlierLines) {
    ScopedEnv value("MICROS3_VERIFY_ATOMIC");
    for (const std::string &invalid : {"INVALID", "1INVALID=value", "NAME='unterminated",
                                       "NAME=\"value\" trailing"}) {
        write_file("MICROS3_VERIFY_ATOMIC=should-not-be-set\n" + invalid + "\n");
        const auto result = run({"verify", "--env", file_name()});
        EXPECT_NE(result.status, 0);
        EXPECT_TRUE(result.out.empty());
        EXPECT_NE(result.err.find(":2"), std::string::npos);
        EXPECT_EQ(get_env("MICROS3_VERIFY_ATOMIC"), std::nullopt);
    }
}

}
