# MicroS3 TODO

Source of truth: [design.md](design.md). Phases follow its "Implementation order" and keep its numbers (1 to 10). Tick an item in the same commit that makes it true. A phase is done when the verify checks named for it pass in a full run. Until verify can run a single suite (item V1), read those checks' lines in the full run output.

Items marked **Decide** need an answer before the work starts. Each has a proposed answer. Change it here, then record the final answer in design.md.

## Starting point

- `src/main.cpp` serves `Hello, world!` on port 3923 with uWebSockets. It has no flags, routing, storage, XML or JSON.
- `lib/` holds a placeholder library (`hello.cpp`), and `test/hello_test.cpp` tests it.
- CMake fetches uWebSockets v20.81.0 and GoogleTest v1.17.0. SQLite and the other libraries below are not in the repo yet.
- There is no Dockerfile and no `.dockerignore`.
- The verifier (`verify/`) is complete. Its one recorded run against Floci (`verify/floci.md`) shows 28 passes and 18 failures.

## Decisions

- [ ] **D1. DeleteBucket with uploads in progress.** design.md contradicts itself. Phase 2 and the open question on DeleteBucket say to refuse a bucket while uploads exist. The answer to that question says the uploads should fail. `verify` asserts only the object case (`bucket.js`: `BucketNotEmpty` for an object). *Proposed:* DeleteBucket returns `BucketNotEmpty` (409) when objects exist. When only uploads exist, it deletes the bucket and its upload and part rows. Later requests on those uploads return `NoSuchBucket` or `NoSuchUpload` (404). Then correct design.md.
- [ ] **D2. Credentials for signature checks.** The answer is "reject bad SigV4 signatures", but MicroS3 needs a secret to check against. *Proposed:* one access key and secret, from `MICROS3_ACCESS_KEY_ID` and `MICROS3_SECRET_ACCESS_KEY`, defaulting to `test`/`test` to match `floci.env`. Unsigned requests are rejected, except OPTIONS preflight, which the design exempts. Also check the payload hash (`x-amz-content-sha256`) against the SHA-256 of the streamed body. Error codes: `AccessDenied` for unsigned requests, `InvalidAccessKeyId` for an unknown key, `SignatureDoesNotMatch` for a wrong signature (all 403).
- [ ] **D3. Third-party code.** *Proposed:* vendor single-file dependencies under `lib/third_party/`: the SQLite amalgamation, a JSON single header for the `headers` column, and a small XML parser (for example pugixml) for request bodies. Write MD5, SHA-256, CRC32 and base64 in-house, and test them against published vectors. This keeps the build offline and the binary static.
- [ ] **D4. Static toolchain.** *Proposed:* build in an Alpine (musl) stage with `-static`, so the binary runs in `FROM scratch`. Confirm uSockets builds on musl.
- [ ] **D5. Verifier check for bad signatures.** `verify` never checks that a bad signature is rejected. *Proposed:* add one, a signed request with a wrong secret that expects 403. That makes `verify` cover D2, not only the emulator tests. A rejection check changes what `verify` asserts, and it must pass against real S3 first (see V4).
- [ ] **D6. Range requests (gap in design.md).** `put-get-object.js` and `object.js` exercise `Range` on GetObject and HeadObject (206 with `Content-Range`, 416 when unsatisfiable). design.md does not list them in scope. *Proposed:* add single-range `bytes=a-b`, `bytes=a-` and `bytes=-n` to scope, and update design.md.
- [ ] **D7. Unsupported conditional writes.** `If-None-Match` on PutObject and CompleteMultipartUpload is unsupported. *Proposed:* reject it with `NotImplemented` (501), not silently ignore it. Ignoring it could overwrite data the caller meant to protect.
- [ ] **D8. Static Docker user.** `FROM scratch` has no `/etc/passwd`. *Proposed:* run as numeric `USER 65532:65532`, and make `/data` writable by that user in the Docker build, so the named volume works.

## Phase 1: Skeleton

