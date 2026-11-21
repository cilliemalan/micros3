# MicroS3 S3 Emulator Design

## Goals and scope

MicroS3 must pass a full run of `verify` against it, with every check passing, as a full run against AWS S3 does. It implements the operations that `verify` exercises and no others.

In scope, from [lib/README.md](../lib/README.md) and the SDK commands in `verify/checks`:

- Buckets: ListBuckets, CreateBucket, HeadBucket, DeleteBucket, GetBucketLocation
- Objects: PutObject, GetObject, HeadObject, DeleteObject, DeleteObjects (at most 1,000 keys), CopyObject
- Listing: ListObjects and ListObjectsV2, with prefix, delimiter, pagination and `EncodingType=url`
- Multipart: CreateMultipartUpload, UploadPart, CompleteMultipartUpload, AbortMultipartUpload, ListMultipartUploads, ListParts
- CORS: PutBucketCors, GetBucketCors, DeleteBucketCors, CORS headers on actual requests, and OPTIONS preflight
- Encryption: GetBucketEncryption
- Conditional requests on GET, HEAD and CopyObject, as defined in lib/README.md
- Range reads on GetObject and HeadObject: one `bytes=` range, answered with 206 or 416

Out of scope: tagging, ACLs, policies, versioning, replication, object lock, website configuration, changing bucket encryption, S3 Select, S3 Tables and S3 Vectors.

Requests must carry valid SigV4 signatures, and MicroS3 rejects the rest (see Authentication). `verify` signs its requests, but no check currently asserts that a bad signature is rejected. A check for a wrong secret is planned (todo V3).

## Verify program analysis

`verify` is a Node.js 20+ program in `verify/`. `verify/index.js` parses options, resolves the target, creates one `S3Client` with path-style addressing and runs the suites in order: buckets, objects, listing, multipart, CORS, encryption. Each check in `verify/checks` is a named `run({ client })` function. The runner reports PASS, FAIL, BLOCKED (a prerequisite request failed) or NOT RUN (run timeout reached). Longer checks (`conditional.js`, `cors-behavior.js`, `list-parts.js`) wrap each case in `scenario(name, fn)` from `verify/test-runner.js`, so a failure reads `FAIL <check>: <scenario>: <reason>`; a missing prerequisite inside a scenario still reports BLOCKED.

Before any suite, the runner calls ListBuckets. If that fails, the run stops.

Every check creates uniquely named buckets or objects, cleans up in `finally`, and retains a bucket when its uploads cannot be listed and aborted. Checks use the AWS SDK for v3, so SigV4 signing, XML parsing and error mapping are exercised for real.

What the checks assert, by area:

| Area | Files | Main assertions |
| --- | --- | --- |
| Buckets | bucket.js, resources.js | Name validation, repeat CreateBucket keeps the bucket, HeadBucket, GetBucketLocation, DeleteBucket refuses non-empty buckets, ListBuckets |
| Objects | put-get-object.js, object.js, delete-object.js, delete-objects.js, copy-object.js | Binary and empty bodies, metadata and headers, overwrite, key isolation, NoSuchKey/NoSuchBucket codes, single-range GET and HEAD (206, Content-Range, 416), DeleteObjects per-key results and the 1,000-key limit, CopyObject with COPY and REPLACE |
| Listing | listing.js, listing-encoding.js, encoding.js | ListObjects and ListObjectsV2 ordering, prefixes, delimiters, pagination, UTF-8 byte order, `EncodingType=url`, XML 1.0-safe output |
| Multipart | create/upload-part/list-parts/list-multipart-uploads/complete/abort/multipart-cleanup .js | Upload lifecycle, part numbering, EntityTooSmall, NoSuchUpload, pagination of listings, cleanup verified by listing again |
| CORS | cors.js, cors-behavior.js | Config CRUD, rule order (first match wins), wildcard origins and headers, OPTIONS preflight (403 when rejected), CORS headers on signed GET/HEAD/PUT |
| Encryption | encryption.js | GetBucketEncryption returns one SSE-S3 (AES256) rule with no KMS key and no Bucket Key |
| Integrity | integrity.js | ETags are MD5 for single-part uploads, copies and SSE-S3 objects; Content-MD5 and CRC32/SHA-256 checksums are validated (BadDigest, InvalidDigest) and a rejected upload changes nothing |
| Conditionals | conditional.js | Date and ETag conditions on GET, HEAD and CopyObject; raw-socket HEAD has no body; 304 has no body |

