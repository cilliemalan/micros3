#include "micros3/url.h"

namespace micros3::url {

namespace {

int hex_value(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

} // namespace

std::optional<std::string> decode(std::string_view text, bool plus_is_space) {
    std::string out;
    out.reserve(text.size());
    for (std::size_t i = 0; i < text.size(); ++i) {
        const char c = text[i];
        if (c == '%') {
            if (text.size() - i < 3) {
                return std::nullopt;
            }
            const int hi = hex_value(text[i + 1]);
            const int lo = hex_value(text[i + 2]);
            if (hi < 0 || lo < 0) return std::nullopt;
            out.push_back(static_cast<char>(hi * 16 + lo));
            i += 2;
        } else if (c == '+' && plus_is_space) {
            out.push_back(' ');
        } else {
            out.push_back(c);
        }
    }
    return out;
}

std::optional<Query> Query::parse(std::string_view raw) {
    std::vector<QueryParam> params;
    std::size_t start = 0;
    while (start <= raw.size()) {
        std::size_t end = raw.find('&', start);
        if (end == std::string_view::npos) end = raw.size();
        const std::string_view segment = raw.substr(start, end - start);
        if (!segment.empty()) {
            QueryParam param;
            const std::size_t eq = segment.find('=');
            const std::string_view name = segment.substr(0, eq);
            auto decoded_name = decode(name, true);
            if (!decoded_name) return std::nullopt;
            param.name = std::move(*decoded_name);
            if (eq != std::string_view::npos) {
                auto decoded_value = decode(segment.substr(eq + 1), true);
                if (!decoded_value) return std::nullopt;
                param.value = std::move(*decoded_value);
                param.has_value = true;
            }
            params.push_back(std::move(param));
        }
        start = end + 1;
    }
    return Query(std::move(params));
}

bool Query::has(std::string_view name) const {
    for (const auto &param : params_) {
        if (param.name == name) return true;
    }
    return false;
}

std::optional<std::string> Query::get(std::string_view name) const {
    for (const auto &param : params_) {
        if (param.name == name) return param.value;
    }
    return std::nullopt;
}

} // namespace micros3::url
