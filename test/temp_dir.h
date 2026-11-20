#pragma once

// A fresh directory under the system temp directory, removed on destruction.

#include <filesystem>
#include <random>
#include <string>
#include <system_error>

namespace micros3::test {

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = std::filesystem::temp_directory_path() /
                ("micros3-test-" + std::to_string(rd()) + std::to_string(rd()));
        std::filesystem::create_directories(path_);
    }
    ~TempDir() {
        std::error_code ec;
        std::filesystem::remove_all(path_, ec);
    }
    TempDir(const TempDir &) = delete;
    TempDir &operator=(const TempDir &) = delete;
    const std::filesystem::path &path() const { return path_; }

private:
    std::filesystem::path path_;
};

} // namespace micros3::test