Two checks have hard-won details. The multipart checks accept `NoSuchBucket` or `NoSuchUpload` with status 404 when both bucket and upload are missing, because AWS does not document the precedence. Error handling must also cope with S3 returning an error inside an HTTP 200 response, such as EntityTooSmall during CompleteMultipartUpload.

The verifier has offline unit tests (`pnpm test:unit`, 230 tests). They use a SigV4-checking in-memory HTTP fixture (`verify/test/fixtures/s3-http.js`) and run the real SDK against it. The fixture shares the verifier's assumptions, so passing these tests does not show MicroS3 is compatible. The offline suite is a regression test for the verifier, not the emulator.

## Architecture

MicroS3 is one C++17 executable, `micros3`, built by the existing CMake project. The current `src/main.cpp` serves `Hello, world!` on port 3923 with uWebSockets. All third-party code is downloaded by CMake, as the next section describes.

### Third-party libraries

CMake downloads each third-party library with `FetchContent`, as it already does for uWebSockets and GoogleTest. Nothing is vendored. Each library is pinned to an exact tag, or to a URL with a hash. The new libraries are built as static libraries, with their tests and command-line programs turned off.

| Library | Used for | Pin |
| --- | --- | --- |
| uWebSockets and uSockets | HTTP server | GitHub `uNetworking/uWebSockets` v20.81.0 (existing) |
| SQLite | metadata store | `https://www.sqlite.org/2026/sqlite-amalgamation-3540100.zip` (3.54.1), `URL_HASH SHA3_256=92281c86e2957f9b9305890f9ac04204caa7b677cc868dc326d942689df28e30` |
| nlohmann/json | JSON for the `headers` column | GitHub `nlohmann/json` v3.12.0 |
| pugixml | parsing XML request bodies | GitHub `zeux/pugixml` v1.16 |
| Mbed TLS | MD5, SHA-256, HMAC-SHA256 for SigV4, base64 | GitHub `Mbed-TLS/mbedtls` mbedtls-3.6.8 (3.6 branch) |
| zlib | CRC32 | GitHub `madler/zlib` v1.3.1 |
| GoogleTest | tests | GitHub `google/googletest` v1.17.0 (existing) |

If the installed CMake cannot check a `SHA3_256` hash, raise `cmake_minimum_required` rather than drop the hash.

Two configuration options, each set by a flag or an environment variable:

- `--data-dir <path>`, or `MICROS3_DATA_DIR`. Default `./data`.
- `--port <n>`, or `MICROS3_PORT`. Default `3923`.

Command-line flags take precedence over environment variables, which take precedence over the defaults. Docker sets the environment variables, so the container needs no arguments. Credentials are not flags. They come only from `MICROS3_ACCESS_KEY_ID` and `MICROS3_SECRET_ACCESS_KEY`, defaulting to `test` and `test`, so secrets stay out of the process list.

The executable is linked statically (`-static`) against musl, so it needs no libraries from the image. The Docker builder stage is Alpine. The image is `FROM scratch` with the binary and a `/data` volume. It runs as numeric user `65532:65532`, and `/data` is owned by that user, because `scratch` has no user database.

Request path, in order:

1. HTTP layer (uWebSockets) accepts the connection and reads the body as a stream.
2. Router splits the path-style URL into bucket, key and query, and selects the operation from the method and subresource (`?uploads`, `?uploadId=`, `?cors`, `?encryption`, `?location`, `?list-type=2`). Unsupported subresources and out-of-scope operations return `NotImplemented` (501).
3. Auth checks the SigV4 header signature against the configured credentials, and checks `x-amz-content-sha256` against the SHA-256 of the body. Unsigned requests are rejected, except CORS preflight `OPTIONS`, which carries no signature.
4. Operation handler validates the request and reads or writes the store.
5. XML writer renders the response or error body with the S3 error code and status.

Put and multipart parts stream to a temporary file in the data directory, then rename into place. A failed or interrupted upload therefore never leaves a partial object visible.

Every request follows this path. Only the handlers touch the store, so they are the one place to test behavior.

