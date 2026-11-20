#pragma once

// A thin RAII wrapper over the SQLite C API: one connection and its prepared
// statements. Errors throw db::Error.

#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>

struct sqlite3;
struct sqlite3_stmt;

namespace micros3::db {

class Error : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

class Statement {
public:
    Statement(sqlite3 *db, std::string_view sql);
    ~Statement();
    Statement(const Statement &) = delete;
    Statement &operator=(const Statement &) = delete;
    Statement(Statement &&other) noexcept;
    Statement &operator=(Statement &&other) noexcept;

    // Parameters are 1-based, as in SQLite.
    Statement &bind_null(int index);
    Statement &bind_int(int index, std::int64_t value);
    Statement &bind_text(int index, std::string_view value);
    Statement &bind_blob(int index, std::string_view value);

    // Advances to the next row. Returns false when the statement is done.
    bool step();
    // Runs the statement to completion, ignoring any rows.
    void run();
    // Clears the bindings and rewinds, so the statement can run again.
    void reset();

    // Columns are 0-based, as in SQLite.
    bool column_is_null(int index) const;
    std::int64_t column_int(int index) const;
    // TEXT or BLOB contents as bytes.
    std::string column_text(int index) const;
    std::string column_blob(int index) const;

private:
    sqlite3 *db_ = nullptr;
    sqlite3_stmt *stmt_ = nullptr;
};

class Database {
public:
    // Opens (creating if needed) the database file at `path`.
    explicit Database(const std::string &path);
    ~Database();
    Database(const Database &) = delete;
    Database &operator=(const Database &) = delete;

    // Runs one or more statements, ignoring any rows.
    void exec(std::string_view sql);
    Statement prepare(std::string_view sql);
    // The first column of the first row, as text. Empty when there is no row.
    std::string query_text(std::string_view sql);

    sqlite3 *handle() const { return db_; }

private:
    sqlite3 *db_ = nullptr;
};

// BEGIN IMMEDIATE on construction; ROLLBACK on destruction unless committed.
class Transaction {
public:
    explicit Transaction(Database &db);
    ~Transaction();
    Transaction(const Transaction &) = delete;
    Transaction &operator=(const Transaction &) = delete;

    void commit();

private:
    Database &db_;
    bool done_ = false;
};

} // namespace micros3::db
