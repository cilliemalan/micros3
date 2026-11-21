#pragma once

// Server configuration from command-line flags and environment variables.
//
// Options: `--data-dir <path>` / MICROS3_DATA_DIR (default ./data) and
// `--port <n>` / MICROS3_PORT (default 3923), the S3 port, and
// `--ui-port <n>` / MICROS3_UI_PORT (default 3924), the web UI's port, which
// must differ from the S3 port. Flags beat environment
// variables, which beat defaults. Credentials come only from
// MICROS3_ACCESS_KEY_ID and MICROS3_SECRET_ACCESS_KEY (default test/test),
// so secrets never appear in the process list.

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <variant>

namespace micros3::config {

inline constexpr const char *kDefaultDataDir = "./data";
inline constexpr std::uint16_t kDefaultPort = 3923;
inline constexpr std::uint16_t kDefaultUiPort = 3924;
inline constexpr const char *kDefaultAccessKeyId = "test";
inline constexpr const char *kDefaultSecretAccessKey = "test";

struct Config {
    std::string data_dir = kDefaultDataDir;
    std::uint16_t port = kDefaultPort;
    std::uint16_t ui_port = kDefaultUiPort;
    std::string access_key_id = kDefaultAccessKeyId;
    std::string secret_access_key = kDefaultSecretAccessKey;
};

// The user asked for the usage text (--help or -h).
struct HelpRequested {};

// The arguments or environment were invalid. `message` describes why.
struct UsageError {
    std::string message;
};

using ParseResult = std::variant<Config, HelpRequested, UsageError>;

// Looks up an environment variable. Returns nullopt when it is unset.
using EnvLookup = std::function<std::optional<std::string>(const std::string &)>;

// The process environment.
std::optional<std::string> process_env(const std::string &name);

// Parses `argv` (argv[0] is the program name) and the environment.
// Both `--flag value` and `--flag=value` are accepted.
ParseResult parse(int argc, const char *const *argv, const EnvLookup &env = process_env);

// Parses a TCP port, 1 to 65535, in decimal with no sign or spaces.
std::optional<std::uint16_t> parse_port(const std::string &text);

// The usage text, naming `program`.
std::string usage(const std::string &program);

} // namespace micros3::config
