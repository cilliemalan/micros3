add_library(libmicros3 STATIC
    hello.cpp
    digest.cpp
)
set_target_properties(libmicros3 PROPERTIES OUTPUT_NAME micros3)
target_include_directories(libmicros3 PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(libmicros3
    PUBLIC
        sqlite3
        nlohmann_json::nlohmann_json
        pugixml::pugixml
    PRIVATE
        mbedcrypto
        zlibstatic
)
