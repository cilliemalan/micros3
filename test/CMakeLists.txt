add_executable(testmicros3 hello_test.cpp verify_test.cpp ../verification/verify.cpp)
target_include_directories(testmicros3 PRIVATE ../verification)
target_link_libraries(testmicros3 PRIVATE libmicros3 GTest::gtest_main)