```
  +----------------------+
  | S3 client            |  verify or any AWS SDK, path-style URLs
  +----------------------+
             |
             v
  +----------------------+
  | HTTP server          |  uWebSockets on port 3923, streams bodies
  +----------------------+
             |
             v
  +----------------------+
  | Router               |  bucket, key and subresource from the path
  +----------------------+
             |
             v
  +----------------------+
  | Auth                 |  checks SigV4 signatures
  +----------------------+
             |
             v
  +----------------------+        +----------------------+
  | Operation handlers   | -----> | XML writer           |  success and error bodies
  | (validate, then      |        +----------------------+
  |  read or write)      |                   |
  +----------------------+        XML response back to the client
        |            |
   metadata        bodies
        v            v
  +-------------+ +-------------------------------+
  | SQLite      | | Blob files                    |
  | metadata    | | blobs/ by random id;          |
  | micros3.db; | | staging/ first                |
  | one txn per | |                               |
  | write       | |                               |
  +-------------+ +-------------------------------+
```

## Storage design

The data directory holds three things: one SQLite database for metadata, one file per stored object or part, and a staging area.

```
<data-dir>/
  micros3.db          SQLite metadata (WAL mode)
  blobs/<blob-id>     object and part bodies, named by random hex id
  staging/            uploads in progress, before their rename into blobs/
```

Blob files are named by a random id, never by the key. That keeps keys with `/`, control characters or long names out of the filesystem.

Schema:

```sql
CREATE TABLE buckets (
  name TEXT PRIMARY KEY,
  created_ms INTEGER NOT NULL,
  cors_xml TEXT,                      -- NULL when no configuration is set
  region TEXT NOT NULL DEFAULT 'us-east-1'  -- LocationConstraint at creation
);
CREATE TABLE objects (
  bucket TEXT NOT NULL REFERENCES buckets(name),
  key BLOB NOT NULL,                  -- raw UTF-8 bytes
  blob_id TEXT NOT NULL,
  size INTEGER NOT NULL,
  etag TEXT NOT NULL,
  last_modified_ms INTEGER NOT NULL,
  headers TEXT NOT NULL,              -- JSON: Content-Type, Cache-Control, x-amz-meta-*, ...
  PRIMARY KEY (bucket, key)
) WITHOUT ROWID;
CREATE TABLE uploads (
  upload_id TEXT PRIMARY KEY,
  bucket TEXT NOT NULL REFERENCES buckets(name) ON DELETE CASCADE,
  key BLOB NOT NULL,
  initiated_ms INTEGER NOT NULL,
  headers TEXT NOT NULL
);
CREATE TABLE parts (
  upload_id TEXT NOT NULL REFERENCES uploads(upload_id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  blob_id TEXT NOT NULL,
  size INTEGER NOT NULL,
  etag TEXT NOT NULL,
  last_modified_ms INTEGER NOT NULL,
  PRIMARY KEY (upload_id, part_number)
) WITHOUT ROWID;
```

Foreign keys are on for every connection (`PRAGMA foreign_keys=ON`). Deleting a bucket cascades to its `uploads` and `parts` rows. The part blob files are then deleted, as replaced object blobs are. A bucket's objects must be gone before it is deleted, so `objects` needs no cascade.

SQLite compares BLOBs with `memcmp`, so keys sort in UTF-8 byte order, which is the order S3 uses. Keys are stored as BLOBs so no text collation or NUL handling can change the order.

PutObject crash safety, in order:

1. Stream the body to `staging/`, computing MD5 and any checksums as it arrives.
2. Validate `Content-MD5` and `x-amz-checksum-*`. On mismatch, delete the staging file and return `BadDigest`.
3. `fsync` the file, then `rename` it into `blobs/`.
4. In one transaction, upsert the `objects` row and commit with `synchronous=FULL`.
5. Delete the replaced blob, if any.

At startup, delete any `staging/` file and any `blobs/` file no row refers to. The result is that a crash never exposes a partial object and never loses a committed one.

ETags follow the layout the checks expect. Single-part uploads, copies and SSE-S3 objects use the hex MD5 of the body. A multipart object uses AWS's form, the MD5 of the concatenated binary part MD5s followed by `-<part count>`. Checks do not assert the multipart form, so this is a design choice, not a verified requirement.

## Request handling

Only path-style URLs are needed: `verify` sets `forcePathStyle: true`, so the bucket is the first path segment.

