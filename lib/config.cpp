#include "micros3/config.h"

#include <cstdlib>

namespace micros3::config {

std::optional<std::string> process_env(const std::string &name) {
    const char *value = std::getenv(name.c_str());
    if (value == nullptr) {
        return std::nullopt;
    }
    return std::string(value);
}

std::optional<std::uint16_t> parse_port(const std::string &text) {
    if (text.empty() || text.size() > 5) {
        return std::nullopt;
    }
    unsigned value = 0;
    for (char c : text) {
        if (c < '0' || c > '9') {
            return std::nullopt;
        }
        value = value * 10 + static_cast<unsigned>(c - '0');
    }
    if (value < 1 || value > 65535) {
        return std::nullopt;
    }
    return static_cast<std::uint16_t>(value);
}

std::string usage(const std::string &program) {
    return "Usage: " + program +
           " [--data-dir <path>] [--port <n>] [--ui-port <n>]\n"
           "\n"
           "Options:\n"
           "  --data-dir <path>  Data directory (env MICROS3_DATA_DIR, default ./data)\n"
           "  --port <n>         S3 API port, 1 to 65535 (env MICROS3_PORT, default 3923)\n"
           "  --ui-port <n>      Web UI port, 1 to 65535, not the S3 port\n"
           "                     (env MICROS3_UI_PORT, default 3924)\n"
           "  -h, --help         Show this help\n"
           "\n"
           "Credentials come from MICROS3_ACCESS_KEY_ID and MICROS3_SECRET_ACCESS_KEY\n"
           "(default test/test).\n";
}

ParseResult parse(int argc, const char *const *argv, const EnvLookup &env) {
    Config config;

    if (auto value = env("MICROS3_ACCESS_KEY_ID")) {
        config.access_key_id = *value;
    }
    if (auto value = env("MICROS3_SECRET_ACCESS_KEY")) {
        config.secret_access_key = *value;
    }
    if (config.access_key_id.empty()) {
        return UsageError{"MICROS3_ACCESS_KEY_ID must not be empty"};
    }
    if (config.secret_access_key.empty()) {
        return UsageError{"MICROS3_SECRET_ACCESS_KEY must not be empty"};
    }

    // An empty MICROS3_DATA_DIR, MICROS3_PORT or MICROS3_UI_PORT counts as unset.
    auto non_empty = [&env](const char *name) -> std::optional<std::string> {
        auto value = env(name);
        if (value && value->empty()) {
            return std::nullopt;
        }
        return value;
    };
    std::optional<std::string> data_dir = non_empty("MICROS3_DATA_DIR");
    std::optional<std::string> port_text = non_empty("MICROS3_PORT");
    std::optional<std::string> ui_port_text = non_empty("MICROS3_UI_PORT");
    const char *port_source = "MICROS3_PORT";
    const char *ui_port_source = "MICROS3_UI_PORT";
    const char *data_dir_source = "MICROS3_DATA_DIR";

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "-h" || arg == "--help") {
            return HelpRequested{};
        }

        std::string name = arg;
        std::optional<std::string> value;
        if (auto eq = arg.find('='); arg.rfind("--", 0) == 0 && eq != std::string::npos) {
            name = arg.substr(0, eq);
            value = arg.substr(eq + 1);
        }
        if (name != "--data-dir" && name != "--port" && name != "--ui-port") {
            return UsageError{"unknown argument: " + arg};
        }
        if (!value) {
            if (i + 1 >= argc) {
                return UsageError{name + " needs a value"};
            }
            value = argv[++i];
        }
        if (name == "--data-dir") {
            data_dir = value;
            data_dir_source = "--data-dir";
        } else if (name == "--port") {
            port_text = value;
            port_source = "--port";
        } else {
            ui_port_text = value;
            ui_port_source = "--ui-port";
        }
    }

    if (data_dir) {
        if (data_dir->empty()) {
            return UsageError{std::string(data_dir_source) + " must not be empty"};
        }
        config.data_dir = *data_dir;
    }
    if (port_text) {
        auto port = parse_port(*port_text);
        if (!port) {
            return UsageError{std::string(port_source) + ": invalid port '" + *port_text +
                              "' (expected 1 to 65535)"};
        }
        config.port = *port;
    }
    if (ui_port_text) {
        auto port = parse_port(*ui_port_text);
        if (!port) {
            return UsageError{std::string(ui_port_source) + ": invalid port '" + *ui_port_text +
                              "' (expected 1 to 65535)"};
        }
        config.ui_port = *port;
    }
    if (config.ui_port == config.port) {
        return UsageError{"the UI port (" + std::string(ui_port_source) + ") must differ from the S3 port (" +
                          std::string(port_source) + "), both are " + std::to_string(config.port)};
    }
    return config;
}

} // namespace micros3::config
