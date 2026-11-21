#include "micros3/uploads.h"

#include "micros3/digest.h"
#include "micros3/listing.h"

namespace micros3::uploads {

namespace {

bool starts_with(std::string_view text, std::string_view prefix) {
    return text.size() >= prefix.size() && text.compare(0, prefix.size(), prefix) == 0;
}

// The common prefix `key` rolls up into, or nullopt when it has none.
std::optional<std::string> common_prefix(std::string_view key, const ListRequest &request) {
    if (request.delimiter.empty() || !starts_with(key, request.prefix)) return std::nullopt;
    const std::size_t at = key.find(request.delimiter, request.prefix.size());
    if (at == std::string_view::npos) return std::nullopt;
    return std::string(key.substr(0, at + request.delimiter.size()));
}

bool upload_exists(Store &store, const Upload &upload) {
    db::Statement stmt = store.db().prepare("SELECT 1 FROM uploads WHERE upload_id = ? AND bucket = ? AND key = ?");
    stmt.bind_text(1, upload.upload_id).bind_text(2, upload.bucket).bind_blob(3, upload.key);
    return stmt.step();
}

std::vector<std::string> part_blobs(Store &store, std::string_view upload_id) {
    std::vector<std::string> blobs;
    db::Statement stmt = store.db().prepare("SELECT blob_id FROM parts WHERE upload_id = ?");
    stmt.bind_text(1, upload_id);
    while (stmt.step()) blobs.push_back(stmt.column_text(0));
    return blobs;
}

void delete_upload(Store &store, std::string_view upload_id) {
    // The part rows go with the upload (ON DELETE CASCADE).
    store.db().prepare("DELETE FROM uploads WHERE upload_id = ?").bind_text(1, upload_id).run();
}

std::vector<Part> read_parts(db::Statement &stmt) {
    std::vector<Part> parts;
    while (stmt.step()) {
        Part part;
        part.number = static_cast<int>(stmt.column_int(0));
        part.blob_id = stmt.column_text(1);
        part.size = static_cast<std::uint64_t>(stmt.column_int(2));
        part.etag = stmt.column_text(3);
        part.last_modified_ms = stmt.column_int(4);
        parts.push_back(std::move(part));
    }
    return parts;
}

int hex_value(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

// Rows are read in batches of at most this many.
constexpr std::int64_t kBatch = 1000;

} // namespace

std::string new_upload_id(std::int64_t initiated_ms) {
    static constexpr char kHex[] = "0123456789abcdef";
    std::string id(12, '0');
    auto bits = static_cast<std::uint64_t>(initiated_ms);
    for (std::size_t i = id.size(); i-- > 0;) {
        id[i] = kHex[bits & 0xF];
        bits >>= 4;
    }
    return id + objects::new_blob_id().substr(0, 20);
}

bool create(Store &store, const Upload &upload) {
    db::Transaction txn(store.db());
    {
        db::Statement bucket = store.db().prepare("SELECT 1 FROM buckets WHERE name = ?");
        bucket.bind_text(1, upload.bucket);
        if (!bucket.step()) return false;
    }
    store.db()
        .prepare("INSERT INTO uploads (upload_id, bucket, key, initiated_ms, headers) VALUES (?, ?, ?, ?, ?)")
        .bind_text(1, upload.upload_id)
        .bind_text(2, upload.bucket)
        .bind_blob(3, upload.key)
        .bind_int(4, upload.initiated_ms)
        .bind_text(5, objects::headers_to_json(upload.headers))
        .run();
    txn.commit();
    return true;
}

std::optional<Upload> find(Store &store, std::string_view bucket, std::string_view key, std::string_view upload_id) {
    db::Statement stmt = store.db().prepare(
        "SELECT initiated_ms, headers FROM uploads WHERE upload_id = ? AND bucket = ? AND key = ?");
    stmt.bind_text(1, upload_id).bind_text(2, bucket).bind_blob(3, key);
    if (!stmt.step()) return std::nullopt;
    Upload upload;
    upload.upload_id = std::string(upload_id);
    upload.bucket = std::string(bucket);
    upload.key = std::string(key);
    upload.initiated_ms = stmt.column_int(0);
    upload.headers = objects::headers_from_json(stmt.column_text(1));
    return upload;
}

Result put_part(Store &store, const Upload &upload, const Part &part, std::optional<std::string> &replaced_blob) {
    replaced_blob.reset();
    db::Transaction txn(store.db());
    if (!upload_exists(store, upload)) return Result::NoSuchUpload;
    {
        db::Statement old = store.db().prepare("SELECT blob_id FROM parts WHERE upload_id = ? AND part_number = ?");
        old.bind_text(1, upload.upload_id).bind_int(2, part.number);
        if (old.step()) replaced_blob = old.column_text(0);
    }
    store.db()
        .prepare("INSERT INTO parts (upload_id, part_number, blob_id, size, etag, last_modified_ms) "
                 "VALUES (?, ?, ?, ?, ?, ?) "
                 "ON CONFLICT (upload_id, part_number) DO UPDATE SET blob_id = excluded.blob_id, "
                 "size = excluded.size, etag = excluded.etag, last_modified_ms = excluded.last_modified_ms")
        .bind_text(1, upload.upload_id)
        .bind_int(2, part.number)
        .bind_text(3, part.blob_id)
        .bind_int(4, static_cast<std::int64_t>(part.size))
        .bind_text(5, part.etag)
        .bind_int(6, part.last_modified_ms)
        .run();
    txn.commit();
    if (replaced_blob == part.blob_id) replaced_blob.reset();
    return Result::Done;
}

std::vector<Part> list_parts(Store &store, std::string_view upload_id, int after, std::size_t limit) {
    db::Statement stmt = store.db().prepare(
        "SELECT part_number, blob_id, size, etag, last_modified_ms FROM parts "
        "WHERE upload_id = ? AND part_number > ? ORDER BY part_number LIMIT ?");
    stmt.bind_text(1, upload_id).bind_int(2, after).bind_int(3, static_cast<std::int64_t>(limit));
    return read_parts(stmt);
}

std::vector<Part> all_parts(Store &store, std::string_view upload_id) {
    db::Statement stmt = store.db().prepare(
        "SELECT part_number, blob_id, size, etag, last_modified_ms FROM parts WHERE upload_id = ? "
        "ORDER BY part_number");
    stmt.bind_text(1, upload_id);
    return read_parts(stmt);
}

Result abort(Store &store, const Upload &upload) {
    std::vector<std::string> blobs;
    {
        db::Transaction txn(store.db());
        if (!upload_exists(store, upload)) return Result::NoSuchUpload;
        blobs = part_blobs(store, upload.upload_id);
        delete_upload(store, upload.upload_id);
        txn.commit();
    }
    for (const std::string &blob : blobs) objects::remove_blob(store, blob);
    return Result::Done;
}

Result complete(Store &store, const Upload &upload, const objects::Object &object) {
    std::vector<std::string> blobs;
    std::optional<std::string> replaced;
    {
        db::Transaction txn(store.db());
        // The upload is gone when it was completed or aborted meanwhile, or
        // deleted with its bucket.
        if (!upload_exists(store, upload)) return Result::NoSuchUpload;
        blobs = part_blobs(store, upload.upload_id);
        replaced = objects::upsert(store, object);
        delete_upload(store, upload.upload_id);
        txn.commit();
    }
    for (const std::string &blob : blobs) objects::remove_blob(store, blob);
    if (replaced) objects::remove_blob(store, *replaced);
    return Result::Done;
}

std::optional<std::string> multipart_etag(const std::vector<std::string> &part_etags) {
    std::string md5s;
    for (const std::string &etag : part_etags) {
        if (etag.size() != 34 || etag.front() != '"' || etag.back() != '"') return std::nullopt;
        for (std::size_t i = 1; i < 33; i += 2) {
            const int high = hex_value(etag[i]);
            const int low = hex_value(etag[i + 1]);
            if (high < 0 || low < 0) return std::nullopt;
            md5s += static_cast<char>(high * 16 + low);
        }
    }
    return "\"" + digest::hex(digest::md5(md5s)) + "-" + std::to_string(part_etags.size()) + "\"";
}

std::optional<ListPage> list(Store &store, std::string_view bucket, const ListRequest &request) {
    {
        db::Statement exists = store.db().prepare("SELECT 1 FROM buckets WHERE name = ?");
        exists.bind_text(1, bucket);
        if (!exists.step()) return std::nullopt;
    }
    ListPage page;
    if (request.max_uploads == 0) return page;

    // The position after which to read: uploads with a key above `bound`,
    // or with key `bound` and an upload ID above `bound_id`. A null
    // `bound_id` excludes the whole of key `bound`; an empty one includes it.
    std::string bound = request.prefix;
    std::optional<std::string> bound_id = std::string();
    if (!request.key_marker.empty() && request.key_marker >= request.prefix) {
        bound = request.key_marker;
        bound_id.reset();
        if (!request.upload_id_marker.empty()) bound_id = request.upload_id_marker;
        // A marker inside a common prefix (or equal to it) has already seen
        // that prefix, so the listing resumes after all of its keys.
        if (auto prefix = common_prefix(request.key_marker, request)) {
            auto end = listing::prefix_end(*prefix);
            if (!end) return page;
            bound = std::move(*end);
            bound_id = std::string();
        }
    }

    db::Statement stmt = store.db().prepare(
        "SELECT key, upload_id, initiated_ms FROM uploads "
        "WHERE bucket = ?1 AND (key > ?2 OR (key = ?2 AND upload_id > ?3)) ORDER BY key, upload_id LIMIT ?4");
    for (;;) {
        stmt.reset();
        stmt.bind_text(1, bucket).bind_blob(2, bound).bind_int(4, kBatch);
        if (bound_id) {
            stmt.bind_text(3, *bound_id);
        } else {
            stmt.bind_null(3);
        }
        std::int64_t rows = 0;
        bool jumped = false;
        while (stmt.step()) {
            ++rows;
            std::string key = stmt.column_blob(0);
            if (!starts_with(key, request.prefix)) return page;
            if (page.entries.size() == request.max_uploads) {
                page.truncated = true;
                return page;
            }
            if (auto prefix = common_prefix(key, request)) {
                auto end = listing::prefix_end(*prefix);
                page.entries.push_back(ListEntry{true, std::move(*prefix), {}, 0});
                if (!end) return page;
                bound = std::move(*end);
                bound_id = std::string();
                jumped = true;
                break;
            }
            ListEntry entry;
            entry.key = std::move(key);
            entry.upload_id = stmt.column_text(1);
            entry.initiated_ms = stmt.column_int(2);
            bound = entry.key;
            bound_id = entry.upload_id;
            page.entries.push_back(std::move(entry));
        }
        if (!jumped && rows < kBatch) return page;
    }
}

} // namespace micros3::uploads
