add_library(libmicros3 STATIC hello.cpp)
set_target_properties(libmicros3 PROPERTIES OUTPUT_NAME micros3)
target_include_directories(libmicros3 PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
