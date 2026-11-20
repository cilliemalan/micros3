add_library(libmicros3 STATIC
    bucket_handlers.cpp
    buckets.cpp
    clock.cpp
    conditions.cpp
    config.cpp
    cors.cpp
    cors_handlers.cpp
    db.cpp
    delete_objects_handler.cpp
    digest.cpp
    handlers.cpp
    http.cpp
    list_handlers.cpp
    listing.cpp
    object_handlers.cpp
    objects.cpp
    router.cpp
    server.cpp
    service.cpp
    sigv4.cpp
    store.cpp
    url.cpp
    xml.cpp
)
set_target_properties(libmicros3 PROPERTIES OUTPUT_NAME micros3)
target_include_directories(libmicros3 PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(libmicros3
    PUBLIC
        sqlite3
        nlohmann_json::nlohmann_json
        pugixml::pugixml
    PRIVATE
        uwebsockets
        mbedcrypto
        zlibstatic
)
