# MicroS3 TODO

Source of truth: [design.md](design.md). Phases follow its "Implementation order" and keep its numbers (1 to 10). Tick an item in the same commit that makes it true. A phase is done when the verify checks named for it pass in a full run. Until verify can run a single suite (item V1), read those checks' lines in the full run output.

## Starting point

- `src/main.cpp` serves `Hello, world!` on port 3923 with uWebSockets. It has no flags, routing, storage, XML or JSON.
- `lib/` holds a placeholder library (`hello.cpp`), and `test/hello_test.cpp` tests it.
- CMake fetches uWebSockets v20.81.0 and GoogleTest v1.17.0 with `FetchContent`. The other libraries in design.md's "Third-party libraries" table are not fetched yet.
- There is no Dockerfile and no `.dockerignore`.
- The verifier (`verify/`) is complete. Its one recorded run against Floci (`verify/floci.md`) shows 28 passes and 18 failures.

## Decisions (settled)

All are recorded in design.md. Nothing here is open.

- [x] **D1. DeleteBucket with uploads in progress.** `BucketNotEmpty` (409) when objects exist. A bucket whose only contents are uploads is deleted with its upload and part rows. Later requests on those uploads return `NoSuchBucket` or `NoSuchUpload` (404).
- [x] **D2. Signature checks.** SigV4 is checked against one credential pair from `MICROS3_ACCESS_KEY_ID` and `MICROS3_SECRET_ACCESS_KEY` (default `test`/`test`). Unsigned requests except OPTIONS preflight are rejected. The `x-amz-content-sha256` header is checked against the body. Errors are `AccessDenied`, `InvalidAccessKeyId` and `SignatureDoesNotMatch` (403).
- [x] **D3. Third-party code.** Downloaded by CMake `FetchContent`, not vendored. Libraries: SQLite, nlohmann/json, pugixml, Mbed TLS (for MD5, SHA-256, HMAC and base64) and zlib (for CRC32). Pins are in design.md.
- [x] **D4. Static toolchain.** Alpine (musl) builder stage with `-static`, so the binary runs in `FROM scratch`.
- [x] **D5. Bad-signature check.** Add a `verify` check for a wrong secret, expecting 403 (V3).
- [x] **D6. Range.** Single range only (`bytes=a-b`, `bytes=a-`, `bytes=-n`) on GetObject and HeadObject. Multiple ranges are ignored. This also adds Range to the scope in design.md.
- [x] **D7. Conditional writes.** `If-None-Match` on PutObject and CompleteMultipartUpload returns 501 `NotImplemented`.
- [x] **D8. Docker user.** Numeric `USER 65532:65532`, with `/data` owned by that user.

## Phase 1: Skeleton

- [x] Add the third-party libraries with `FetchContent`, as design.md's "Third-party libraries" table gives them. Pin each to its tag or URL hash.
  - [x] SQLite: download `https://www.sqlite.org/2026/sqlite-amalgamation-3540100.zip` with `URL_HASH SHA3_256=92281c86e2957f9b9305890f9ac04204caa7b677cc868dc326d942689df28e30`. Build `sqlite3.c` as a static library. If the minimum CMake version cannot check SHA3, raise `cmake_minimum_required` (currently 3.20).
  - [x] nlohmann/json v3.12.0, pugixml v1.16, zlib v1.3.1, and Mbed TLS mbedtls-3.6.8 (its tests and programs off).
  - [x] Each non-uWebSockets library built static, with its tests and programs turned off.
  - [x] Check that Mbed TLS builds without extra tools on the Alpine builder. (Checked on `alpine:3.22` with only `build-base cmake git linux-headers`: no Python or Perl needed, since `GEN_FILES` is off.)
