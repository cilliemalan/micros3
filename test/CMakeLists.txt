add_executable(testmicros3 hello_test.cpp)
target_link_libraries(testmicros3 PRIVATE libmicros3 GTest::gtest_main)
