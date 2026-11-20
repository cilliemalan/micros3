#include "micros3/db.h"

#include <sqlite3.h>

#include <utility>

namespace micros3::db {

namespace {

[[noreturn]] void fail(sqlite3 *db, const std::string &what) {
    throw Error(what + ": " + (db != nullptr ? sqlite3_errmsg(db) : "out of memory"));
}

} // namespace

Statement::Statement(sqlite3 *db, std::string_view sql) : db_(db) {
    if (sqlite3_prepare_v2(db, sql.data(), static_cast<int>(sql.size()), &stmt_, nullptr) != SQLITE_OK) {
        fail(db, "prepare failed for '" + std::string(sql) + "'");
    }
    if (stmt_ == nullptr) {
        throw Error("prepare produced no statement for '" + std::string(sql) + "'");
    }
}

Statement::~Statement() { sqlite3_finalize(stmt_); }

Statement::Statement(Statement &&other) noexcept
    : db_(std::exchange(other.db_, nullptr)), stmt_(std::exchange(other.stmt_, nullptr)) {}

Statement &Statement::operator=(Statement &&other) noexcept {
    if (this != &other) {
        sqlite3_finalize(stmt_);
        db_ = std::exchange(other.db_, nullptr);
        stmt_ = std::exchange(other.stmt_, nullptr);
    }
    return *this;
}

Statement &Statement::bind_null(int index) {
    if (sqlite3_bind_null(stmt_, index) != SQLITE_OK) {
        fail(db_, "bind failed");
    }
    return *this;
}

Statement &Statement::bind_int(int index, std::int64_t value) {
    if (sqlite3_bind_int64(stmt_, index, value) != SQLITE_OK) {
        fail(db_, "bind failed");
    }
    return *this;
}

Statement &Statement::bind_text(int index, std::string_view value) {
    if (sqlite3_bind_text64(stmt_, index, value.data(), value.size(), SQLITE_TRANSIENT, SQLITE_UTF8) !=
        SQLITE_OK) {
        fail(db_, "bind failed");
    }
    return *this;
}

Statement &Statement::bind_blob(int index, std::string_view value) {
    // A zero-length blob must not bind as NULL, so pass a non-null pointer.
    const char *data = value.data() != nullptr ? value.data() : "";
    if (sqlite3_bind_blob64(stmt_, index, data, value.size(), SQLITE_TRANSIENT) != SQLITE_OK) {
        fail(db_, "bind failed");
    }
    return *this;
}

bool Statement::step() {
    const int rc = sqlite3_step(stmt_);
    if (rc == SQLITE_ROW) {
        return true;
    }
    if (rc == SQLITE_DONE) {
        return false;
    }
    fail(db_, "step failed");
}

void Statement::run() {
    while (step()) {
    }
}

void Statement::reset() {
    sqlite3_reset(stmt_);
    sqlite3_clear_bindings(stmt_);
}

bool Statement::column_is_null(int index) const { return sqlite3_column_type(stmt_, index) == SQLITE_NULL; }

std::int64_t Statement::column_int(int index) const { return sqlite3_column_int64(stmt_, index); }

std::string Statement::column_text(int index) const {
    const auto *text = reinterpret_cast<const char *>(sqlite3_column_text(stmt_, index));
    const int size = sqlite3_column_bytes(stmt_, index);
    return text != nullptr ? std::string(text, static_cast<std::size_t>(size)) : std::string();
}

std::string Statement::column_blob(int index) const {
    const auto *data = static_cast<const char *>(sqlite3_column_blob(stmt_, index));
    const int size = sqlite3_column_bytes(stmt_, index);
    return data != nullptr ? std::string(data, static_cast<std::size_t>(size)) : std::string();
}

Database::Database(const std::string &path) {
    const int flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX;
    if (sqlite3_open_v2(path.c_str(), &db_, flags, nullptr) != SQLITE_OK) {
        std::string message = "cannot open database '" + path + "'";
        if (db_ != nullptr) {
            message += ": ";
            message += sqlite3_errmsg(db_);
            sqlite3_close(db_);
            db_ = nullptr;
        }
        throw Error(message);
    }
    sqlite3_extended_result_codes(db_, 1);
}

Database::~Database() { sqlite3_close_v2(db_); }

void Database::exec(std::string_view sql) {
    const std::string text(sql);
    if (sqlite3_exec(db_, text.c_str(), nullptr, nullptr, nullptr) != SQLITE_OK) {
        fail(db_, "exec failed for '" + text + "'");
    }
}

Statement Database::prepare(std::string_view sql) { return Statement(db_, sql); }

std::string Database::query_text(std::string_view sql) {
    Statement stmt = prepare(sql);
    return stmt.step() ? stmt.column_text(0) : std::string();
}

Transaction::Transaction(Database &db) : db_(db) { db_.exec("BEGIN IMMEDIATE"); }

Transaction::~Transaction() {
    if (!done_) {
        try {
            db_.exec("ROLLBACK");
        } catch (...) {
        }
    }
}

void Transaction::commit() {
    db_.exec("COMMIT");
    done_ = true;
}

} // namespace micros3::db
