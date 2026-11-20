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

add_subdirectory(lib)
add_subdirectory(src)
add_subdirectory(test)
