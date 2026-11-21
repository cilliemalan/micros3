# The web UI build (docs/UI.md, "Build and embedding"): install the frontend's
# packages with pnpm, build it with Vite into the build directory, and embed
# the output in ui_assets.cpp, which libmicros3 compiles.
#
#   ui_install    runs `pnpm install --frozen-lockfile` on every build
#   build.stamp   runs `vite build` when a file under ui/ (not node_modules)
#                 changes
#   ui_assets.cpp written by cmake/embed_ui.cmake, replaced only when it
#                 differs
#   ui_assets     the target libmicros3 depends on

find_program(MICROS3_NODE node)
find_program(MICROS3_PNPM pnpm)
if(NOT MICROS3_NODE OR NOT MICROS3_PNPM)
    message(FATAL_ERROR
        "Building micros3 needs Node.js and pnpm, to build the web UI in ui/. "
        "Install Node.js (^20.19.0 or >=22.12.0) and run `corepack enable`, "
        "then configure again.")
endif()

set(MICROS3_UI_SOURCE_DIR "${CMAKE_SOURCE_DIR}/ui")
set(MICROS3_UI_BINARY_DIR "${CMAKE_BINARY_DIR}/ui")
set(MICROS3_UI_DIST "${MICROS3_UI_BINARY_DIR}/dist")
set(MICROS3_UI_STAMP "${MICROS3_UI_BINARY_DIR}/build.stamp")
set(MICROS3_UI_ASSETS_CPP "${MICROS3_UI_BINARY_DIR}/ui_assets.cpp")

# Every file under ui/ except node_modules. The top level is globbed with its
# directories, so a new directory is noticed too, and each directory other
# than node_modules is globbed recursively (node_modules is never walked).
file(GLOB ui_top CONFIGURE_DEPENDS LIST_DIRECTORIES true "${MICROS3_UI_SOURCE_DIR}/*")
set(ui_inputs "")
foreach(entry IN LISTS ui_top)
    get_filename_component(name "${entry}" NAME)
    if(name STREQUAL "node_modules")
        continue()
    elseif(IS_DIRECTORY "${entry}")
        file(GLOB_RECURSE nested CONFIGURE_DEPENDS LIST_DIRECTORIES false "${entry}/*")
        list(APPEND ui_inputs ${nested})
    else()
        list(APPEND ui_inputs "${entry}")
    endif()
endforeach()

add_custom_target(ui_install
    COMMAND "${MICROS3_PNPM}" install --frozen-lockfile
    WORKING_DIRECTORY "${MICROS3_UI_SOURCE_DIR}"
    COMMENT "Installing the web UI's packages (pnpm install)"
    VERBATIM
    USES_TERMINAL
)

add_custom_command(
    OUTPUT "${MICROS3_UI_STAMP}"
    COMMAND "${MICROS3_PNPM}" exec vite build --outDir "${MICROS3_UI_DIST}" --emptyOutDir
    COMMAND "${CMAKE_COMMAND}" -E touch "${MICROS3_UI_STAMP}"
    WORKING_DIRECTORY "${MICROS3_UI_SOURCE_DIR}"
    DEPENDS ${ui_inputs} ui_install
    COMMENT "Building the web UI (vite build)"
    VERBATIM
    USES_TERMINAL
)

add_custom_command(
    OUTPUT "${MICROS3_UI_ASSETS_CPP}"
    COMMAND "${CMAKE_COMMAND}" "-DDIST=${MICROS3_UI_DIST}" "-DOUTPUT=${MICROS3_UI_ASSETS_CPP}"
            -P "${CMAKE_SOURCE_DIR}/cmake/embed_ui.cmake"
    DEPENDS "${MICROS3_UI_STAMP}" "${CMAKE_SOURCE_DIR}/cmake/embed_ui.cmake"
    COMMENT "Embedding the web UI (ui_assets.cpp)"
    VERBATIM
)

add_custom_target(ui_assets DEPENDS ui_install "${MICROS3_UI_ASSETS_CPP}")