Errors are XML with `Code`, `Message`, `Resource` and `RequestId`. The status codes below are the ones the checks assert.

| Condition | Status | Code |
| --- | --- | --- |
| Invalid bucket name | 400 | InvalidBucketName |
| CreateBucket on a bucket already owned | 409 | BucketAlreadyOwnedByYou |
| DeleteBucket on a bucket that holds objects | 409 | BucketNotEmpty |
| Missing bucket | 404 | NoSuchBucket |
| Missing key | 404 | NoSuchKey |
| Missing upload, or upload in another bucket or key | 404 | NoSuchUpload |
| Missing CORS configuration | 404 | NoSuchCORSConfiguration |
| Bad Content-MD5 or checksum | 400 | BadDigest |
| Malformed Content-MD5 | 400 | InvalidDigest |
| Undersized non-final part | 400 | EntityTooSmall |
| Parts out of order, or wrong ETag or missing part | 400 | InvalidPartOrder, InvalidPart |
| Failed copy condition | 412 | PreconditionFailed |
| Unsigned request, unknown access key, or wrong signature | 403 | AccessDenied, InvalidAccessKeyId, SignatureDoesNotMatch |
| `x-amz-content-sha256` differs from the body | 400 | XAmzContentSHA256Mismatch |
| Range not satisfiable | 416 | InvalidRange |
| Conditional write (`If-None-Match` on PutObject or CompleteMultipartUpload) | 501 | NotImplemented |
| Out-of-scope subresource or operation | 501 | NotImplemented |

For a missing bucket and missing upload together, return `NoSuchBucket` or `NoSuchUpload`, both with 404. The checks accept either.

DeleteBucket on a bucket whose only contents are uploads succeeds, and removes those uploads and their parts. A request on one of those uploads that arrives after the delete fails with `NoSuchBucket` or `NoSuchUpload` (404). An UploadPart or CompleteMultipartUpload already in progress fails at its commit, when it finds no upload row.

Listing: ListObjects (v1) uses `marker` and `NextMarker`. ListObjectsV2 uses `continuation-token`, which must be opaque and printable ASCII, so encode the last key in base64. With `EncodingType=url`, encode every key, prefix, delimiter, marker and common prefix. Keys in the XML must be escaped, and the response must contain no character XML 1.0 forbids.

Conditional requests follow RFC 9110 section 13.2.2 and [lib/README.md](../lib/README.md). Read conditions return 304 or 412. HEAD and 304 responses have no body, and HEAD's `Content-Length` is the object size. `If-None-Match` on PutObject and CompleteMultipartUpload returns 501 `NotImplemented`.

Range: GetObject and HeadObject accept one range, `bytes=a-b`, `bytes=a-` or `bytes=-n`. A satisfiable range returns 206 with `Content-Range` and only those bytes. An unsatisfiable one returns 416 `InvalidRange`. A `Range` header with several ranges is ignored, and the whole object is returned with 200. Range is applied after the conditions, in the order RFC 9110 gives.

CORS: configurations are stored per bucket and evaluated first-match in rule order. Preflight `OPTIONS` requests need no signature. A rejected preflight returns 403 with no CORS headers. A matched request returns `Access-Control-Allow-Origin` and the other CORS headers. A single `*` in an `AllowedHeaders` entry matches any run of characters, and `Access-Control-Allow-Headers` lists the requested headers that match. The configuration rejects an unsupported method, missing origins or methods, an empty configuration, and more than 100 rules.

DeleteObjects accepts at most 1,000 keys and returns a result for each. Successful and failed keys are reported separately.

## Authentication

Every request except CORS preflight `OPTIONS` must carry a SigV4 signature in the `Authorization` header, as the AWS SDK sends it. The server rebuilds the canonical request and string to sign, derives the signing key from the configured secret, and compares signatures in constant time. The access key ID must match the configured one.

- Credentials come from `MICROS3_ACCESS_KEY_ID` and `MICROS3_SECRET_ACCESS_KEY` (default `test` and `test`). There is one credential pair. Its secret is never printed or logged.
- Missing signature: 403 `AccessDenied`. Unknown access key: 403 `InvalidAccessKeyId`. Wrong signature: 403 `SignatureDoesNotMatch`.
- `x-amz-content-sha256` is compared with the SHA-256 of the streamed body, which is computed during the upload. A mismatch returns 400 `XAmzContentSHA256Mismatch`, and the staged body is deleted.
- Query-string (presigned) signing is not accepted in this version. `verify` does not use presigned URLs.
- OPTIONS preflight is accepted without a signature, and its CORS rules are checked as described below.

