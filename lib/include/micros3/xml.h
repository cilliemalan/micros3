#pragma once

// XML output for success and error bodies.
//
// Text is escaped so the document is well-formed XML 1.0: `&`, `<`, `>`, `"`
// and `'` become entity references; tab, line feed and carriage return become
// character references, so parsers do not normalize them away. Characters XML
// 1.0 forbids (other C0 controls, U+FFFE, U+FFFF) and invalid UTF-8 cannot be
// represented at all, and are replaced with U+FFFD.

#include "micros3/s3error.h"

#include <string>
#include <string_view>
#include <vector>

namespace micros3::xml {

inline constexpr std::string_view kS3Namespace = "http://s3.amazonaws.com/doc/2006-03-01/";

// Escapes text for an element body or attribute value.
std::string escape(std::string_view text);

// True when `text` is valid UTF-8 with no character XML 1.0 forbids, so that
// escape() represents it exactly.
bool representable(std::string_view text);

// Builds a document element by element. The declaration is written first.
class Writer {
public:
    Writer();

    // Opens an element, with an optional default namespace.
    Writer &open(std::string_view name, std::string_view xmlns = {});
    // Closes the innermost open element.
    Writer &close();
    // Writes <name>text</name>.
    Writer &element(std::string_view name, std::string_view text);

    // Closes any open elements and returns the document.
    std::string finish();

private:
    std::string out_;
    std::vector<std::string> open_;
};

// The S3 error document: Code, Message, Resource and RequestId.
std::string error_document(const S3Error &error, std::string_view resource, std::string_view request_id);

} // namespace micros3::xml
