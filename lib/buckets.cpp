#include "micros3/buckets.h"

#include "micros3/objects.h"

#include <filesystem>
#include <system_error>

namespace micros3::buckets {

namespace {

bool is_lower_alnum(char c) { return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'); }

bool starts_with(std::string_view s, std::string_view prefix) { return s.substr(0, prefix.size()) == prefix; }

bool ends_with(std::string_view s, std::string_view suffix) {
    return s.size() >= suffix.size() && s.substr(s.size() - suffix.size()) == suffix;
}

// Four dot-separated groups of one to three digits, like 192.168.5.4.
bool looks_like_ipv4(std::string_view name) {
    int groups = 0;
    std::size_t pos = 0;
    while (true) {
        std::size_t digits = 0;
        while (pos < name.size() && name[pos] >= '0' && name[pos] <= '9') {
            ++pos;
            ++digits;
        }
        if (digits == 0 || digits > 3) return false;
        ++groups;
        if (pos == name.size()) return groups == 4;
        if (name[pos] != '.') return false;
        ++pos;
    }
}

Bucket read_bucket(const db::Statement &stmt) {
    return Bucket{stmt.column_text(0), stmt.column_int(1), stmt.column_text(2)};
}

// The blob ids of the parts of every upload in bucket `name`.
std::vector<std::string> upload_part_blobs(Store &store, std::string_view name) {
    std::vector<std::string> blobs;
    db::Statement parts =
        store.db().prepare("SELECT parts.blob_id FROM parts JOIN uploads USING (upload_id) WHERE uploads.bucket = ?");
    parts.bind_text(1, name);
    while (parts.step()) blobs.push_back(parts.column_text(0));
    return blobs;
}

// Removes blob files after a commit. A leftover is removed at the next startup.
void remove_blobs(Store &store, const std::vector<std::string> &blobs) {
    for (const std::string &blob : blobs) objects::remove_blob(store, blob);
}

} // namespace

bool valid_region(std::string_view region) {
    if (region == "EU") return true;
    if (region.empty() || region.size() > 64) return false;
    for (char c : region) {
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) return false;
    }
    return true;
}

bool valid_name(std::string_view name) {
    if (name.size() < 3 || name.size() > 63) return false;
    for (char c : name) {
        if (!is_lower_alnum(c) && c != '.' && c != '-') return false;
    }
    if (!is_lower_alnum(name.front()) || !is_lower_alnum(name.back())) return false;
    if (name.find("..") != std::string_view::npos) return false;
    if (looks_like_ipv4(name)) return false;
    for (std::string_view prefix : {"xn--", "sthree-", "amzn-s3-demo-"}) {
        if (starts_with(name, prefix)) return false;
    }
    for (std::string_view suffix : {"-s3alias", "--ol-s3", ".mrap", "--x-s3", "--table-s3"}) {
        if (ends_with(name, suffix)) return false;
    }
    return true;
}

std::optional<Bucket> find(Store &store, std::string_view name) {
    db::Statement stmt = store.db().prepare("SELECT name, created_ms, region FROM buckets WHERE name = ?");
    stmt.bind_text(1, name);
    if (!stmt.step()) return std::nullopt;
    return read_bucket(stmt);
}

std::optional<Bucket> create(Store &store, std::string_view name, std::string_view region, std::int64_t created_ms) {
    db::Transaction txn(store.db());
    if (auto existing = find(store, name)) return existing;
    store.db()
        .prepare("INSERT INTO buckets (name, created_ms, region) VALUES (?, ?, ?)")
        .bind_text(1, name)
        .bind_int(2, created_ms)
        .bind_text(3, region)
        .run();
    txn.commit();
    return std::nullopt;
}

std::vector<Bucket> list(Store &store, std::string_view prefix, std::string_view after,
                         const std::optional<std::string> &region, std::size_t limit) {
    // Names are ASCII, so the default BINARY collation is byte order. The
    // prefix is matched with substr rather than LIKE, which has wildcards.
    db::Statement stmt = store.db().prepare(
        "SELECT name, created_ms, region FROM buckets "
        "WHERE name > ? AND substr(name, 1, length(?2)) = ?2 AND (?3 IS NULL OR region = ?3) "
        "ORDER BY name LIMIT ?4");
    stmt.bind_text(1, after).bind_text(2, prefix);
    if (region) {
        stmt.bind_text(3, *region);
    } else {
        stmt.bind_null(3);
    }
    stmt.bind_int(4, static_cast<std::int64_t>(limit));
    std::vector<Bucket> result;
    while (stmt.step()) result.push_back(read_bucket(stmt));
    return result;
}

DeleteResult remove(Store &store, std::string_view name) {
    std::vector<std::string> part_blobs;
    {
        db::Transaction txn(store.db());
        if (!find(store, name)) return DeleteResult::NoSuchBucket;
        {
            db::Statement objects = store.db().prepare("SELECT 1 FROM objects WHERE bucket = ? LIMIT 1");
            objects.bind_text(1, name);
            if (objects.step()) return DeleteResult::NotEmpty;
        }
        part_blobs = upload_part_blobs(store, name);
        // Uploads and parts go with the bucket (ON DELETE CASCADE).
        store.db().prepare("DELETE FROM buckets WHERE name = ?").bind_text(1, name).run();
        txn.commit();
    }
    remove_blobs(store, part_blobs);
    return DeleteResult::Deleted;
}

EmptyResult empty(Store &store, std::string_view name) {
    if (!find(store, name)) return EmptyResult::NoSuchBucket;
    db::Statement batch = store.db().prepare("SELECT key FROM objects WHERE bucket = ? ORDER BY key LIMIT ?");
    for (;;) {
        std::vector<std::string> keys;
        batch.reset();
        batch.bind_text(1, name).bind_int(2, static_cast<std::int64_t>(kEmptyBatch));
        while (batch.step()) keys.push_back(batch.column_blob(0));
        batch.reset();
        if (keys.empty()) break;
        if (objects::remove_many(store, name, keys) == objects::DeleteResult::NoSuchBucket) {
            return EmptyResult::NoSuchBucket;
        }
    }
    std::vector<std::string> part_blobs;
    {
        db::Transaction txn(store.db());
        if (!find(store, name)) return EmptyResult::NoSuchBucket;
        part_blobs = upload_part_blobs(store, name);
        // Parts go with their uploads (ON DELETE CASCADE).
        store.db().prepare("DELETE FROM uploads WHERE bucket = ?").bind_text(1, name).run();
        txn.commit();
    }
    remove_blobs(store, part_blobs);
    return EmptyResult::Emptied;
}

} // namespace micros3::buckets