## Implementation order

`verify` runs every suite by default. `--suite <name>` (repeatable, or comma-separated) runs only the named suites: `buckets`, `objects`, `listing`, `multipart`, `cors` and `encryption`. Each phase is done when the checks named for it pass in a full run. Later phases can fail for earlier reasons, so read the earlier failures first. A check that needs an unfinished operation reports BLOCKED, not FAIL.

1. **Skeleton.** Flags and environment for `--data-dir` and `--port`, the FetchContent dependencies, SigV4 authentication with the payload hash check, the HTTP server, path-style routing, the XML error writer, the SQLite schema, the startup scan, and the static Docker build. Done when `ListBuckets` returns an empty list (the first call in `verification.js`).
2. **Buckets.** ListBuckets, CreateBucket, HeadBucket, GetBucketLocation, DeleteBucket (`bucket.js`, `resources.js`). DeleteBucket must refuse a bucket that holds objects, and must delete a bucket whose only contents are uploads. Every later check creates buckets, so this phase comes first.
3. **Objects.** PutObject, GetObject, HeadObject, DeleteObject (`put-get-object.js`, `object.js`, `delete-object.js`). Include MD5 ETags, `Content-MD5`, and CRC32 and SHA-256 checksums (`integrity.js`). Add single-range reads on GET and HEAD. Most checks use these for cleanup.
4. **Encryption.** GetBucketEncryption (`encryption.js`). It is small, and it reports the SSE-S3 default.
5. **Listing.** ListObjects and ListObjectsV2 with prefix, delimiter, pagination, and empty and missing buckets (`listing.js`). Then `EncodingType=url`, UTF-8 ordering and XML safety (`listing-encoding.js`, `encoding.js`).
6. **DeleteObjects and CopyObject.** The 1,000-key limit and per-key results (`delete-objects.js`). CopyObject with COPY and REPLACE metadata, and cross-bucket copies (`copy-object.js`).
7. **CORS configuration.** PutBucketCors, GetBucketCors, DeleteBucketCors and their validation (`cors.js`).
8. **Multipart.** CreateMultipartUpload, UploadPart, ListParts, ListMultipartUploads, CompleteMultipartUpload, AbortMultipartUpload (`create-multipart-upload.js` through `abort-multipart-upload.js`, with `multipart-cleanup.js`). Cleanup needs ListMultipartUploads and AbortMultipartUpload to work reliably.
9. **Conditional requests.** Date and ETag conditions on GET, HEAD and CopyObject, and raw-socket HEAD and 304 checks (`conditional.js`). Requires phases 3 and 6.
10. **CORS behavior.** Preflight OPTIONS, first-match order, wildcards, and CORS headers on signed requests (`cors-behavior.js`). Requires phase 7 and the OPTIONS handling in phase 1.

Checks not yet started when the run deadline passes are reported NOT RUN, which fails the run. Checks in progress have their requests cancelled, so a slow server can fail the run for reasons unrelated to correctness. Each request should complete promptly.

## Verification plan

The emulator is accepted when `verify` passes in full against it. That means exit status 0, every check PASS, none FAIL, BLOCKED or NOT RUN, and no retained buckets in the cleanup output.

Run it locally:

```sh
cmake -B ooo && cmake --build ooo
./ooo/micros3 --data-dir ./data --port 3923

cd verify && pnpm install
pnpm test --endpoint http://localhost:3923
```

The endpoint can instead come from `AWS_ENDPOINT_URL` in an env file, passed with `-e` as `floci.env` is. That file also supplies the credentials, which must match MicroS3's. `floci.env` uses `test` and `test`, the defaults. Add `--request-timeout` and `--run-timeout` only to tune the defaults (30 s and 1,800 s).

Run it in Docker:

```sh
docker build -t micros3 .
docker run --rm -p 3923:3923 -v micros3-data:/data micros3
# from the host, with the same verify command as above
```

