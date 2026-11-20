add_executable(testmicros3
    buckets_test.cpp
    conditions_test.cpp
    config_test.cpp
    digest_test.cpp
    listing_test.cpp
    deps_test.cpp
    objects_test.cpp
    router_test.cpp
    server_test.cpp
    sigv4_test.cpp
    store_test.cpp
    xml_test.cpp
)
target_link_libraries(testmicros3 PRIVATE libmicros3 GTest::gtest_main)