- [ ] Add `lib/third_party` and link SQLite (D3). Keep `libmicros3` for the server code and drop `lib/hello.*` once the server stops using it.
- [ ] Options: `--data-dir` and `--port`, with environment variables `MICROS3_DATA_DIR` (default `./data`) and `MICROS3_PORT` (default 3923). Flags beat environment variables, which beat defaults. Reject an invalid port with a usage error and a non-zero exit.
- [ ] HTTP server on the configured port, streaming request bodies.
- [ ] Path-style router. It splits the path into bucket, key and query. It selects the operation from method and subresource (`?uploads`, `?uploadId=`, `?cors`, `?encryption`, `?location`, `?list-type=2`).
- [ ] Unsupported subresources and out-of-scope operations (`?tagging`, `?acl`, `?policy`, `?versioning`, and so on) return `NotImplemented` (501). They never fall through to an object operation.
- [ ] XML writer for success bodies and for errors (`Code`, `Message`, `Resource`, `RequestId`). Set the `x-amz-request-id` header to the same value.
- [ ] SQLite in WAL mode, with `synchronous=FULL` for commits and foreign keys on. Create the four tables in the design (`buckets`, `objects`, `uploads`, `parts`) if missing.
- [ ] Startup: create `blobs/` and `staging/`. Delete every file in `staging/`, and every file in `blobs/` that no row refers to.
- [ ] SigV4 header authentication (D2): canonical request, string to sign, derived signing key, constant-time comparison. Use AWS's published test vectors.
- [ ] Payload hash check (D2).
- [ ] Preflight OPTIONS is accepted without a signature. Its full handling is in Phase 10.
- [ ] Dockerfile (D4, D8): a builder stage, then `FROM scratch` with the binary, `ENV MICROS3_DATA_DIR=/data MICROS3_PORT=3923`, `VOLUME /data`, `EXPOSE 3923`, and an entrypoint of the binary. Add `.dockerignore` for `ooo/`, `verify/node_modules` and `.git`.
- [ ] Static link under CMake, excluded on Windows.

**Done when:** the first `verify` call, ListBuckets, returns an empty list. `ldd` or `file` reports the binary as static, and `docker run --rm --entrypoint /bin/sh micros3` fails.

## Phase 2: Buckets

- [ ] Bucket name validation against the AWS rules (3 to 63 characters, lowercase letters, digits and hyphens, alphanumeric at each end, no adjacent dots, not an IP-address form, no `xn--` prefix or `-s3alias` suffix). Return `InvalidBucketName` (400). Underscores are rejected (see Floci).
- [ ] ListBuckets: `Owner`, `Buckets`, `CreationDate` (ISO 8601).
- [ ] CreateBucket: 200 with `Location`. A repeat returns `BucketAlreadyOwnedByYou` (409) and keeps the bucket. Check `bucket.js` for how a `LocationConstraint` is handled.
- [ ] HeadBucket: 200, or 404 with no body.
- [ ] GetBucketLocation: match what `bucket.js` asserts for us-east-1.
- [ ] DeleteBucket: 204. Missing bucket returns `NoSuchBucket`. Objects make it return `BucketNotEmpty` (409). Uploads follow D1.

**Checks:** `bucket.js`, `resources.js`.

## Phase 3: Objects

- [ ] Streamed PutObject: write the body to `staging/` while computing MD5, and the CRC32 and SHA-256 checksums when they are requested. Do not buffer the whole body.
- [ ] `Content-MD5`: a malformed value returns `InvalidDigest` (400). A mismatch returns `BadDigest` (400) and deletes the staging file.
- [ ] `x-amz-checksum-crc32` and `x-amz-checksum-sha256`: mismatch returns `BadDigest`. Match `integrity.js` for malformed values.
- [ ] Commit: `fsync` the staging file, `rename` it into `blobs/`, then in one transaction upsert the `objects` row. Delete the replaced blob after the commit.
- [ ] Store the metadata headers as JSON: `Content-Type`, `Cache-Control`, `Content-Disposition`, `Content-Encoding`, `Content-Language`, `Expires`, and `x-amz-meta-*`. Return them on GET and HEAD.
- [ ] Every PutObject, GetObject and HeadObject response carries `x-amz-server-side-encryption: AES256` (answered yes in design.md).
- [ ] ETag: quoted hex MD5 of the body. Empty and binary bodies work.
- [ ] Keys are stored as raw UTF-8 BLOB bytes. The request path is URL-decoded before storage.
- [ ] GetObject: streams the blob file. Missing key returns `NoSuchKey` (404). Missing bucket returns `NoSuchBucket`.
- [ ] Range (D6): 206 with `Content-Range` and only the requested bytes, or 416 when unsatisfiable.
- [ ] HeadObject: no body. `Content-Length` is the object size. Missing key returns 404 with no body.
- [ ] DeleteObject: 204. Match `delete-object.js` for a missing key.
- [ ] Use the design's order for failures: a failed upload leaves no visible object, and the staging file is removed.

**Checks:** `put-get-object.js`, `object.js`, `delete-object.js`, `integrity.js`.

## Phase 4: Encryption

- [ ] GetBucketEncryption: one rule with `SSEAlgorithm` AES256, no KMS key ID, and no `BucketKeyEnabled: true`. Missing bucket returns `NoSuchBucket`.
- [ ] `PutBucketEncryption` is out of scope and returns `NotImplemented`, through the router item in Phase 1.

