cmake_minimum_required(VERSION 3.20)

project(micros3_workspace LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/$<0:>")

include(FetchContent)

FetchContent_Declare(
    uwebsockets
    GIT_REPOSITORY https://github.com/uNetworking/uWebSockets.git
    GIT_TAG v20.81.0
    GIT_SHALLOW TRUE
    GIT_SUBMODULES uSockets
    GIT_SUBMODULES_RECURSE FALSE
)
FetchContent_MakeAvailable(uwebsockets)

file(GLOB USOCKETS_SOURCES CONFIGURE_DEPENDS
    "${uwebsockets_SOURCE_DIR}/uSockets/src/*.c"
    "${uwebsockets_SOURCE_DIR}/uSockets/src/eventing/*.c"
)
add_library(usockets STATIC ${USOCKETS_SOURCES})
target_include_directories(usockets PUBLIC "${uwebsockets_SOURCE_DIR}/uSockets/src")
target_compile_definitions(usockets PUBLIC LIBUS_NO_SSL)

if(WIN32 OR ANDROID)
    set(BUILD_TESTING OFF CACHE BOOL "Disable dependency tests" FORCE)
    set(LIBUV_BUILD_SHARED OFF CACHE BOOL "Build libuv statically" FORCE)
    FetchContent_Declare(
        libuv
        GIT_REPOSITORY https://github.com/libuv/libuv.git
        GIT_TAG v1.51.0
        GIT_SHALLOW TRUE
    )
    FetchContent_MakeAvailable(libuv)
    target_compile_definitions(usockets PUBLIC LIBUS_USE_LIBUV)
    target_link_libraries(usockets PUBLIC uv_a)
    if(WIN32)
        target_link_libraries(usockets PUBLIC ws2_32)
    endif()
endif()

add_library(uwebsockets INTERFACE)
target_include_directories(uwebsockets INTERFACE "${uwebsockets_SOURCE_DIR}/src")
target_compile_definitions(uwebsockets INTERFACE UWS_NO_ZLIB)
target_link_libraries(uwebsockets INTERFACE usockets)

# Third-party libraries (design.md, "Third-party libraries"). Each is pinned
# and built as a static library with its tests and programs turned off.

# SQLite: the amalgamation has no build system, so build sqlite3.c here.
FetchContent_Declare(
    sqlite3
    URL https://www.sqlite.org/2026/sqlite-amalgamation-3540100.zip
    URL_HASH SHA3_256=92281c86e2957f9b9305890f9ac04204caa7b677cc868dc326d942689df28e30
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(sqlite3)
add_library(sqlite3 STATIC "${sqlite3_SOURCE_DIR}/sqlite3.c")
target_include_directories(sqlite3 PUBLIC "${sqlite3_SOURCE_DIR}")
target_compile_definitions(sqlite3 PRIVATE
    SQLITE_OMIT_LOAD_EXTENSION
    SQLITE_DQS=0
    SQLITE_DEFAULT_FOREIGN_KEYS=1
)
find_package(Threads REQUIRED)
target_link_libraries(sqlite3 PUBLIC Threads::Threads)
if(UNIX)
    target_link_libraries(sqlite3 PUBLIC m)
endif()

set(JSON_BuildTests OFF CACHE BOOL "Disable nlohmann/json tests" FORCE)
set(JSON_Install OFF CACHE BOOL "Disable nlohmann/json install" FORCE)
FetchContent_Declare(
    nlohmann_json
    GIT_REPOSITORY https://github.com/nlohmann/json.git
    GIT_TAG v3.12.0
    GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(nlohmann_json)

set(PUGIXML_BUILD_TESTS OFF CACHE BOOL "Disable pugixml tests" FORCE)
set(PUGIXML_BUILD_SHARED_AND_STATIC_LIBS OFF CACHE BOOL "Static pugixml only" FORCE)
set(PUGIXML_INSTALL OFF CACHE BOOL "Disable pugixml install" FORCE)
FetchContent_Declare(
    pugixml
    GIT_REPOSITORY https://github.com/zeux/pugixml.git
    GIT_TAG v1.16
    GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(pugixml)

# zlib: only CRC32 is used. Its own CMakeLists always builds a shared library
# and example programs, so point SOURCE_SUBDIR at a directory that does not
# exist (nothing is added) and build the static library from its sources here.
FetchContent_Declare(
    zlib
    GIT_REPOSITORY https://github.com/madler/zlib.git
    GIT_TAG v1.3.1
    GIT_SHALLOW TRUE
    SOURCE_SUBDIR no-cmake
)
FetchContent_MakeAvailable(zlib)
add_library(zlibstatic STATIC
    "${zlib_SOURCE_DIR}/adler32.c"
    "${zlib_SOURCE_DIR}/compress.c"
    "${zlib_SOURCE_DIR}/crc32.c"
    "${zlib_SOURCE_DIR}/deflate.c"
    "${zlib_SOURCE_DIR}/gzclose.c"
    "${zlib_SOURCE_DIR}/gzlib.c"
    "${zlib_SOURCE_DIR}/gzread.c"
    "${zlib_SOURCE_DIR}/gzwrite.c"
    "${zlib_SOURCE_DIR}/infback.c"
    "${zlib_SOURCE_DIR}/inffast.c"
    "${zlib_SOURCE_DIR}/inflate.c"
    "${zlib_SOURCE_DIR}/inftrees.c"
    "${zlib_SOURCE_DIR}/trees.c"
    "${zlib_SOURCE_DIR}/uncompr.c"
    "${zlib_SOURCE_DIR}/zutil.c"
)
target_include_directories(zlibstatic PUBLIC "${zlib_SOURCE_DIR}")
if(NOT WIN32)
    target_compile_definitions(zlibstatic PRIVATE HAVE_UNISTD_H)
endif()

set(ENABLE_TESTING OFF CACHE BOOL "Disable Mbed TLS tests" FORCE)
set(ENABLE_PROGRAMS OFF CACHE BOOL "Disable Mbed TLS programs" FORCE)
set(GEN_FILES OFF CACHE BOOL "Use Mbed TLS's committed generated files" FORCE)
set(USE_STATIC_MBEDTLS_LIBRARY ON CACHE BOOL "Static Mbed TLS" FORCE)
set(USE_SHARED_MBEDTLS_LIBRARY OFF CACHE BOOL "No shared Mbed TLS" FORCE)
set(DISABLE_PACKAGE_CONFIG_AND_INSTALL ON CACHE BOOL "Disable Mbed TLS install" FORCE)
set(MBEDTLS_FATAL_WARNINGS OFF CACHE BOOL "Do not fail on Mbed TLS warnings" FORCE)
FetchContent_Declare(
    mbedtls
    GIT_REPOSITORY https://github.com/Mbed-TLS/mbedtls.git
    GIT_TAG mbedtls-3.6.8
    GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(mbedtls)

set(BUILD_GMOCK OFF CACHE BOOL "Disable Google Mock" FORCE)
set(INSTALL_GTEST OFF CACHE BOOL "Disable GoogleTest installation" FORCE)
set(gtest_force_shared_crt ON CACHE BOOL "Use the shared MSVC runtime" FORCE)
FetchContent_Declare(
    googletest
    GIT_REPOSITORY https://github.com/google/googletest.git
    GIT_TAG v1.17.0
    GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(googletest)

include(cmake/ui.cmake)

add_subdirectory(lib)
add_subdirectory(src)
add_subdirectory(test)
