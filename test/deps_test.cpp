// Smoke tests that the third-party libraries are linked and pinned.

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>
#include <pugixml.hpp>
#include <sqlite3.h>

#include <string>

TEST(Deps, SqliteVersionAndWal) {
    EXPECT_STREQ(sqlite3_libversion(), "3.54.1");
    sqlite3 *db = nullptr;
    ASSERT_EQ(sqlite3_open(":memory:", &db), SQLITE_OK);
    char *err = nullptr;
    EXPECT_EQ(sqlite3_exec(db,
                           "CREATE TABLE t (k BLOB PRIMARY KEY);"
                           "INSERT INTO t VALUES (x'c3a9'), (x'61'), (x'7a');",
                           nullptr, nullptr, &err),
              SQLITE_OK)
        << (err ? err : "");
    sqlite3_free(err);
    // BLOB keys sort by memcmp, giving UTF-8 byte order.
    sqlite3_stmt *stmt = nullptr;
    ASSERT_EQ(sqlite3_prepare_v2(db, "SELECT hex(k) FROM t ORDER BY k", -1, &stmt, nullptr),
              SQLITE_OK);
    std::string order;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        order += reinterpret_cast<const char *>(sqlite3_column_text(stmt, 0));
        order += ",";
    }
    sqlite3_finalize(stmt);
    EXPECT_EQ(order, "61,7A,C3A9,");
    sqlite3_close(db);
}

TEST(Deps, NlohmannJsonRoundTrip) {
    nlohmann::json j = {{"Content-Type", "text/plain"}, {"x-amz-meta-a", "b"}};
    auto text = j.dump();
    EXPECT_EQ(nlohmann::json::parse(text), j);
    EXPECT_EQ(NLOHMANN_JSON_VERSION_MAJOR, 3);
    EXPECT_EQ(NLOHMANN_JSON_VERSION_MINOR, 12);
}

TEST(Deps, PugixmlParses) {
    EXPECT_EQ(PUGIXML_VERSION, 1160);
    pugi::xml_document doc;
    auto result = doc.load_string(
        "<Delete><Quiet>true</Quiet><Object><Key>a&amp;b</Key></Object></Delete>");
    ASSERT_TRUE(result);
    EXPECT_STREQ(doc.child("Delete").child("Object").child_value("Key"), "a&b");
}