**Checks:** `encryption.js`.

## Phase 5: Listing

- [ ] ListObjects (v1): `prefix`, `delimiter`, `marker`, `max-keys`, `IsTruncated`, `NextMarker`, `CommonPrefixes`. Match `listing.js` for when `NextMarker` appears.
- [ ] ListObjectsV2 (`list-type=2`): `prefix`, `delimiter`, `start-after`, `continuation-token`, `max-keys`, `KeyCount`, `IsTruncated`, `NextContinuationToken`. The token is printable ASCII, the base64 of the last key.
- [ ] Order by the BLOB key in SQL (memcmp, which gives UTF-8 byte order). Use the primary-key index.
- [ ] Missing bucket returns `NoSuchBucket`. An empty bucket returns an empty listing.
- [ ] `EncodingType=url`: encode `Key`, `Prefix`, `Delimiter`, `Marker`, `StartAfter`, `NextMarker`, `NextContinuationToken` (when it is a key) and `CommonPrefixes`, and echo `EncodingType`.
- [ ] XML escaping. Output must not contain any character XML 1.0 forbids. Match `listing-encoding.js` and `encoding.js` for control characters without `EncodingType=url`.

**Checks:** `listing.js`, `listing-encoding.js`, `encoding.js`.

## Phase 6: DeleteObjects and CopyObject

- [ ] DeleteObjects: parse the `Delete` XML body, with `Object` entries and `Quiet`. Reject more than 1,000 keys. Match `delete-objects.js` for the status and code. Report each key under `Deleted` or `Error`. A missing key counts as deleted.
- [ ] CopyObject: parse `x-amz-copy-source` (URL-decoded, with an optional leading slash). A missing source returns `NoSuchKey`, and a missing destination bucket returns `NoSuchBucket`. Copy the blob file to a new blob id, so each blob has one owner and deletes stay simple.
- [ ] `x-amz-metadata-directive`: COPY (default) keeps the source metadata. REPLACE keeps only the metadata the request supplies. This fixes Floci's Cache-Control bug.
- [ ] Copies within and across buckets. The response is `CopyObjectResult` with `ETag` and `LastModified`.

**Checks:** `delete-objects.js`, `copy-object.js`.

## Phase 7: CORS configuration

- [ ] PutBucketCors: parse `CORSConfiguration`. Reject unsupported methods, a missing origin or method, an empty configuration, and more than 100 rules, each as `MalformedXML` (400). Check `cors.js` for the expected code. Store the rules in order.
- [ ] GetBucketCors: the stored configuration. No configuration returns `NoSuchCORSConfiguration` (404).
- [ ] DeleteBucketCors: 204, including on repeat. Missing bucket returns `NoSuchBucket`.
- [ ] Each bucket has its own configuration.

**Checks:** `cors.js`.

## Phase 8: Multipart

- [ ] CreateMultipartUpload: `InitiateMultipartUploadResult`, with a random hex `UploadId`. Store the request's metadata headers for use at completion.
- [ ] UploadPart: `partNumber` 1 to 10,000, else `InvalidArgument` (400). Stream to `staging/`, with Content-MD5 validation as for PutObject. A part number that already exists replaces it. Unknown upload returns `NoSuchUpload` (404). Precedence: when the bucket is also missing, return `NoSuchBucket` or `NoSuchUpload`, which the checks accept.
- [ ] Commit a part as for objects, then upsert the `parts` row and delete the replaced part blob.
- [ ] ListParts: `part-number-marker`, `max-parts`, `IsTruncated`, `NextPartNumberMarker`. Unknown upload returns `NoSuchUpload`.
- [ ] ListMultipartUploads: honor `max-uploads` (Floci ignores it). Return `IsTruncated`, `NextKeyMarker`, `NextUploadIdMarker`, `key-marker`, `upload-id-marker`, `prefix`, and `CommonPrefixes` when a delimiter is given. Order by key in byte order.
- [ ] CompleteMultipartUpload: parse the body's `Part` list. Parts out of order return `InvalidPartOrder`. A missing part or a mismatched ETag returns `InvalidPart`. An undersized non-final part (under 5 MiB) returns `EntityTooSmall`. All are 400, so the status is correct even though the verifier also handles errors inside a 200.
- [ ] Assemble the object in `staging/`, `fsync` it and `rename` it into `blobs/`. In one transaction, insert the `objects` row and delete the upload and part rows. Then delete the part blobs and any replaced object blob.
- [ ] Multipart ETag: MD5 of the concatenated binary part MD5s, followed by `-<part count>` (a design choice, not verified).
- [ ] AbortMultipartUpload: 204. Deletes the upload's parts and blobs. Unknown upload returns `NoSuchUpload`. Check `abort-multipart-upload.js` and `complete-multipart-upload.js` for how a repeated call after success or abort is expected to behave.

