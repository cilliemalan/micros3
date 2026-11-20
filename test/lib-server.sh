# Shared helpers for the server scripts (persistence.sh, crash.sh). Source it
# after setting `bin`. Needs curl 7.75+ (for --aws-sigv4).

data=$(mktemp -d)
pid=
port=

cleanup() {
    [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null
    rm -rf "$data" "$data.log"
}
trap cleanup EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

# Starts the server on a free port in $data and waits until it answers.
start() {
    port=$(( 20000 + $(od -An -N2 -tu2 /dev/urandom) % 20000 ))
    MICROS3_ACCESS_KEY_ID=test MICROS3_SECRET_ACCESS_KEY=test \
        "$bin" --data-dir "$data" --port "$port" >>"$data.log" 2>&1 &
    pid=$!
    i=0
    until s3 / -o /dev/null 2>/dev/null; do
        i=$((i + 1))
        [ $i -lt 50 ] || fail "server did not start: $(cat "$data.log")"
        kill -0 "$pid" 2>/dev/null || fail "server exited: $(cat "$data.log")"
        sleep 0.1
    done
}

# Stops the server with the given signal (default KILL).
stop() {
    kill "-${1:-KILL}" "$pid"
    wait "$pid" 2>/dev/null || true
    pid=
}

# A signed curl request: s3 <path> [curl options...].
s3() {
    path=$1
    shift
    curl -sf --aws-sigv4 aws:amz:us-east-1:s3 --user test:test \
        -H 'x-amz-content-sha256: UNSIGNED-PAYLOAD' "$@" "http://127.0.0.1:$port$path"
}
