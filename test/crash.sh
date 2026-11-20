#!/bin/sh
# Crash-safety check (docs/todo.md, "Emulator tests"): start a slow, large
# PutObject, SIGKILL the server mid-upload and restart it. The object must be
# absent or complete, and staging/ must be empty. An existing object at the
# same key must survive intact. Usage: test/crash.sh [path/to/micros3]
set -eu
bin=${1:-ooo/micros3}
[ -x "$bin" ] || { echo "FAIL: $bin is not an executable" >&2; exit 1; }
. "$(dirname "$0")/lib-server.sh"

old=$(mktemp -p "$data")
new=$(mktemp -p "$data")
head -c 65536 /dev/urandom >"$old"
head -c 33554432 /dev/urandom >"$new"

start
s3 /crash -X PUT -o /dev/null || fail "CreateBucket"
s3 /crash/replaced -T "$old" -o /dev/null || fail "PutObject setup"

# About 8 s at this rate; kill the server after 2 s.
s3 /crash/new -T "$new" --limit-rate 4M -o /dev/null &
upload1=$!
s3 /crash/replaced -T "$new" --limit-rate 4M -o /dev/null &
upload2=$!
sleep 2
[ -n "$(ls "$data/staging")" ] || fail "no staging file during the upload"
stop KILL
wait $upload1 2>/dev/null || true
wait $upload2 2>/dev/null || true

start
[ -z "$(ls "$data/staging")" ] || fail "staging/ is not empty after restart: $(ls "$data/staging")"
if s3 /crash/new -o "$data/got"; then
    cmp -s "$new" "$data/got" || fail "a partial object is visible"
fi
s3 /crash/replaced -o "$data/got" || fail "the replaced object was lost"
cmp -s "$old" "$data/got" || cmp -s "$new" "$data/got" || fail "the replaced object is corrupt"
[ "$(ls "$data/blobs" | wc -l)" -eq 1 ] || fail "unreferenced blobs remain: $(ls "$data/blobs")"
stop TERM
echo "PASS: a killed upload leaves no partial object and no staging file"
