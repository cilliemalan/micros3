#!/bin/sh
# Web UI port checks (docs/todo.md, U22 (c)), in the style of docker-check.sh:
# starts the binary and checks the UI port from outside with curl. It serves
# the page and its assets with the right types and headers, answers
# /api/health, gives 404 for S3-style paths, sends no body for HEAD, and
# refuses a foreign Host or Origin.
# Usage: test/ui-check.sh [path/to/micros3]
set -eu
bin=${1:-ooo/micros3}
[ -x "$bin" ] || { echo "FAIL: $bin is not an executable" >&2; exit 1; }
. "$(dirname "$0")/lib-server.sh"

start
ui=$((port + 1))
base="http://127.0.0.1:$ui"
hdr="$data/headers"
body="$data/body"
failed=0

pass() { echo "PASS: $*"; }
bad() { echo "FAIL: $*" >&2; failed=1; }

# get <path> [curl options...]: fetches into $body and $hdr, prints the status.
get() {
    path=$1
    shift
    curl -s -o "$body" -D "$hdr" -w '%{http_code}' "$@" "$base$path" || echo 000
}

# header <name>: the value of a response header in $hdr, without the CR.
header() {
    grep -i "^$1:" "$hdr" | head -n1 | sed 's/^[^:]*: *//' | tr -d '\r'
}

expect_status() { # expect_status <want> <got> <what>
    if [ "$2" = "$1" ]; then pass "$3 answers $1"; else bad "$3 answered $2, expected $1"; fi
}

# The page itself.
status=$(get /)
expect_status 200 "$status" "GET /"
case "$(header content-type)" in
    text/html*) pass "/ is text/html" ;;
    *) bad "/ has Content-Type '$(header content-type)'" ;;
esac
[ "$(header cache-control)" = no-cache ] && pass "/ has Cache-Control: no-cache" \
    || bad "/ has Cache-Control '$(header cache-control)'"
case "$(header content-security-policy)" in
    *"default-src 'self'"*) pass "/ has the CSP" ;;
    *) bad "/ has CSP '$(header content-security-policy)'" ;;
esac
[ "$(header x-content-type-options)" = nosniff ] && pass "/ has nosniff" || bad "/ lacks nosniff"
[ "$(header referrer-policy)" = no-referrer ] && pass "/ has Referrer-Policy: no-referrer" \
    || bad "/ lacks Referrer-Policy: no-referrer"
grep -q '<div id="root">' "$body" && pass "/ is the app's index.html" || bad "/ is not the app's index.html"

# Every asset index.html names, with its content type.
assets=$(grep -o '/assets/[^"]*' "$body" | sort -u)
[ -n "$assets" ] || bad "index.html names no assets"
for asset in $assets; do
    status=$(get "$asset")
    type=$(header content-type)
    case "$asset" in
        *.js) want=text/javascript ;;
        *.css) want=text/css ;;
        *) want= ;;
    esac
    if [ "$status" != 200 ]; then
        bad "$asset answered $status"
    elif [ -n "$want" ] && case "$type" in "$want"*) false ;; *) true ;; esac; then
        bad "$asset has Content-Type '$type', expected $want"
    else
        pass "$asset answers 200 as $type"
    fi
done

status=$(get /assets/missing.js)
expect_status 404 "$status" "a missing asset"

# The JSON API.
status=$(get /api/health)
expect_status 200 "$status" "GET /api/health"
case "$(header content-type)" in
    application/json*) pass "/api/health is JSON" ;;
    *) bad "/api/health has Content-Type '$(header content-type)'" ;;
esac

# S3-style requests on the UI port get a plain 404, not an S3 answer.
s3 /uicheck -X PUT -o /dev/null || bad "CreateBucket on the S3 port"
s3 /uicheck/key.txt -X PUT --data-binary hello -o /dev/null || bad "PutObject on the S3 port"
expect_status 404 "$(get /uicheck)" "GET /uicheck on the UI port"
expect_status 404 "$(get /uicheck/key.txt)" "GET /uicheck/key.txt on the UI port"
expect_status 404 "$(get '/uicheck?list-type=2')" "ListObjectsV2 on the UI port"
expect_status 404 "$(get /uicheck/new.txt -X PUT --data-binary x)" "PUT /uicheck/new.txt on the UI port"
expect_status 404 "$(get /uicheck/key.txt --aws-sigv4 aws:amz:us-east-1:s3 --user test:test)" \
    "a signed GetObject on the UI port"
grep -q '<?xml' "$body" && bad "the UI port answered with S3 XML" || pass "no S3 XML on the UI port"
s3 /uicheck/new.txt -I -o /dev/null 2>/dev/null && bad "a PUT on the UI port stored an object" \
    || pass "a PUT on the UI port stored nothing"

# HEAD has the GET headers and no body. The second request reuses the
# connection, so a body after the HEAD would garble its answer.
size=$(curl -s -o /dev/null -w '%{size_download}' "$base/")
status=$(get / -I)
expect_status 200 "$status" "HEAD /"
[ "$(header content-length)" = "$size" ] && pass "HEAD / has GET's Content-Length ($size)" \
    || bad "HEAD / has Content-Length '$(header content-length)', GET sent $size bytes"
out=$(curl -s -I -o /dev/null -w '%{http_code} ' "$base/" \
    --next -s -o /dev/null -w '%{http_code} %{num_connects}' "$base/api/health" || true)
[ "$out" = "200 200 0" ] && pass "HEAD sends no body on a kept-alive connection" \
    || bad "HEAD then GET on one connection gave '$out', expected '200 200 0'"

# Guards: a foreign Host is refused for every method; a foreign Origin is
# refused for changes; the page's own Origin may change things.
status=$(get /api/health -H "Host: rebind.example:$ui")
expect_status 403 "$status" "a foreign Host"
grep -q AccessForbidden "$body" && pass "a foreign Host gets AccessForbidden" || bad "a foreign Host body: $(cat "$body")"
expect_status 403 "$(get / -H "Host: rebind.example")" "a foreign Host without a port"
expect_status 403 "$(get / -H "Host: localhost:1")" "the wrong port in Host"
expect_status 200 "$(get / -H "Host: localhost:$ui")" "Host localhost with the UI port"

status=$(get /api/buckets -X POST -H 'Content-Type: application/json' \
    -H 'Origin: http://evil.example' --data '{"name":"uicheck-evil"}')
expect_status 403 "$status" "POST with a foreign Origin"
grep -q AccessForbidden "$body" && pass "a foreign Origin gets AccessForbidden" || bad "a foreign Origin body: $(cat "$body")"
s3 /uicheck-evil -I -o /dev/null 2>/dev/null && bad "a refused POST created a bucket" \
    || pass "a refused POST created nothing"
expect_status 403 "$(get /api/buckets/uicheck -X DELETE -H "Origin: http://localhost:$ui")" \
    "DELETE with an Origin that does not match Host"
expect_status 200 "$(get /api/buckets -H 'Origin: http://evil.example')" "GET with a foreign Origin"

status=$(get /api/buckets -X POST -H 'Content-Type: application/json' \
    -H "Origin: $base" --data '{"name":"uicheck-own"}')
case "$status" in
    200|201) pass "POST with the page's own Origin answers $status" ;;
    *) bad "POST with the page's own Origin answered $status: $(cat "$body")" ;;
esac
s3 /uicheck-own -I -o /dev/null 2>/dev/null && pass "the allowed POST created the bucket" \
    || bad "the allowed POST did not create the bucket"

stop TERM
[ $failed = 0 ] && echo "PASS: all UI port checks" || echo "FAIL: some UI port checks failed" >&2
exit $failed