- [x] Keep `libmicros3` for the server code, and drop `lib/hello.*` once the server stops using it.
- [x] Credentials from `MICROS3_ACCESS_KEY_ID` and `MICROS3_SECRET_ACCESS_KEY` only (defaults `test`/`test`), with no flags.
- [x] Options: `--data-dir` and `--port`, with environment variables `MICROS3_DATA_DIR` (default `./data`) and `MICROS3_PORT` (default 3923). Flags beat environment variables, which beat defaults. Reject an invalid port with a usage error and a non-zero exit.
- [x] HTTP server on the configured port, streaming request bodies. (`lib/server.cpp` adapts uWebSockets to `http::Service`/`http::Exchange`. Every operation still answers 501 until its handler lands. Note: uWebSockets rejects a `Content-Length` above 999,999,999 bytes with 400, and its request head limit is 4 KiB unless `UWS_HTTP_MAX_HEADERS_SIZE` is set in the environment.)
- [x] Path-style router. It splits the path into bucket, key and query. It selects the operation from method and subresource (`?uploads`, `?uploadId=`, `?cors`, `?encryption`, `?location`, `?list-type=2`).
- [x] Unsupported subresources and out-of-scope operations (`?tagging`, `?acl`, `?policy`, `?versioning`, and so on) return `NotImplemented` (501). They never fall through to an object operation.
- [x] XML writer for success bodies and for errors (`Code`, `Message`, `Resource`, `RequestId`). Set the `x-amz-request-id` header to the same value.
- [x] SQLite in WAL mode, with `synchronous=FULL` for commits and `PRAGMA foreign_keys=ON` on every connection. Create the four tables in the design (`buckets`, `objects`, `uploads`, `parts`) if missing. `uploads.bucket` is `ON DELETE CASCADE` (D1). (`lib/db.cpp` wraps the C API; `lib/store.cpp` configures the connection and creates the schema, plus an `uploads(bucket, key)` index for ListMultipartUploads. Tests in `test/store_test.cpp`.)
- [x] Startup: create `blobs/` and `staging/`. Delete every file in `staging/`, and every file in `blobs/` that no row refers to. (`Store`'s constructor, called from `main` before the server starts. It logs what it removed.)
- [x] SigV4 header authentication, as design.md's "Authentication" section describes: canonical request, string to sign, derived signing key, constant-time comparison, and the access key ID check. Use AWS's published test vectors. (`lib/sigv4.cpp`, called from `S3Service::begin` after routing. The canonical URI and query are rebuilt from the decoded target. Any region in the credential scope is accepted, and clock skew is not checked. `STREAMING-*` payloads answer 501. Tests in `test/sigv4_test.cpp` and `test/server_test.cpp`.)
- [x] Payload hash check: `x-amz-content-sha256` against the SHA-256 of the streamed body. A mismatch returns `XAmzContentSHA256Mismatch` (400) and deletes the staging file. (`PayloadHashExchange` wraps the handler's exchange and calls its `on_abort` on a mismatch, so each handler must discard its staging file in `on_abort`.)
- [x] Preflight OPTIONS is accepted without a signature. Its full handling is in Phase 10.
- [x] Dockerfile (D4, D8): an Alpine builder stage, then `FROM scratch` with the binary, `ENV MICROS3_DATA_DIR=/data MICROS3_PORT=3923`, `VOLUME /data`, `EXPOSE 3923`, `USER 65532:65532`, and an entrypoint of the binary. The builder creates `/data` owned by `65532:65532`. Add `.dockerignore` for `ooo/`, `verify/node_modules` and `.git`. (The builder is `alpine:3.22` and builds only the `micros3` target, then strips it. `test/docker-check.sh` checks the image.)
- [x] Static link under CMake (`-static`, musl on the builder), excluded on Windows. (`MICROS3_STATIC` option in `src/CMakeLists.txt`, on by default except on Windows and macOS. It applies to the `micros3` executable only. On a glibc host the link warns about `getaddrinfo`, which is harmless here.)

**Done when:** the first `verify` call, ListBuckets, returns an empty list. `ldd` or `file` reports the binary as static, and `docker run --rm --entrypoint /bin/sh micros3` fails.

## Phase 2: Buckets

- [x] Bucket name validation against the AWS rules (3 to 63 characters, lowercase letters, digits and hyphens, alphanumeric at each end, no adjacent dots, not an IP-address form, no `xn--` prefix or `-s3alias` suffix). Return `InvalidBucketName` (400). Underscores are rejected (see Floci). (`buckets::valid_name` in `lib/buckets.cpp`, which also rejects the other reserved prefixes and suffixes AWS lists. Checked on CreateBucket only. Other operations on such a name answer `NoSuchBucket`.)
- [x] ListBuckets: `Owner`, `Buckets`, `CreationDate` (ISO 8601). (Also `BucketRegion`, and `max-buckets`, `continuation-token` (base64 of the last name), `prefix` and `bucket-region`.)
- [x] CreateBucket: 200 with `Location`. A repeat returns `BucketAlreadyOwnedByYou` (409) and keeps the bucket. Check `bucket.js` for how a `LocationConstraint` is handled. (`bucket.js` expects the legacy 200 for a repeat in us-east-1, as S3 gives, and 409 elsewhere. Each bucket stores its region, from the body's `LocationConstraint` (default us-east-1), in a new `buckets.region` column that is added to older databases at startup. A malformed body is `MalformedXML` and a bad region is `InvalidLocationConstraint`.)
- [x] HeadBucket: 200, or 404 with no body. (200 carries `x-amz-bucket-region`.)
- [x] GetBucketLocation: match what `bucket.js` asserts for us-east-1. (An empty `LocationConstraint` for us-east-1, else the region.)
- [x] DeleteBucket (D1): 204. Missing bucket returns `NoSuchBucket`. A bucket with objects returns `BucketNotEmpty` (409). A bucket whose only contents are uploads is deleted with its upload and part rows, and the part blob files are removed after the commit.

**Checks:** `bucket.js`, `resources.js`. (On 2026-11-20, six of the eight bucket checks passed in us-east-1 and eu-west-1. The two repeat-creation and non-empty checks need PutObject and DeleteObject from Phase 3.)

## Phase 3: Objects

- [x] Streamed PutObject: write the body to `staging/` while computing MD5, and the CRC32 and SHA-256 checksums when they are requested. Do not buffer the whole body. (`PutObjectExchange` in `lib/object_handlers.cpp` writes each chunk to an `objects::StagedBlob` (`lib/objects.cpp`). Other checksum algorithms (CRC32C, CRC64NVME, SHA-1) and SSE other than AES256 answer 501. Keys over 1,024 bytes are `KeyTooLongError` and user metadata over 2 KiB is `MetadataTooLarge`.)
- [x] `Content-MD5`: a malformed value returns `InvalidDigest` (400). A mismatch returns `BadDigest` (400) and deletes the staging file.
- [x] `x-amz-checksum-crc32` and `x-amz-checksum-sha256`: mismatch returns `BadDigest`. Match `integrity.js` for malformed values. (`integrity.js` sends none; a value that is not base64 of the right length is `InvalidRequest` (400), as S3 answers. A valid checksum is echoed in the PutObject response.)
- [x] Commit: `fsync` the staging file, `rename` it into `blobs/`, then in one transaction upsert the `objects` row. Delete the replaced blob after the commit. (The `blobs/` directory is fsynced after the rename too.)
- [x] Store the metadata headers as JSON: `Content-Type`, `Cache-Control`, `Content-Disposition`, `Content-Encoding`, `Content-Language`, `Expires`, and `x-amz-meta-*`. Return them on GET and HEAD. (Content-Type defaults to `binary/octet-stream`. GetObject also honors the `response-*` override parameters.)
- [x] Every PutObject, GetObject and HeadObject response carries `x-amz-server-side-encryption: AES256` (answered yes in design.md).
- [x] ETag: quoted hex MD5 of the body. Empty and binary bodies work.
- [x] Keys are stored as raw UTF-8 BLOB bytes. The request path is URL-decoded before storage.
- [x] GetObject: streams the blob file. Missing key returns `NoSuchKey` (404). Missing bucket returns `NoSuchBucket`. (`http::Response::file` holds the open file, and `lib/server.cpp` streams it with `tryEnd` and `onWritable`, so backpressure is respected. An overwrite or delete during a download unlinks a file that stays readable.)
- [x] Range (D6): one range, `bytes=a-b`, `bytes=a-` or `bytes=-n`. A satisfiable range returns 206 with `Content-Range` and only those bytes. An unsatisfiable one returns 416 `InvalidRange`. A header with several ranges is ignored, and the whole object is returned with 200. Apply Range after the conditions (Phase 9). Do the same on HeadObject, with no body. (`conditions::parse_range` in `lib/conditions.cpp`. Any range on an empty object is 416. A 416 carries `Content-Range: bytes */<size>`.)
- [x] HeadObject: no body. `Content-Length` is the object size. Missing key returns 404 with no body.
- [x] DeleteObject: 204. Match `delete-object.js` for a missing key. (204 for a missing key too.)
- [x] Use the design's order for failures: a failed upload leaves no visible object, and the staging file is removed.

**Checks:** `put-get-object.js`, `object.js`, `delete-object.js`, `integrity.js`. (On 2026-11-20, PutObject, GetObject, HeadObject, DeleteObject and both integrity upload checks passed. "Object ETags are MD5 digests" needs CopyObject from Phase 6.)

## Phase 4: Encryption

- [x] GetBucketEncryption: one rule with `SSEAlgorithm` AES256, no KMS key ID, and no `BucketKeyEnabled: true`. Missing bucket returns `NoSuchBucket`. (`get_bucket_encryption` in `lib/bucket_handlers.cpp`, which sends `BucketKeyEnabled` false.)
- [x] `PutBucketEncryption` is out of scope and returns `NotImplemented`, through the router item in Phase 1.

**Checks:** `encryption.js`. (On 2026-11-20, both encryption checks passed.)

## Phase 5: Listing

- [x] ListObjects (v1): `prefix`, `delimiter`, `marker`, `max-keys`, `IsTruncated`, `NextMarker`, `CommonPrefixes`. Match `listing.js` for when `NextMarker` appears. (`NextMarker` only on a truncated page with a delimiter, as S3 does. `listing::list` in `lib/listing.cpp`, handlers in `lib/list_handlers.cpp`.)
- [x] ListObjectsV2 (`list-type=2`): `prefix`, `delimiter`, `start-after`, `continuation-token`, `max-keys`, `KeyCount`, `IsTruncated`, `NextContinuationToken`. The token is printable ASCII, the base64 of the last key. (Or of the last common prefix. `fetch-owner=true` adds `Owner`. A marker inside a common prefix resumes after that whole prefix.)
- [x] Order by the BLOB key in SQL (memcmp, which gives UTF-8 byte order). Use the primary-key index.
- [x] Missing bucket returns `NoSuchBucket`. An empty bucket returns an empty listing.
- [x] `EncodingType=url`: encode `Key`, `Prefix`, `Delimiter`, `Marker`, `StartAfter`, `NextMarker`, `NextContinuationToken` (when it is a key) and `CommonPrefixes`, and echo `EncodingType`. (Unreserved characters and `/` stay, a space becomes `+`, every other byte is `%XX`. Continuation tokens are base64 and never encoded. Any other `encoding-type` is `InvalidArgument`.)
- [x] XML escaping. Output must not contain any character XML 1.0 forbids. Match `listing-encoding.js` and `encoding.js` for control characters without `EncodingType=url`.

**Checks:** `listing.js`, `listing-encoding.js`, `encoding.js`. (On 2026-11-20, all four listing checks passed.)

## Phase 6: DeleteObjects and CopyObject

- [x] DeleteObjects: parse the `Delete` XML body, with `Object` entries and `Quiet`. Reject more than 1,000 keys. Match `delete-objects.js` for the status and code. Report each key under `Deleted` or `Error`. A missing key counts as deleted. (`lib/delete_objects_handler.cpp`. More than 1,000 keys, an empty list or an `Object` without `Key` is `MalformedXML` (400). `Content-MD5` and the CRC32 and SHA-256 checksum headers are checked against the body when present. All rows go in one transaction, then the blobs are removed. A `VersionId` other than `null` is reported under `Error` as `NoSuchVersion`.)
- [x] CopyObject: parse `x-amz-copy-source` (URL-decoded, with an optional leading slash). A missing source returns `NoSuchKey`, and a missing destination bucket returns `NoSuchBucket`. Copy the blob file to a new blob id, so each blob has one owner and deletes stay simple. (`copy_object` in `lib/object_handlers.cpp`, with `StagedBlob::copy_from`, which uses `copy_file_range` and falls back to read and write. The copy runs on the event loop, so a very large copy holds up other requests. A missing source bucket is `NoSuchBucket`, a `versionId` other than `null` is `InvalidArgument`, and `If-Match`/`If-None-Match` answer 501 as on PutObject.)
- [x] `x-amz-metadata-directive`: COPY (default) keeps the source metadata. REPLACE keeps only the metadata the request supplies. This fixes Floci's Cache-Control bug. (Any other directive is `InvalidArgument`. A self-copy without REPLACE is `InvalidRequest` (400), as in S3.)
- [x] Copies within and across buckets. The response is `CopyObjectResult` with `ETag` and `LastModified`. (The copy keeps the source ETag, and the response carries `x-amz-server-side-encryption: AES256`.)

**Checks:** `delete-objects.js`, `copy-object.js`. (On 2026-11-20, DeleteObjects, CopyObject, "Object ETags are MD5 digests" and "CopyObject date conditions" passed.)

## Phase 7: CORS configuration

- [x] PutBucketCors: parse `CORSConfiguration`. Reject unsupported methods, a missing origin or method, an empty configuration, and more than 100 rules, each as `MalformedXML` (400). Check `cors.js` for the expected code. Store the rules in order. (`cors.js` checks only the 400. `cors::parse` in `lib/cors.cpp` follows S3: an unsupported method (case-sensitive), or an origin or header with more than one `*`, is `InvalidRequest`; the other cases, plus unknown or repeated elements and a bad `MaxAgeSeconds`, are `MalformedXML`. `Content-MD5` and the CRC32 and SHA-256 checksums are checked when present, through `check_body_digests`, now shared with DeleteObjects. The validated configuration is rewritten by `cors::to_xml` and stored in `buckets.cors_xml`.)
- [x] GetBucketCors: the stored configuration. No configuration returns `NoSuchCORSConfiguration` (404).
- [x] DeleteBucketCors: 204, including on repeat. Missing bucket returns `NoSuchBucket`.
- [x] Each bucket has its own configuration.

**Checks:** `cors.js`. (On 2026-11-20, all eight `cors.js` checks passed. Tests in `test/cors_test.cpp` and `test/server_test.cpp`.)

## Phase 8: Multipart

- [x] CreateMultipartUpload: `InitiateMultipartUploadResult`, with a random hex `UploadId`. Store the request's metadata headers for use at completion. (`create_multipart_upload` in `lib/multipart_handlers.cpp`; rows in `lib/uploads.cpp`. The ID is 12 hex digits of the initiation time then 20 random ones, so one key's uploads list in initiation order. `x-amz-checksum-algorithm` answers 501.)
- [x] UploadPart: `partNumber` 1 to 10,000, else `InvalidArgument` (400). Stream to `staging/`, with Content-MD5 validation as for PutObject. A part number that already exists replaces it. Unknown upload returns `NoSuchUpload` (404). Precedence: when the bucket is also missing, return `NoSuchBucket` or `NoSuchUpload`, which the checks accept. (NoSuchBucket. PutObject and UploadPart share `StagedBodyExchange` in `lib/staged_body.cpp`, with the CRC32 and SHA-256 checksums too.)
- [x] Commit a part as for objects, then upsert the `parts` row and delete the replaced part blob. A part whose upload was deleted with its bucket (D1) fails at this commit with `NoSuchUpload`.
- [x] ListParts: `part-number-marker`, `max-parts`, `IsTruncated`, `NextPartNumberMarker`. Unknown upload returns `NoSuchUpload`.
- [x] ListMultipartUploads: honor `max-uploads` (Floci ignores it). Return `IsTruncated`, `NextKeyMarker`, `NextUploadIdMarker`, `key-marker`, `upload-id-marker`, `prefix`, and `CommonPrefixes` when a delimiter is given. Order by key in byte order. (Then by upload ID. A truncated page that ends in a common prefix gives the prefix as `NextKeyMarker` and no `NextUploadIdMarker`. `encoding-type=url` encodes keys, prefixes and markers.)
- [x] CompleteMultipartUpload: parse the body's `Part` list. Parts out of order return `InvalidPartOrder`. A missing part or a mismatched ETag returns `InvalidPart`. An undersized non-final part (under 5 MiB) returns `EntityTooSmall`. All are 400, so the status is correct even though the verifier also handles errors inside a 200. `If-None-Match` returns 501 (D7). (As does `If-Match`. ETags match with or without quotes. An empty part list is `MalformedXML`. Order is checked first, then each part, then sizes. Assembly copies the parts on the event loop, as CopyObject does.)
- [x] Assemble the object in `staging/`, `fsync` it and `rename` it into `blobs/`. In one transaction, insert the `objects` row and delete the upload and part rows. Then delete the part blobs and any replaced object blob.
- [x] Multipart ETag: MD5 of the concatenated binary part MD5s, followed by `-<part count>` (a design choice, not verified).
- [x] AbortMultipartUpload: 204. Deletes the upload's parts and blobs. Unknown upload returns `NoSuchUpload`. Check `abort-multipart-upload.js` and `complete-multipart-upload.js` for how a repeated call after success or abort is expected to behave. (Both accept `NoSuchUpload` (404) for a repeat, which is what MicroS3 answers.)

**Checks:** `create-multipart-upload.js`, `upload-part.js`, `list-parts.js`, `list-multipart-uploads.js`, `complete-multipart-upload.js`, `abort-multipart-upload.js`, `multipart-cleanup.js`. (On 2026-11-21, all six multipart checks passed. Tests in `test/uploads_test.cpp` and `test/server_test.cpp`.)

## Phase 9: Conditional requests

- [x] Parse HTTP dates as IMF-fixdate. Future and unparseable dates are unspecified (design answer 5), so ignore them. (`clock::parse_http_date`.)
- [x] Evaluate in RFC 9110 section 13.2.2 order: `If-Match`, then `If-Unmodified-Since` (ignored when `If-Match` is present), then `If-None-Match`, then `If-Modified-Since` (ignored when `If-None-Match` is present). Range is applied after these (Phase 3). (`conditions::evaluate`, used by GetObject and HeadObject since Phase 3.)
- [x] Failed `If-None-Match` or `If-Modified-Since` on GET or HEAD returns 304. Failed `If-Match` or `If-Unmodified-Since` returns 412 `PreconditionFailed`.
- [x] Compare dates at one-second resolution, using the stored `Last-Modified`.
- [x] HEAD and 304 responses have no body on the wire, even on a raw socket.
- [x] CopyObject: `x-amz-copy-source-if-*` headers. A failed condition returns 412 `PreconditionFailed`. (Through `conditions::evaluate`, with both failure outcomes mapped to 412.)
- [x] Conditional writes (D7): `If-None-Match` on PutObject or CompleteMultipartUpload returns 501 `NotImplemented`. (Both also answer `If-Match` with 501.)

**Checks:** `conditional.js`, with `integrity.js` for the body rules.

## Phase 10: CORS behavior

- [x] Preflight OPTIONS on bucket and object paths, with no signature. Match the first rule for the origin, the `Access-Control-Request-Method` and the `Access-Control-Request-Headers`. A rejected preflight returns 403 with no CORS headers. (`preflight` in `lib/cors_handlers.cpp`, with matching in `lib/cors.cpp`. A missing bucket, no configuration or no matching rule is `AccessForbidden` (403). A missing `Origin` or a missing or unknown requested method is `BadRequest` (400), as in S3.)
- [x] Preflight response: `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers` (only the requested headers that match), `Access-Control-Max-Age` and `Access-Control-Expose-Headers`. (Plus `Access-Control-Allow-Credentials: true` when the origin is echoed, and `Vary: Origin, Access-Control-Request-Headers, Access-Control-Request-Method`.)
- [x] Origin wildcards (`*`, and `https://*.example.net` style per the checks) and a single `*` in `AllowedHeaders`, which matches any run of characters (Floci fails this). (`cors::wildcard_match`. Origins compare exactly and header names case-insensitively.)
- [x] Signed GET, HEAD and PUT requests carrying an `Origin` header get CORS headers from the first matching rule. Add `Vary: Origin`. (`CorsExchange` in `lib/service.cpp` wraps every request on a bucket, error responses included. `Vary: Origin` is added whenever the bucket has a configuration, with or without `Origin`.)
- [x] Match `cors-behavior.js` for the exact echo of `Access-Control-Allow-Origin` (origin or `*`). (`*` when the matching origin pattern is `*`, else the origin.)

**Checks:** `cors-behavior.js`. (On 2026-11-21, "CORS headers on actual requests" passed, and a full `verify` run passed all 43 checks. Tests in `test/cors_test.cpp` and `test/server_test.cpp`.)

## Cross-cutting

- [x] Each request completes promptly. Verify's default request timeout is 30 s. (On 2026-11-21 a full `verify` run with `--request-timeout 5` passed all 43 checks in 6 s. CopyObject and CompleteMultipartUpload still copy on the event loop, so a multi-gigabyte copy would hold up other requests; no check does that.)
- [x] Update the operation checkboxes in `lib/README.md` as each operation lands. (All operations are ticked, and the conditional-write and Range behavior is described.)
- [x] Update the root `README.md` with the build, the run command, the environment variables (including the credentials) and the Docker command. (Also the static-link option, the data directory layout and the test scripts.)
- [ ] Consider a single-PUT size limit (EntityTooLarge above 5 GiB). Optional, since no check exercises it.

## Emulator tests

- [x] Replace `test/hello_test.cpp` with store tests: UTF-8 byte order for listings, continuation token encoding, single-part and multipart ETags, XML escaping, the BadDigest and InvalidDigest rules, bucket-name validation, and Range parsing and 206/416 results. (`hello_test.cpp` is gone. Single-part ETags, BadDigest and InvalidDigest, Range and 206/416 are in `test/server_test.cpp` and `test/conditions_test.cpp`; XML escaping and bucket names have their own tests. Listing order and pagination are in `test/listing_test.cpp`, and continuation tokens and URL encoding in `test/server_test.cpp`. Multipart ETags are in `test/uploads_test.cpp` and `test/server_test.cpp`.)
- [x] SigV4 signing against AWS's published test vectors (Phase 1). (The S3 GET, PUT, lifecycle and list examples, the derived-key example, and `get-vanilla`.)
- [x] MD5, SHA-256, CRC32 and base64 results checked against known vectors, to confirm the wiring to the libraries. (`test/digest_test.cpp`, which also checks HMAC-SHA256 against RFC 4231.)
- [x] Persistence script (`test/persistence.sh`): create a bucket and an object, stop, restart on the same data directory, read the object back. (`test/persistence.sh [binary]`, with helpers in `test/lib-server.sh`. Needs curl 7.75+.)
- [x] Crash-safety script (`test/crash.sh`): start a large PutObject with `curl --limit-rate` so it runs for a while, send SIGKILL mid-upload, restart. The object must be absent or complete, and `staging/` must be empty. (`test/crash.sh [binary]` also kills an overwrite mid-upload and checks the old object survives and no orphan blob remains.)
- [x] Static-link check: `file` and `ldd` on the release binary. (`test/static-check.sh [binary]`.)
- [x] Docker check: the image has no shell, and it runs as `65532:65532`. (`test/docker-check.sh [image]`, which also sends a signed request with `curl --aws-sigv4` and confirms the container keeps running with `/data` writable.)

## Verifier changes

- [x] **V1.** Add a suite selector, such as `--suite <name>`, to `verify/index.js`. design.md's open question 6 says it is needed. Add it to the usage text and to the unit tests. (`--suite`/`-s` in `verify/suites.js`, repeatable or comma-separated, case-insensitive, run in the usual order: `buckets`, `objects`, `listing`, `multipart`, `cors`, `encryption`. An unknown name exits 1 before any request. `--help` prints the new usage text. Tests in `verify/test/suites.test.js` and `verify/test/infrastructure.test.js`; `pnpm test:unit` now has 229 tests, up from 222.)
- [ ] **V2.** Split the long checks into named scenarios, so a failure names the case that failed. `conditional.js` (317 lines) is the first candidate, then `cors-behavior.js` and `list-parts.js`.
- [ ] **V3.** Add the bad-signature check (D5): a signed request with a wrong secret, expecting 403 `SignatureDoesNotMatch`. Add it to the unit tests.
- [ ] **V4.** Before relying on any verifier change, run it against a disposable AWS bucket with explicit permission (`pnpm test --aws`, only where charges are acceptable), as design.md and the todo rule require. V3 is checked against AWS this way too.
- [ ] After any verifier change, run `pnpm test:unit` (229 tests). These tests use a fixture that shares the verifier's assumptions, so they do not show MicroS3 is compatible.

## Done

- [ ] A full `verify` run against MicroS3 exits 0, with every check PASS. None is FAIL, BLOCKED or NOT RUN, and the cleanup output retains no buckets.
- [ ] The emulator tests and the Docker checks above pass.
