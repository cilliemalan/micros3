#!/bin/sh
# Docker checks (docs/todo.md, "Emulator tests"): the image has no shell, runs
# as 65532:65532, and serves requests on port 3923 with /data writable.
# Usage: test/docker-check.sh [image]   (build first: docker build -t micros3 .)
set -eu
image=${1:-micros3}
fail=0

if docker run --rm --entrypoint /bin/sh "$image" -c true >/dev/null 2>&1; then
    echo "FAIL: /bin/sh runs in the image" >&2; fail=1
else
    echo "PASS: no shell in the image"
fi

user=$(docker image inspect -f '{{.Config.User}}' "$image")
if [ "$user" = "65532:65532" ]; then
    echo "PASS: image user is $user"
else
    echo "FAIL: image user is '$user', expected 65532:65532" >&2; fail=1
fi

name=micros3-check-$$
docker run -d --rm --name "$name" -p 127.0.0.1::3923 "$image" >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
port=$(docker port "$name" 3923/tcp | head -n1 | sed 's/.*://')

# A signed ListBuckets with the default credentials must get an HTTP answer
# that is not an authentication failure.
status=000
i=0
while [ $i -lt 50 ]; do
    status=$(curl -s -o /dev/null -w '%{http_code}' \
        --aws-sigv4 'aws:amz:us-east-1:s3' --user test:test \
        "http://127.0.0.1:$port/" || true)
    [ "$status" != 000 ] && break
    i=$((i + 1)); sleep 0.1
done
case "$status" in
    000) echo "FAIL: no answer on port 3923" >&2; fail=1 ;;
    401|403) echo "FAIL: signed request rejected with $status" >&2; fail=1 ;;
    *) echo "PASS: signed ListBuckets answered $status" ;;
esac

# The startup scan creates blobs/ and staging/ in /data, so the container
# would have exited if /data were not writable by 65532.
if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" = true ]; then
    echo "PASS: container is running with /data writable"
else
    echo "FAIL: container is not running" >&2; fail=1
fi

exit $fail
