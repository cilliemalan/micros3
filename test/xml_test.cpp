#include "micros3/xml.h"

#include <gtest/gtest.h>

#include <string>

using micros3::xml::escape;

TEST(Xml, EscapesMarkup) {
    EXPECT_EQ(escape("a&b<c>d\"e'f"), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
    EXPECT_EQ(escape("\"0123\""), "&quot;0123&quot;");
}

TEST(Xml, KeepsUtf8) {
    EXPECT_EQ(escape("日本語/ü/\xF0\x9F\x98\x80"), "日本語/ü/\xF0\x9F\x98\x80");
    EXPECT_EQ(escape("del\x7f"), "del\x7f");
}

TEST(Xml, EscapesAllowedWhitespaceAsReferences) {
    EXPECT_EQ(escape("a\tb\nc\rd"), "a&#x9;b&#xA;c&#xD;d");
}

TEST(Xml, ReplacesForbiddenCharacters) {
    const std::string fffd = "\xEF\xBF\xBD";
    EXPECT_EQ(escape(std::string("a\0b", 3)), "a" + fffd + "b");
    EXPECT_EQ(escape("soh\x01"), "soh" + fffd);
    EXPECT_EQ(escape("\xEF\xBF\xBE"), fffd);       // U+FFFE
    EXPECT_EQ(escape("bad\xFF"), "bad" + fffd);    // invalid lead byte
    EXPECT_EQ(escape("\xC3"), fffd);               // truncated
    EXPECT_EQ(escape("\xC0\xAF"), fffd + fffd);    // overlong
    EXPECT_EQ(escape("\xED\xA0\x80"), fffd + fffd + fffd); // surrogate
}

TEST(Xml, Representable) {
    EXPECT_TRUE(micros3::xml::representable("plain/日本語\t\n"));
    EXPECT_FALSE(micros3::xml::representable("soh\x01"));
    EXPECT_FALSE(micros3::xml::representable("\xFF"));
}

TEST(Xml, WriterBuildsNestedDocument) {
    micros3::xml::Writer writer;
    writer.open("ListAllMyBucketsResult", micros3::xml::kS3Namespace)
        .open("Buckets")
        .open("Bucket")
        .element("Name", "a&b")
        .close();
    EXPECT_EQ(writer.finish(),
              "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
              "<ListAllMyBucketsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">"
              "<Buckets><Bucket><Name>a&amp;b</Name></Bucket></Buckets></ListAllMyBucketsResult>");
}

TEST(Xml, ErrorDocument) {
    const micros3::S3Error error{404, "NoSuchKey", "The specified key does not exist."};
    EXPECT_EQ(micros3::xml::error_document(error, "/bucket/a<b", "0123456789ABCDEF"),
              "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
              "<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message>"
              "<Resource>/bucket/a&lt;b</Resource><RequestId>0123456789ABCDEF</RequestId></Error>");
}
