#pragma once

// Hashes, HMAC, CRC32 and base64, wrapping Mbed TLS and zlib.
//
// The streaming classes (Md5, Sha256, Crc32) let a request body be hashed as
// it arrives, without buffering it.

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

namespace micros3::digest {

using Md5Digest = std::array<std::uint8_t, 16>;
using Sha256Digest = std::array<std::uint8_t, 32>;

class Md5 {
public:
    Md5();
    ~Md5();
    Md5(const Md5 &) = delete;
    Md5 &operator=(const Md5 &) = delete;

    void update(const void *data, std::size_t size);
    void update(std::string_view data) { update(data.data(), data.size()); }
    // Returns the digest. The object must not be updated afterwards.
    Md5Digest finish();

private:
    struct State;
    std::unique_ptr<State> state_;
};

class Sha256 {
public:
    Sha256();
    ~Sha256();
    Sha256(const Sha256 &) = delete;
    Sha256 &operator=(const Sha256 &) = delete;

    void update(const void *data, std::size_t size);
    void update(std::string_view data) { update(data.data(), data.size()); }
    // Returns the digest. The object must not be updated afterwards.
    Sha256Digest finish();

private:
    struct State;
    std::unique_ptr<State> state_;
};

class Crc32 {
public:
    void update(const void *data, std::size_t size);
    void update(std::string_view data) { update(data.data(), data.size()); }
    std::uint32_t value() const { return crc_; }
    // The checksum as 4 big-endian bytes, the form S3's checksum headers encode.
    std::array<std::uint8_t, 4> bytes() const;

private:
    std::uint32_t crc_ = 0;
};

Md5Digest md5(std::string_view data);
Sha256Digest sha256(std::string_view data);
std::uint32_t crc32(std::string_view data);
Sha256Digest hmac_sha256(std::string_view key, std::string_view data);

// Lowercase hex.
std::string hex(const void *data, std::size_t size);
template <std::size_t N> std::string hex(const std::array<std::uint8_t, N> &bytes) {
    return hex(bytes.data(), bytes.size());
}

// Standard base64 with padding.
std::string base64_encode(const void *data, std::size_t size);
inline std::string base64_encode(std::string_view data) {
    return base64_encode(data.data(), data.size());
}
template <std::size_t N> std::string base64_encode(const std::array<std::uint8_t, N> &bytes) {
    return base64_encode(bytes.data(), bytes.size());
}
// Returns nullopt when the input is not valid padded base64.
std::optional<std::string> base64_decode(std::string_view encoded);

} // namespace micros3::digest
