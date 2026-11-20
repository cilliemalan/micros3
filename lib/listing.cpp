#include "micros3/listing.h"

namespace micros3::listing {

namespace {

bool starts_with(std::string_view text, std::string_view prefix) {
    return text.size() >= prefix.size() && text.compare(0, prefix.size(), prefix) == 0;
}

// The common prefix `key` rolls up into, or nullopt when it has none.
std::optional<std::string> common_prefix(std::string_view key, const Request &request) {
    if (request.delimiter.empty() || !starts_with(key, request.prefix)) return std::nullopt;
    const std::size_t at = key.find(request.delimiter, request.prefix.size());
    if (at == std::string_view::npos) return std::nullopt;
    return std::string(key.substr(0, at + request.delimiter.size()));
}

// Rows are read in batches of at most this many.
constexpr std::int64_t kBatch = 1000;

} // namespace

std::optional<std::string> prefix_end(std::string_view prefix) {
    std::string end(prefix);
    while (!end.empty() && static_cast<unsigned char>(end.back()) == 0xFF) end.pop_back();
    if (end.empty()) return std::nullopt;
    end.back() = static_cast<char>(static_cast<unsigned char>(end.back()) + 1);
    return end;
}

std::optional<Page> list(Store &store, std::string_view bucket, const Request &request) {
    {
        db::Statement exists = store.db().prepare("SELECT 1 FROM buckets WHERE name = ?");
        exists.bind_text(1, bucket);
        if (!exists.step()) return std::nullopt;
    }
    Page page;
    if (request.max_keys == 0) return page;

    // The lower bound of the next key to read, and whether it is inclusive.
    std::string bound = request.prefix;
    bool inclusive = true;
    if (!request.after.empty() && request.after >= request.prefix) {
        bound = request.after;
        inclusive = false;
        // A marker inside a common prefix (or equal to it) has already seen
        // that prefix, so the listing resumes after all of its keys.
        if (auto prefix = common_prefix(request.after, request)) {
            auto end = prefix_end(*prefix);
            if (!end) return page;
            bound = std::move(*end);
            inclusive = true;
        }
    }

    db::Statement from = store.db().prepare(
        "SELECT key, size, etag, last_modified_ms FROM objects WHERE bucket = ? AND key >= ? ORDER BY key LIMIT ?");
    db::Statement after = store.db().prepare(
        "SELECT key, size, etag, last_modified_ms FROM objects WHERE bucket = ? AND key > ? ORDER BY key LIMIT ?");

    for (;;) {
        db::Statement &stmt = inclusive ? from : after;
        stmt.reset();
        stmt.bind_text(1, bucket).bind_blob(2, bound).bind_int(3, kBatch);
        std::int64_t rows = 0;
        bool jumped = false;
        while (stmt.step()) {
            ++rows;
            std::string key = stmt.column_blob(0);
            if (!starts_with(key, request.prefix)) return page;
            if (page.entries.size() == request.max_keys) {
                page.truncated = true;
                return page;
            }
            if (auto prefix = common_prefix(key, request)) {
                auto end = prefix_end(*prefix);
                page.entries.push_back(Entry{true, std::move(*prefix)});
                if (!end) return page;
                bound = std::move(*end);
                inclusive = true;
                jumped = true;
                break;
            }
            Entry entry;
            entry.key = std::move(key);
            entry.size = static_cast<std::uint64_t>(stmt.column_int(1));
            entry.etag = stmt.column_text(2);
            entry.last_modified_ms = stmt.column_int(3);
            bound = entry.key;
            inclusive = false;
            page.entries.push_back(std::move(entry));
        }
        if (!jumped && rows < kBatch) return page;
    }
}

std::string url_encode(std::string_view value) {
    static constexpr char kHex[] = "0123456789ABCDEF";
    std::string out;
    out.reserve(value.size());
    for (char c : value) {
        const auto byte = static_cast<unsigned char>(c);
        if ((byte >= 'A' && byte <= 'Z') || (byte >= 'a' && byte <= 'z') || (byte >= '0' && byte <= '9') ||
            byte == '-' || byte == '_' || byte == '.' || byte == '~' || byte == '/') {
            out += c;
        } else if (byte == ' ') {
            out += '+';
        } else {
            out += '%';
            out += kHex[byte >> 4];
            out += kHex[byte & 0xF];
        }
    }
    return out;
}

} // namespace micros3::listing
