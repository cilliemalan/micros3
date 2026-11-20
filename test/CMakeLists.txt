add_executable(testmicros3
    config_test.cpp
    digest_test.cpp
    deps_test.cpp
    router_test.cpp
    server_test.cpp
    xml_test.cpp
)
target_link_libraries(testmicros3 PRIVATE libmicros3 GTest::gtest_main)
