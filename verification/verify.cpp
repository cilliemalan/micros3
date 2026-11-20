#include "verify.h"

#include "micros3/hello.h"

#include <cctype>
#include <cstdlib>
#include <fstream>
#include <map>
#include <ostream>
#include <string>

#ifdef _WIN32
#include <windows.h>
#endif

namespace {

std::string trim(const std::string &text) {
    const auto first = text.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) {
        return {};
    }
    return text.substr(first, text.find_last_not_of(" \t\r\n") - first + 1);
}

bool valid_name(const std::string &name) {
    if (name.empty() || !(std::isalpha(static_cast<unsigned char>(name[0])) || name[0] == '_')) {
        return false;
    }
    for (char c : name) {
        if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '_')) {
            return false;
        }
    }
    return true;
}

bool parse_value(const std::string &input, std::string &value) {
    std::string text = trim(input);
    if (text.empty()) {
        value.clear();
        return true;
    }
    if (text[0] != '\'' && text[0] != '"') {
        for (std::size_t i = 0; i < text.size(); ++i) {
            if (text[i] == '#' && (i == 0 || std::isspace(static_cast<unsigned char>(text[i - 1])))) {
                text.resize(i);
                break;
            }
        }
        value = trim(text);
        return true;
    }

    const char quote = text[0];
    value.clear();
    for (std::size_t i = 1; i < text.size(); ++i) {
        if (text[i] == quote) {
            const std::string rest = trim(text.substr(i + 1));
            return rest.empty() || rest[0] == '#';
        }
        if (quote == '"' && text[i] == '\\' && i + 1 < text.size()) {
            const char next = text[i + 1];
            if (next == 'n' || next == 'r' || next == 't' || next == '\\' || next == '"') {
                value += next == 'n' ? '\n' : next == 'r' ? '\r' : next == 't' ? '\t' : next;
                ++i;
                continue;
            }
        }
        value += text[i];
    }
    return false;
}

bool set_environment(const std::string &name, const std::string &value) {
#ifdef _WIN32
    if (_putenv_s(name.c_str(), value.c_str()) != 0) {
        return false;
    }
    return !value.empty() || SetEnvironmentVariableA(name.c_str(), "") != 0;
#else
    return setenv(name.c_str(), value.c_str(), 1) == 0;
#endif
}

bool load_env(const std::string &path, std::ostream &err) {
    std::ifstream file(path);
    if (!file) {
        err << "Could not open environment file: " << path << '\n';
        return false;
    }

    std::map<std::string, std::string> entries;
    std::string line;
    std::size_t line_number = 0;
    while (std::getline(file, line)) {
        ++line_number;
        line = trim(line);
        if (line.empty() || line[0] == '#') {
            continue;
        }
        if (line.compare(0, 6, "export") == 0 && line.size() > 6 &&
            std::isspace(static_cast<unsigned char>(line[6]))) {
            line = trim(line.substr(6));
        }
        const auto equals = line.find('=');
        const std::string name = trim(line.substr(0, equals));
        std::string value;
        if (equals == std::string::npos || !valid_name(name) ||
            !parse_value(line.substr(equals + 1), value)) {
            err << "Invalid environment file entry at " << path << ':' << line_number << '\n';
            return false;
        }
        entries[name] = value;
    }
    if (file.bad()) {
        err << "Could not read environment file: " << path << '\n';
        return false;
    }

    for (const auto &entry : entries) {
        if (!set_environment(entry.first, entry.second)) {
            err << "Could not set environment variable: " << entry.first << '\n';
            return false;
        }
    }
    return true;
}

}

namespace verification {

int run(int argc, char *argv[], std::ostream &out, std::ostream &err) {
    std::string env_file;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "-e" || arg == "--env") {
            if (!env_file.empty() || i + 1 >= argc || argv[i + 1][0] == '\0' ||
                argv[i + 1][0] == '-') {
                err << "Usage: verify [-e|--env <file>]\n";
                return 1;
            }
            env_file = argv[++i];
        } else if (arg.compare(0, 6, "--env=") == 0 && env_file.empty()) {
            env_file = arg.substr(6);
            if (env_file.empty()) {
                err << "Usage: verify [-e|--env <file>]\n";
                return 1;
            }
        } else {
            err << "Usage: verify [-e|--env <file>]\n";
            return 1;
        }
    }
    if (!env_file.empty() && !load_env(env_file, err)) {
        return 1;
    }
    out << micros3::hello() << '\n';
    return 0;
}

}
