#!/bin/sh
# Persistence check (docs/todo.md, "Emulator tests"): create a bucket and an
# object, stop the server, restart it on the same data directory and read the
# object back. Usage: test/persistence.sh [path/to/micros3]
set -eu
bin=${1:-ooo/micros3}
[ -x "$bin" ] || { echo "FAIL: $bin is not an executable" >&2; exit 1; }
. "$(dirname "$0")/lib-server.sh"

body=$(mktemp -p "$data")
head -c 1048576 /dev/urandom >"$body"

start
s3 /persist -X PUT -o /dev/null || fail "CreateBucket"
s3 /persist/dir/object.bin -T "$body" -H 'x-amz-meta-purpose: persistence' -o /dev/null || fail "PutObject"
stop TERM

start
s3 /persist/dir/object.bin -o "$body.out" || fail "GetObject after restart"
cmp -s "$body" "$body.out" || fail "content changed across the restart"
s3 /persist/dir/object.bin -I | grep -qi '^x-amz-meta-purpose: persistence' || fail "metadata lost across the restart"
s3 /persist -I -o /dev/null || fail "bucket lost across the restart"
stop TERM
echo "PASS: objects persist across a restart"