The image sets `MICROS3_DATA_DIR=/data` and `MICROS3_PORT=3923`. The image contains only the executable, built `FROM scratch`, and it runs as `65532:65532`. Set `MICROS3_ACCESS_KEY_ID` and `MICROS3_SECRET_ACCESS_KEY` with `-e` to change the credentials. Confirm that with `docker run --rm --entrypoint /bin/sh micros3`, which must fail because there is no shell.

Emulator-only tests, in addition to `verify`:

- GoogleTest for the store: ListObjectsV2 and ListObjects ordering in UTF-8 byte order, continuation token encoding, ETag computation for single-part and multipart uploads, XML escaping, and the BadDigest and InvalidDigest rules. Also SigV4 signing against AWS's published test vectors, and MD5, SHA-256, CRC32 and base64 results against known vectors.
- Persistence: create a bucket and an object, stop the server, restart it on the same data directory, and read the object back.
- Crash safety: start a large PutObject, kill the process with SIGKILL during the upload, restart, then confirm the object is absent or complete, and that `staging/` is empty.
- Static linkage: run `ldd` or `file` on the binary and confirm it is static.

Last, run the verifier's own offline tests (`pnpm test:unit`, 230 tests) to confirm the verifier still works. Those tests do not show the emulator is compatible.

Before relying on a pass, validate the checks against a disposable AWS bucket with explicit permission, as [todo.md](todo.md) requires. Use `pnpm test --aws` only with an account where charges are acceptable.

## Open questions and known gaps

Floci is the local check of `verify`, not a model of S3. Its failures are defects to avoid, not behavior to copy. On 2026-11-20 a configured `verify` run against Floci reported 28 passes and 18 failures, as recorded in [todo.md](todo.md). The failures and the S3 behavior MicroS3 must match:

| Area | Floci | Required behavior |
| --- | --- | --- |
| Bucket names | Accepts underscores | Reject names outside the AWS rules, with InvalidBucketName |
| CopyObject REPLACE | Keeps the source Cache-Control | Keeps only the metadata the request supplies |
| DeleteObjects | Accepts 1,001 keys | Reject more than 1,000 keys |
| PutBucketCors | Accepts invalid configurations | Reject unsupported methods, missing origins or methods, an empty configuration, and more than 100 rules |
| ListMultipartUploads | Omits IsTruncated and markers; ignores MaxUploads | Honor MaxUploads and return truncation and continuation fields |
| CompleteMultipartUpload | Accepts an undersized non-final part | Return EntityTooSmall |
| ListObjects keys | Orders by UTF-16 code units; raw key in tokens | UTF-8 byte order; opaque, printable tokens |
| CORS AllowedHeaders | Wildcards not matched | A single `*` matches any run of characters |

Other matters for consideration:

1. Signatures. Should MicroS3 reject bad SigV4 signatures? `verify` never checks that. **ANSWER: MicroS3 should reject.** Decided: unsigned, unknown-key and wrong-signature requests get 403, and a `verify` check for a wrong secret is added (todo V3).
2. DeleteBucket with in-progress uploads. A bucket with uploads in progress can be deleted, but `verify` treats it as stranding uploads. The earlier text of this design, which refused DeleteBucket while uploads existed, is replaced by the decision below.
   **DECIDED (D1):** DeleteBucket returns `BucketNotEmpty` when objects exist. A bucket whose only contents are uploads is deleted with its uploads and parts, and later requests on them fail with `NoSuchBucket` or `NoSuchUpload`.
3. Object responses for SSE-S3. Should PutObject, GetObject and HeadObject return `x-amz-server-side-encryption: AES256`? The integrity checks use SSE-S3 objects, so probably yes. **ANSWER: yes**
4. Conditional writes. `If-None-Match` on PutObject and CompleteMultipartUpload is not defined in [lib/README.md](../lib/README.md), so it stays unsupported. **ANSWER: Unsupported**, and the request returns 501 `NotImplemented` rather than being ignored (D7).
5. Future and unparseable dates. Not defined by S3 and not exercised, so they are left unspecified. **ANSWER: do whatever**
6. Suite selection. `verify` could not run one suite at a time. A `--suite` flag would speed up phase-by-phase work, and splitting long checks into scenarios is listed in [todo.md](todo.md) as V2. **ANSWER: support needs to be added.** Added to the todo as V1, and done: `--suite <name>`.
7. Multiple ranges. A `Range` header with several ranges is not covered by the requirements. **DECIDED (D6):** it is ignored, and the whole object is returned with 200.
