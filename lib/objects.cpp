#include "micros3/objects.h"

#include <nlohmann/json.hpp>

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <array>
#include <cerrno>
#include <random>
#include <system_error>

namespace micros3::objects {

namespace {

constexpr std::array<std::string_view, 6> kStoredHeaders = {
    "Content-Type", "Cache-Control", "Content-Disposition", "Content-Encoding", "Content-Language", "Expires",
};

constexpr std::string_view kUserMetadataPrefix = "x-amz-meta-";

bool equals_lower(std::string_view lower, std::string_view name) {
    if (lower.size() != name.size()) return false;
    for (std::size_t i = 0; i < name.size(); ++i) {
        char c = name[i];
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
        if (c != lower[i]) return false;
    }
    return true;
}

[[noreturn]] void throw_errno(const std::string &what) {
    throw std::system_error(errno, std::generic_category(), what);
}

void fsync_dir(const std::filesystem::path &dir) {
    const int fd = ::open(dir.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0) throw_errno("open " + dir.string());
    const int rc = ::fsync(fd);
    const int saved = errno;
    ::close(fd);
    if (rc != 0) {
        errno = saved;
        throw_errno("fsync " + dir.string());
    }
}

Object read_object(db::Statement &stmt, std::string_view bucket, std::string_view key) {
    Object object;
    object.bucket = std::string(bucket);
    object.key = std::string(key);
    object.blob_id = stmt.column_text(0);
    object.size = static_cast<std::uint64_t>(stmt.column_int(1));
    object.etag = stmt.column_text(2);
    object.last_modified_ms = stmt.column_int(3);
    object.headers = headers_from_json(stmt.column_text(4));
    return object;
}

} // namespace

http::Headers metadata_from(const http::Request &request) {
    http::Headers out;
    for (const auto &[name, value] : request.headers) {
        if (name.size() > kUserMetadataPrefix.size() && name.compare(0, kUserMetadataPrefix.size(), kUserMetadataPrefix) == 0) {
            out.emplace_back(name, value);
            continue;
        }
        for (std::string_view stored : kStoredHeaders) {
            if (equals_lower(name, stored)) out.emplace_back(std::string(stored), value);
        }
    }
    return out;
}

std::size_t user_metadata_bytes(const http::Headers &headers) {
    std::size_t total = 0;
    for (const auto &[name, value] : headers) {
        if (name.compare(0, kUserMetadataPrefix.size(), kUserMetadataPrefix) == 0) {
            total += name.size() - kUserMetadataPrefix.size() + value.size();
        }
    }
    return total;
}

std::string headers_to_json(const http::Headers &headers) {
    nlohmann::json json = nlohmann::json::object();
    for (const auto &[name, value] : headers) json[name] = value;
    // Header values may hold bytes that are not UTF-8; keep them as they are.
    return json.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
}

http::Headers headers_from_json(std::string_view json_text) {
    http::Headers out;
    const nlohmann::json json = nlohmann::json::parse(json_text, nullptr, false);
    if (!json.is_object()) return out;
    for (const auto &[name, value] : json.items()) {
        if (value.is_string()) out.emplace_back(name, value.get<std::string>());
    }
    return out;
}

std::optional<Object> find(Store &store, std::string_view bucket, std::string_view key) {
    db::Statement stmt = store.db().prepare(
        "SELECT blob_id, size, etag, last_modified_ms, headers FROM objects WHERE bucket = ? AND key = ?");
    stmt.bind_text(1, bucket).bind_blob(2, key);
    if (!stmt.step()) return std::nullopt;
    return read_object(stmt, bucket, key);
}

PutResult put(Store &store, const Object &object, std::optional<std::string> &replaced_blob) {
    replaced_blob.reset();
    db::Transaction txn(store.db());
    {
        db::Statement bucket = store.db().prepare("SELECT 1 FROM buckets WHERE name = ?");
        bucket.bind_text(1, object.bucket);
        if (!bucket.step()) return PutResult::NoSuchBucket;
    }
    {
        db::Statement old = store.db().prepare("SELECT blob_id FROM objects WHERE bucket = ? AND key = ?");
        old.bind_text(1, object.bucket).bind_blob(2, object.key);
        if (old.step()) replaced_blob = old.column_text(0);
    }
    store.db()
        .prepare("INSERT INTO objects (bucket, key, blob_id, size, etag, last_modified_ms, headers) "
                 "VALUES (?, ?, ?, ?, ?, ?, ?) "
                 "ON CONFLICT (bucket, key) DO UPDATE SET blob_id = excluded.blob_id, size = excluded.size, "
                 "etag = excluded.etag, last_modified_ms = excluded.last_modified_ms, headers = excluded.headers")
        .bind_text(1, object.bucket)
        .bind_blob(2, object.key)
        .bind_text(3, object.blob_id)
        .bind_int(4, static_cast<std::int64_t>(object.size))
        .bind_text(5, object.etag)
        .bind_int(6, object.last_modified_ms)
        .bind_text(7, headers_to_json(object.headers))
        .run();
    txn.commit();
    if (replaced_blob == object.blob_id) replaced_blob.reset();
    return PutResult::Stored;
}

DeleteResult remove(Store &store, std::string_view bucket, std::string_view key) {
    std::optional<std::string> blob;
    {
        db::Transaction txn(store.db());
        {
            db::Statement exists = store.db().prepare("SELECT 1 FROM buckets WHERE name = ?");
            exists.bind_text(1, bucket);
            if (!exists.step()) return DeleteResult::NoSuchBucket;
        }
        {
            db::Statement old = store.db().prepare("SELECT blob_id FROM objects WHERE bucket = ? AND key = ?");
            old.bind_text(1, bucket).bind_blob(2, key);
            if (!old.step()) return DeleteResult::Deleted;
            blob = old.column_text(0);
        }
        store.db().prepare("DELETE FROM objects WHERE bucket = ? AND key = ?").bind_text(1, bucket).bind_blob(2, key).run();
        txn.commit();
    }
    remove_blob(store, *blob);
    return DeleteResult::Deleted;
}

DeleteResult remove_many(Store &store, std::string_view bucket, const std::vector<std::string> &keys) {
    std::vector<std::string> blobs;
    {
        db::Transaction txn(store.db());
        {
            db::Statement exists = store.db().prepare("SELECT 1 FROM buckets WHERE name = ?");
            exists.bind_text(1, bucket);
            if (!exists.step()) return DeleteResult::NoSuchBucket;
        }
        for (const std::string &key : keys) {
            db::Statement old = store.db().prepare("DELETE FROM objects WHERE bucket = ? AND key = ? RETURNING blob_id");
            old.bind_text(1, bucket).bind_blob(2, key);
            while (old.step()) blobs.push_back(old.column_text(0));
        }
        txn.commit();
    }
    for (const std::string &blob : blobs) remove_blob(store, blob);
    return DeleteResult::Deleted;
}

std::string new_blob_id() {
    thread_local std::mt19937_64 engine{[] {
        std::random_device device;
        std::seed_seq seed{device(), device(), device(), device()};
        return std::mt19937_64(seed);
    }()};
    static constexpr char kHex[] = "0123456789abcdef";
    std::string id(32, '0');
    std::uint64_t bits = 0;
    for (std::size_t i = 0; i < id.size(); ++i) {
        if (i % 16 == 0) bits = engine();
        id[i] = kHex[bits & 0xF];
        bits >>= 4;
    }
    return id;
}

void remove_blob(Store &store, const std::string &blob_id) {
    std::error_code ec;
    std::filesystem::remove(store.blob_path(blob_id), ec);
}

StagedBlob::StagedBlob(Store &store) : store_(store), id_(new_blob_id()) {
    const std::filesystem::path path = store_.staging_dir() / id_;
    fd_ = ::open(path.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0644);
    if (fd_ < 0) throw_errno("create " + path.string());
}

StagedBlob::~StagedBlob() { discard(); }

void StagedBlob::write(std::string_view data) {
    while (!data.empty()) {
        const ssize_t n = ::write(fd_, data.data(), data.size());
        if (n < 0) {
            if (errno == EINTR) continue;
            throw_errno("write staging file " + id_);
        }
        data.remove_prefix(static_cast<std::size_t>(n));
        size_ += static_cast<std::uint64_t>(n);
    }
}

void StagedBlob::copy_from(const std::filesystem::path &path) {
    const int in = ::open(path.c_str(), O_RDONLY | O_CLOEXEC);
    if (in < 0) throw_errno("open " + path.string());
    struct Closer {
        int fd;
        ~Closer() { ::close(fd); }
    } closer{in};
    // copy_file_range lets the file system share or copy the data in the
    // kernel. Fall back to read and write where it is not supported.
    for (;;) {
        const ssize_t n = ::copy_file_range(in, nullptr, fd_, nullptr, 1 << 30, 0);
        if (n > 0) {
            size_ += static_cast<std::uint64_t>(n);
            continue;
        }
        if (n == 0) return;
        if (errno == EINTR) continue;
        if (errno == EXDEV || errno == ENOSYS || errno == EOPNOTSUPP || errno == EINVAL) break;
        throw_errno("copy " + path.string());
    }
    std::string buffer(1 << 20, '\0');
    for (;;) {
        const ssize_t n = ::read(in, buffer.data(), buffer.size());
        if (n < 0) {
            if (errno == EINTR) continue;
            throw_errno("read " + path.string());
        }
        if (n == 0) return;
        write(std::string_view(buffer.data(), static_cast<std::size_t>(n)));
    }
}

std::string StagedBlob::commit() {
    const std::filesystem::path from = store_.staging_dir() / id_;
    const std::filesystem::path to = store_.blob_path(id_);
    try {
        if (::fsync(fd_) != 0) throw_errno("fsync staging file " + id_);
        if (::close(fd_) != 0) {
            fd_ = -1;
            throw_errno("close staging file " + id_);
        }
        fd_ = -1;
        if (::rename(from.c_str(), to.c_str()) != 0) throw_errno("rename staging file " + id_);
        done_ = true;
        fsync_dir(store_.blobs_dir());
    } catch (...) {
        if (done_) remove_blob(store_, id_);
        done_ = false;
        discard();
        throw;
    }
    return id_;
}

void StagedBlob::discard() {
    if (fd_ >= 0) {
        ::close(fd_);
        fd_ = -1;
    }
    if (!done_) {
        std::error_code ec;
        std::filesystem::remove(store_.staging_dir() / id_, ec);
        done_ = true;
    }
}

} // namespace micros3::objects
