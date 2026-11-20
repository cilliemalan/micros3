add_executable(micros3 main.cpp)
target_link_libraries(micros3 PRIVATE libmicros3)

# Static link (design.md, D4): with musl on the Alpine builder the binary runs
# in a `FROM scratch` image. Windows and macOS have no fully static linking.
if(WIN32 OR APPLE)
    set(MICROS3_STATIC_DEFAULT OFF)
else()
    set(MICROS3_STATIC_DEFAULT ON)
endif()
option(MICROS3_STATIC "Link the micros3 executable statically" ${MICROS3_STATIC_DEFAULT})
if(MICROS3_STATIC AND NOT (WIN32 OR APPLE))
    target_link_options(micros3 PRIVATE -static)
endif()
