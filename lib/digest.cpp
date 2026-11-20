#include "micros3/digest.h"

#include <mbedtls/base64.h>
#include <mbedtls/md.h>
#include <mbedtls/md5.h>
#include <mbedtls/sha256.h>
#include <zlib.h>

#include <limits>
#include <stdexcept>

namespace micros3::digest {

struct Md5::State {
    mbedtls_md5_context ctx;
};

Md5::Md5() : state_(std::make_unique<State>()) {
    mbedtls_md5_init(&state_->ctx);
    if (mbedtls_md5_starts(&state_->ctx) != 0) {
        throw std::runtime_error("mbedtls_md5_starts failed");
    }
}

Md5::~Md5() {
    mbedtls_md5_free(&state_->ctx);
}

void Md5::update(const void *data, std::size_t size) {
    if (size != 0 &&
        mbedtls_md5_update(&state_->ctx, static_cast<const unsigned char *>(data), size) != 0) {
        throw std::runtime_error("mbedtls_md5_update failed");
    }
}

Md5Digest Md5::finish() {
    Md5Digest out{};
    if (mbedtls_md5_finish(&state_->ctx, out.data()) != 0) {
        throw std::runtime_error("mbedtls_md5_finish failed");
    }
    return out;
}

struct Sha256::State {
    mbedtls_sha256_context ctx;
};

Sha256::Sha256() : state_(std::make_unique<State>()) {
    mbedtls_sha256_init(&state_->ctx);
    if (mbedtls_sha256_starts(&state_->ctx, 0) != 0) {
        throw std::runtime_error("mbedtls_sha256_starts failed");
    }
}

Sha256::~Sha256() {
    mbedtls_sha256_free(&state_->ctx);
}

void Sha256::update(const void *data, std::size_t size) {
    if (size != 0 &&
        mbedtls_sha256_update(&state_->ctx, static_cast<const unsigned char *>(data), size) != 0) {
        throw std::runtime_error("mbedtls_sha256_update failed");
    }
}

Sha256Digest Sha256::finish() {
    Sha256Digest out{};
    if (mbedtls_sha256_finish(&state_->ctx, out.data()) != 0) {
        throw std::runtime_error("mbedtls_sha256_finish failed");
    }
    return out;
}

void Crc32::update(const void *data, std::size_t size) {
    auto *p = static_cast<const Bytef *>(data);
    while (size > 0) {
        uInt chunk = size > std::numeric_limits<uInt>::max()
                         ? std::numeric_limits<uInt>::max()
                         : static_cast<uInt>(size);
        crc_ = static_cast<std::uint32_t>(::crc32(crc_, p, chunk));
        p += chunk;
        size -= chunk;
    }
}

std::array<std::uint8_t, 4> Crc32::bytes() const {
    return {static_cast<std::uint8_t>(crc_ >> 24), static_cast<std::uint8_t>(crc_ >> 16),
            static_cast<std::uint8_t>(crc_ >> 8), static_cast<std::uint8_t>(crc_)};
}

Md5Digest md5(std::string_view data) {
    Md5 h;
    h.update(data);
    return h.finish();
}

Sha256Digest sha256(std::string_view data) {
    Sha256 h;
    h.update(data);
    return h.finish();
}

std::uint32_t crc32(std::string_view data) {
    Crc32 c;
    c.update(data);
    return c.value();
}

Sha256Digest hmac_sha256(std::string_view key, std::string_view data) {
    Sha256Digest out{};
    const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    if (info == nullptr ||
        mbedtls_md_hmac(info, reinterpret_cast<const unsigned char *>(key.data()), key.size(),
                        reinterpret_cast<const unsigned char *>(data.data()), data.size(),
                        out.data()) != 0) {
        throw std::runtime_error("mbedtls_md_hmac failed");
    }
    return out;
}

std::string hex(const void *data, std::size_t size) {
    static constexpr char digits[] = "0123456789abcdef";
    auto *p = static_cast<const std::uint8_t *>(data);
    std::string out;
    out.reserve(size * 2);
    for (std::size_t i = 0; i < size; ++i) {
        out.push_back(digits[p[i] >> 4]);
        out.push_back(digits[p[i] & 0x0f]);
    }
    return out;
}

std::string base64_encode(const void *data, std::size_t size) {
    std::string out(4 * ((size + 2) / 3) + 1, '\0');
    std::size_t written = 0;
    if (mbedtls_base64_encode(reinterpret_cast<unsigned char *>(out.data()), out.size(), &written,
                              static_cast<const unsigned char *>(data), size) != 0) {
        throw std::runtime_error("mbedtls_base64_encode failed");
    }
    out.resize(written);
    return out;
}

std::optional<std::string> base64_decode(std::string_view encoded) {
    // Mbed TLS tolerates embedded whitespace and missing padding in places;
    // S3 headers must be exact, so require a padded multiple of 4 from the
    // base64 alphabet.
    if (encoded.size() % 4 != 0) {
        return std::nullopt;
    }
    for (char c : encoded) {
        bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
                  c == '+' || c == '/' || c == '=';
        if (!ok) {
            return std::nullopt;
        }
    }
    std::string out(encoded.size() / 4 * 3, '\0');
    std::size_t written = 0;
    if (mbedtls_base64_decode(reinterpret_cast<unsigned char *>(out.data()), out.size(), &written,
                              reinterpret_cast<const unsigned char *>(encoded.data()),
                              encoded.size()) != 0) {
        return std::nullopt;
    }
    out.resize(written);
    return out;
}

} // namespace micros3::digest
