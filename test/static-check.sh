#!/bin/sh
# Static-link check (docs/todo.md, "Emulator tests"): the release binary must
# need no shared libraries. Usage: test/static-check.sh [path/to/micros3]
set -eu
bin=${1:-ooo/micros3}
[ -x "$bin" ] || { echo "FAIL: $bin is not an executable" >&2; exit 1; }

desc=$(file -b "$bin")
echo "file: $desc"
case "$desc" in
    *"statically linked"*|*"static-pie linked"*) ;;
    *) echo "FAIL: file does not report a static binary" >&2; exit 1 ;;
esac

# ldd exits non-zero for a static binary; its message differs between glibc
# ("not a dynamic executable") and musl. A listed .so means it is dynamic.
if ldd "$bin" 2>&1 | grep -q '\.so'; then
    echo "FAIL: ldd lists shared libraries:" >&2
    ldd "$bin" >&2
    exit 1
fi
echo "PASS: $bin is statically linked"
