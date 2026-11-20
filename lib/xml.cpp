#include "micros3/xml.h"

#include <cstdint>

namespace micros3::xml {

namespace {

constexpr std::string_view kReplacement = "\xEF\xBF\xBD"; // U+FFFD

// Decodes one UTF-8 sequence at `pos`. Returns its length, or 0 when it is
// invalid (bad lead byte, truncated, overlong, surrogate or out of range).
std::size_t decode_utf8(std::string_view text, std::size_t pos, std::uint32_t &code) {
    const auto byte = [&](std::size_t i) { return static_cast<unsigned char>(text[i]); };
    const unsigned char lead = byte(pos);
    std::size_t length;
    std::uint32_t min;
    if (lead < 0x80) {
        code = lead;
        return 1;
    } else if ((lead & 0xE0) == 0xC0) {
        length = 2;
        code = lead & 0x1F;
        min = 0x80;
    } else if ((lead & 0xF0) == 0xE0) {
        length = 3;
        code = lead & 0x0F;
        min = 0x800;
    } else if ((lead & 0xF8) == 0xF0) {
        length = 4;
        code = lead & 0x07;
        min = 0x10000;
    } else {
        return 0;
    }
    if (text.size() - pos < length) return 0;
    for (std::size_t i = 1; i < length; ++i) {
        const unsigned char next = byte(pos + i);
        if ((next & 0xC0) != 0x80) return 0;
        code = (code << 6) | (next & 0x3F);
    }
    if (code < min || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return 0;
    return length;
}

bool allowed(std::uint32_t code) {
    if (code < 0x20) return code == 0x9 || code == 0xA || code == 0xD;
    return code != 0xFFFE && code != 0xFFFF;
}

} // namespace

std::string escape(std::string_view text) {
    std::string out;
    out.reserve(text.size());
    std::size_t pos = 0;
    while (pos < text.size()) {
        std::uint32_t code = 0;
        const std::size_t length = decode_utf8(text, pos, code);
        if (length == 0) {
            out += kReplacement;
            ++pos;
            continue;
        }
        if (!allowed(code)) {
            out += kReplacement;
        } else {
            switch (code) {
            case '&': out += "&amp;"; break;
            case '<': out += "&lt;"; break;
            case '>': out += "&gt;"; break;
            case '"': out += "&quot;"; break;
            case '\'': out += "&apos;"; break;
            case '\t': out += "&#x9;"; break;
            case '\n': out += "&#xA;"; break;
            case '\r': out += "&#xD;"; break;
            default: out.append(text.substr(pos, length));
            }
        }
        pos += length;
    }
    return out;
}

bool representable(std::string_view text) {
    std::size_t pos = 0;
    while (pos < text.size()) {
        std::uint32_t code = 0;
        const std::size_t length = decode_utf8(text, pos, code);
        if (length == 0 || !allowed(code)) return false;
        pos += length;
    }
    return true;
}

Writer::Writer() : out_("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n") {}

Writer &Writer::open(std::string_view name, std::string_view xmlns) {
    out_ += '<';
    out_ += name;
    if (!xmlns.empty()) {
        out_ += " xmlns=\"";
        out_ += escape(xmlns);
        out_ += '"';
    }
    out_ += '>';
    open_.emplace_back(name);
    return *this;
}

Writer &Writer::close() {
    if (!open_.empty()) {
        out_ += "</";
        out_ += open_.back();
        out_ += '>';
        open_.pop_back();
    }
    return *this;
}

Writer &Writer::element(std::string_view name, std::string_view text) {
    out_ += '<';
    out_ += name;
    out_ += '>';
    out_ += escape(text);
    out_ += "</";
    out_ += name;
    out_ += '>';
    return *this;
}

std::string Writer::finish() {
    while (!open_.empty()) close();
    return std::move(out_);
}

std::string error_document(const S3Error &error, std::string_view resource, std::string_view request_id) {
    Writer writer;
    writer.open("Error")
        .element("Code", error.code)
        .element("Message", error.message)
        .element("Resource", resource)
        .element("RequestId", request_id);
    return writer.finish();
}

} // namespace micros3::xml
