#pragma once

// The web UI's static files, embedded in the executable (docs/UI.md, "Build
// and embedding"). The table is generated at build time by
// cmake/embed_ui.cmake from the Vite output, into ui_assets.cpp.

#include <cstddef>
#include <string_view>

namespace micros3::ui {

// One embedded file. `path` starts with `/`, as in "/index.html" or
// "/assets/index-3f2a.js".
struct Asset {
    std::string_view path;
    std::string_view content_type;
    const unsigned char *data;
    std::size_t size;

    std::string_view bytes() const { return {reinterpret_cast<const char *>(data), size}; }
};

// A table of assets, sorted by path.
struct Assets {
    const Asset *entries = nullptr;
    std::size_t count = 0;

    const Asset *begin() const { return entries; }
    const Asset *end() const { return entries + count; }
    // The asset at exactly `path`, or nullptr.
    const Asset *find(std::string_view path) const;
};

// The files built from ui/ and compiled into the executable.
Assets embedded_assets();

} // namespace micros3::ui
