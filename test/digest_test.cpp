// Known-vector checks for the hash, HMAC, CRC32 and base64 wiring.

#include "micros3/digest.h"

#include <gtest/gtest.h>

#include <string>

using namespace micros3::digest;

TEST(Digest, Md5KnownVectors) {
    EXPECT_EQ(hex(md5("")), "d41d8cd98f00b204e9800998ecf8427e");
    EXPECT_EQ(hex(md5("abc")), "900150983cd24fb0d6963f7d28e17f72");
    EXPECT_EQ(hex(md5("The quick brown fox jumps over the lazy dog")),
              "9e107d9d372bb6826bd81d3542a419d6");
}

TEST(Digest, Md5Streaming) {
    Md5 h;
    std::string chunk(1000, 'a');
    for (int i = 0; i < 1000; ++i) {
        h.update(chunk);
    }
    EXPECT_EQ(hex(h.finish()), "7707d6ae4e027c70eea2a935c2296f21");
}

TEST(Digest, Sha256KnownVectors) {
    EXPECT_EQ(hex(sha256("")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    EXPECT_EQ(hex(sha256("abc")),
              "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
}

TEST(Digest, Sha256Streaming) {
    Sha256 h;
    std::string chunk(1000, 'a');
    for (int i = 0; i < 1000; ++i) {
        h.update(chunk);
    }
    EXPECT_EQ(hex(h.finish()), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
}

TEST(Digest, HmacSha256Rfc4231) {
    // RFC 4231 test case 2.
    EXPECT_EQ(hex(hmac_sha256("Jefe", "what do ya want for nothing?")),
              "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    // RFC 4231 test case 6: key longer than the block size.
    EXPECT_EQ(hex(hmac_sha256(std::string(131, '\xaa'),
                              "Test Using Larger Than Block-Size Key - Hash Key First")),
              "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
}

TEST(Digest, Crc32KnownVectors) {
    EXPECT_EQ(crc32(""), 0u);
    EXPECT_EQ(crc32("123456789"), 0xCBF43926u);
    EXPECT_EQ(crc32("The quick brown fox jumps over the lazy dog"), 0x414FA339u);
}

TEST(Digest, Crc32StreamingAndBytes) {
    Crc32 c;
    c.update("1234");
    c.update("56789");
    EXPECT_EQ(c.value(), 0xCBF43926u);
    // S3's x-amz-checksum-crc32 is the base64 of the big-endian bytes.
    EXPECT_EQ(base64_encode(c.bytes()), "y/Q5Jg==");
}

TEST(Digest, Base64Rfc4648) {
    const std::pair<const char *, const char *> vectors[] = {
        {"", ""},         {"f", "Zg=="},         {"fo", "Zm8="},        {"foo", "Zm9v"},
        {"foob", "Zm9vYg=="}, {"fooba", "Zm9vYmE="}, {"foobar", "Zm9vYmFy"},
    };
    for (const auto &[plain, encoded] : vectors) {
        EXPECT_EQ(base64_encode(std::string_view(plain)), encoded);
        auto decoded = base64_decode(encoded);
        ASSERT_TRUE(decoded.has_value()) << encoded;
        EXPECT_EQ(*decoded, plain);
    }
}

TEST(Digest, Base64Md5OfEmptyBody) {
    // The Content-MD5 an SDK sends for an empty body.
    EXPECT_EQ(base64_encode(md5("")), "1B2M2Y8AsgTpgAmY7PhCfg==");
}

TEST(Digest, Base64RejectsMalformed) {
    EXPECT_FALSE(base64_decode("Zg").has_value());
    EXPECT_FALSE(base64_decode("Zg=").has_value());
    EXPECT_FALSE(base64_decode("Zm9v!A==").has_value());
    EXPECT_FALSE(base64_decode("Zm 9v").has_value());
    EXPECT_FALSE(base64_decode("=Zm9").has_value());
}

TEST(Digest, BinaryInput) {
    std::string bytes("\x00\xff\x10\x80", 4);
    auto encoded = base64_encode(bytes);
    EXPECT_EQ(encoded, "AP8QgA==");
    EXPECT_EQ(base64_decode(encoded), bytes);
}