**Checks:** `create-multipart-upload.js`, `upload-part.js`, `list-parts.js`, `list-multipart-uploads.js`, `complete-multipart-upload.js`, `abort-multipart-upload.js`, `multipart-cleanup.js`.

## Phase 9: Conditional requests

- [ ] Parse HTTP dates as IMF-fixdate. Future and unparseable dates are unspecified (design answer 5), so ignore them.
- [ ] Evaluate in RFC 9110 section 13.2.2 order: `If-Match`, then `If-Unmodified-Since` (ignored when `If-Match` is present), then `If-None-Match`, then `If-Modified-Since` (ignored when `If-None-Match` is present).
- [ ] Failed `If-None-Match` or `If-Modified-Since` on GET or HEAD returns 304. Failed `If-Match` or `If-Unmodified-Since` returns 412 `PreconditionFailed`.
- [ ] Compare dates at one-second resolution, using the stored `Last-Modified`.
- [ ] HEAD and 304 responses have no body on the wire, even on a raw socket.
- [ ] CopyObject: `x-amz-copy-source-if-*` headers. A failed condition returns 412 `PreconditionFailed`.
- [ ] Conditional writes (D7): `If-None-Match` on PutObject or CompleteMultipartUpload returns 501.

**Checks:** `conditional.js`, with `integrity.js` for the body rules.

## Phase 10: CORS behavior

- [ ] Preflight OPTIONS on bucket and object paths, with no signature. Match the first rule for the origin, the `Access-Control-Request-Method` and the `Access-Control-Request-Headers`. A rejected preflight returns 403 with no CORS headers.
- [ ] Preflight response: `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers` (only the requested headers that match), `Access-Control-Max-Age` and `Access-Control-Expose-Headers`.
- [ ] Origin wildcards (`*`, and `https://*.example.net` style per the checks) and a single `*` in `AllowedHeaders`, which matches any run of characters (Floci fails this).
- [ ] Signed GET, HEAD and PUT requests carrying an `Origin` header get CORS headers from the first matching rule. Add `Vary: Origin`.
- [ ] Match `cors-behavior.js` for the exact echo of `Access-Control-Allow-Origin` (origin or `*`).

**Checks:** `cors-behavior.js`.

## Cross-cutting

- [ ] Each request completes promptly. Verify's default request timeout is 30 s.
- [ ] Update the operation checkboxes in `lib/README.md` as each operation lands.
- [ ] Update the root `README.md` with the build, the run command, the environment variables and the Docker command.
- [ ] Consider a single-PUT size limit (EntityTooLarge above 5 GiB). Optional, since no check exercises it.

## Emulator tests

- [ ] Replace `test/hello_test.cpp` with store tests: UTF-8 byte order for listings, continuation token encoding, single-part and multipart ETags, XML escaping, the BadDigest and InvalidDigest rules, bucket-name validation, and the hash and base64 vectors (D3).
- [ ] SigV4 test vectors (D2).
- [ ] Persistence script (`test/persistence.sh`): create a bucket and an object, stop, restart on the same data directory, read the object back.
- [ ] Crash-safety script (`test/crash.sh`): start a large PutObject with `curl --limit-rate` so it runs for a while, send SIGKILL mid-upload, restart. The object must be absent or complete, and `staging/` must be empty.
- [ ] Static-link check: `file` and `ldd` on the release binary.
- [ ] Docker check: the image has no shell.

## Verifier changes

- [ ] **V1.** Add a suite selector, such as `--suite <name>`, to `verify/index.js`. The design says it is needed (its answer 6). Add it to the usage text and to the unit tests.
- [ ] **V2.** Split the long checks into named scenarios, so a failure names the case that failed. `conditional.js` (317 lines) is the first candidate, then `cors-behavior.js` and `list-parts.js`. design.md refers to this item as "already listed in todo.md". It was not, so this is its entry.
- [ ] **V3.** Add the bad-signature check if D5 is accepted.
- [ ] **V4.** Before relying on any verifier change, run it against a disposable AWS bucket with explicit permission (`pnpm test --aws`, only where charges are acceptable), as design.md and the todo rule require.
- [ ] After any verifier change, run `pnpm test:unit` (229 tests). These tests use a fixture that shares the verifier's assumptions, so they do not show MicroS3 is compatible.

## Done

- [ ] A full `verify` run against MicroS3 exits 0, with every check PASS. None is FAIL, BLOCKED or NOT RUN, and the cleanup output retains no buckets.
- [ ] The emulator tests and the Docker checks above pass.
