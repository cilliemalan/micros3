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

Out of scope: tagging, ACLs, policies, versioning, replication, object lock, website configuration, changing bucket encryption, S3 Select, S3 Tables and S3 Vectors.

Open question: whether requests must carry valid SigV4 signatures. `verify` signs its requests but no check asserts that a bad signature is rejected, so the first version can accept any credentials.

## Verify program analysis

`verify` is a Node.js 20+ program in `verify/`. `verify/index.js` parses options, resolves the target, creates one `S3Client` with path-style addressing and runs the suites in order: buckets, objects, listing, multipart, CORS, encryption. Each check in `verify/checks` is a named `run({ client })` function. The runner reports PASS, FAIL, BLOCKED (a prerequisite request failed) or NOT RUN (run timeout reached).

Before any suite, the runner calls ListBuckets. If that fails, the run stops.

Every check creates uniquely named buckets or objects, cleans up in `finally`, and retains a bucket when its uploads cannot be listed and aborted. Checks use the AWS SDK for v3, so SigV4 signing, XML parsing and error mapping are exercised for real.

What the checks assert, by area:

| Area | Files | Main assertions |
| --- | --- | --- |
| Buckets | bucket.js, resources.js | Name validation, repeat CreateBucket keeps the bucket, HeadBucket, GetBucketLocation, DeleteBucket refuses non-empty buckets, ListBuckets |
| Objects | put-get-object.js, object.js, delete-object.js, delete-objects.js, copy-object.js | Binary and empty bodies, metadata and headers, overwrite, key isolation, NoSuchKey/NoSuchBucket codes, DeleteObjects per-key results and the 1,000-key limit, CopyObject with COPY and REPLACE |
| Listing | listing.js, listing-encoding.js, encoding.js | ListObjects and ListObjectsV2 ordering, prefixes, delimiters, pagination, UTF-8 byte order, `EncodingType=url`, XML 1.0-safe output |
| Multipart | create/upload-part/list-parts/list-multipart-uploads/complete/abort/multipart-cleanup .js | Upload lifecycle, part numbering, EntityTooSmall, NoSuchUpload, pagination of listings, cleanup verified by listing again |
| CORS | cors.js, cors-behavior.js | Config CRUD, rule order (first match wins), wildcard origins and headers, OPTIONS preflight (403 when rejected), CORS headers on signed GET/HEAD/PUT |
| Encryption | encryption.js | GetBucketEncryption returns one SSE-S3 (AES256) rule with no KMS key and no Bucket Key |
| Integrity | integrity.js | ETags are MD5 for single-part uploads, copies and SSE-S3 objects; Content-MD5 and CRC32/SHA-256 checksums are validated (BadDigest, InvalidDigest) and a rejected upload changes nothing |
| Conditionals | conditional.js | Date and ETag conditions on GET, HEAD and CopyObject; raw-socket HEAD has no body; 304 has no body |

Two checks have hard-won details. The multipart checks accept `NoSuchBucket` or `NoSuchUpload` with status 404 when both bucket and upload are missing, because AWS does not document the precedence. Error handling must also cope with S3 returning an error inside an HTTP 200 response, such as EntityTooSmall during CompleteMultipartUpload.

The verifier has offline unit tests (`pnpm test:unit`, 229 tests). They use a SigV4-checking in-memory HTTP fixture (`verify/test/fixtures/s3-http.js`) and run the real SDK against it. The fixture shares the verifier's assumptions, so passing these tests does not show MicroS3 is compatible. The offline suite is a regression test for the verifier, not the emulator.

## Architecture

MicroS3 is one C++17 executable, `micros3`, built by the existing CMake project. The current `src/main.cpp` serves `Hello, world!` on port 3923 with uWebSockets. The build fetches uWebSockets and uSockets, and SQLite is compiled in as its single-file amalgamation.

Two configuration options:

- `--data-dir <path>`, or `MICROS3_DATA_DIR`. Default `./data`.
- `--port <n>`, or `MICROS3_PORT`. Default `3923`.

Command-line flags take precedence over environment variables, which take precedence over the defaults. Docker sets the environment variables, so the container needs no arguments.

The executable is linked statically (`-static`, with musl or a static libstdc++ and libgcc). The Docker image is `FROM scratch` with the binary and a `/data` volume.

Request path, in order:

1. HTTP layer (uWebSockets) accepts the connection and reads the body as a stream.
2. Router splits the path-style URL into bucket, key and query, and selects the operation from the method and subresource (`?uploads`, `?uploadId=`, `?cors`, `?encryption`, `?location`, `?list-type=2`).
3. Auth accepts any request in the first version. Signature checking is an open question.
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
  | Auth                 |  accepts any credentials in version 1
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
  cors_xml TEXT                       -- NULL when no configuration is set
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
  bucket TEXT NOT NULL REFERENCES buckets(name),
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
| DeleteBucket on a non-empty bucket | 409 | BucketNotEmpty |
| Missing bucket | 404 | NoSuchBucket |
| Missing key | 404 | NoSuchKey |
| Missing upload, or upload in another bucket or key | 404 | NoSuchUpload |
| Missing CORS configuration | 404 | NoSuchCORSConfiguration |
| Bad Content-MD5 or checksum | 400 | BadDigest |
| Malformed Content-MD5 | 400 | InvalidDigest |
| Undersized non-final part | 400 | EntityTooSmall |
| Parts out of order, or wrong ETag or missing part | 400 | InvalidPartOrder, InvalidPart |
| Failed copy condition | 412 | PreconditionFailed |

For a missing bucket and missing upload together, return `NoSuchBucket` or `NoSuchUpload`, both with 404. The checks accept either.

Listing: ListObjects (v1) uses `marker` and `NextMarker`. ListObjectsV2 uses `continuation-token`, which must be opaque and printable ASCII, so encode the last key in base64. With `EncodingType=url`, encode every key, prefix, delimiter, marker and common prefix. Keys in the XML must be escaped, and the response must contain no character XML 1.0 forbids.

Conditional requests follow RFC 9110 section 13.2.2 and [lib/README.md](../lib/README.md). Read conditions return 304 or 412. HEAD and 304 responses have no body, and HEAD's `Content-Length` is the object size.

CORS: configurations are stored per bucket and evaluated first-match in rule order. Preflight `OPTIONS` requests need no signature. A rejected preflight returns 403 with no CORS headers. A matched request returns `Access-Control-Allow-Origin` and the other CORS headers. A single `*` in an `AllowedHeaders` entry matches any run of characters, and `Access-Control-Allow-Headers` lists the requested headers that match. The configuration rejects an unsupported method, missing origins or methods, an empty configuration, and more than 100 rules.

DeleteObjects accepts at most 1,000 keys and returns a result for each. Successful and failed keys are reported separately.

## Implementation order

`verify` runs every suite on each invocation and has no option to select one. Each phase is done when the checks named for it pass in a full run. Later phases can fail for earlier reasons, so read the earlier failures first. A check that needs an unfinished operation reports BLOCKED, not FAIL.

1. **Skeleton.** Flags and environment for `--data-dir` and `--port`, the HTTP server, path-style routing, the XML error writer, the SQLite schema, the startup scan, and the static Docker build. Done when `ListBuckets` returns an empty list (the first call in `verification.js`).
2. **Buckets.** ListBuckets, CreateBucket, HeadBucket, GetBucketLocation, DeleteBucket (`bucket.js`, `resources.js`). DeleteBucket must refuse a non-empty bucket. Every later check creates buckets, so this phase comes first.
3. **Objects.** PutObject, GetObject, HeadObject, DeleteObject (`put-get-object.js`, `object.js`, `delete-object.js`). Include MD5 ETags, `Content-MD5`, and CRC32 and SHA-256 checksums (`integrity.js`). Most checks use these for cleanup.
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

The endpoint can instead come from `AWS_ENDPOINT_URL` in an env file, passed with `-e` as `floci.env` is. Add `--request-timeout` and `--run-timeout` only to tune the defaults (30 s and 1,800 s).

Run it in Docker:

```sh
docker build -t micros3 .
docker run --rm -p 3923:3923 -v micros3-data:/data micros3
# from the host, with the same verify command as above
```

The image sets `MICROS3_DATA_DIR=/data` and `MICROS3_PORT=3923`. The image contains only the executable, built `FROM scratch`. Confirm that with `docker run --rm --entrypoint /bin/sh micros3`, which must fail because there is no shell.

Emulator-only tests, in addition to `verify`:

- GoogleTest for the store: ListObjectsV2 and ListObjects ordering in UTF-8 byte order, continuation token encoding, ETag computation for single-part and multipart uploads, XML escaping, and the BadDigest and InvalidDigest rules.
- Persistence: create a bucket and an object, stop the server, restart it on the same data directory, and read the object back.
- Crash safety: start a large PutObject, kill the process with SIGKILL during the upload, restart, then confirm the object is absent or complete, and that `staging/` is empty.
- Static linkage: run `ldd` or `file` on the binary and confirm it is static.

Last, run the verifier's own offline tests (`pnpm test:unit`, 229 tests) to confirm the verifier still works. Those tests do not show the emulator is compatible.

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

1. Signatures. Should MicroS3 reject bad SigV4 signatures? `verify` never checks that. Accepting any credentials is simpler, and a later version can add checking. **ANSWER: MicroS3 should reject.**
2. DeleteBucket with in-progress uploads. A bucket with uploads in progress can be deleted, but `verify` treats it as stranding uploads. The design refuses DeleteBucket while objects or uploads exist, unless a later decision says otherwise.
   **ANSWER: when deleting a bucket with in-progress uploads, the uploads should fail (either immediately or when they complete).**
3. Object responses for SSE-S3. Should PutObject, GetObject and HeadObject return `x-amz-server-side-encryption: AES256`? The integrity checks use SSE-S3 objects, so probably yes. **ANSWER: yes**
4. Conditional writes. `If-None-Match` on PutObject and CompleteMultipartUpload is not defined in [lib/README.md](../lib/README.md), so it stays unsupported. **ANSWER: Unsupported**
5. Future and unparseable dates. Not defined by S3 and not exercised, so they are left unspecified. **ANSWER: do whatever**
6. Suite selection. `verify` cannot run one suite at a time. A `--suite` flag would speed up phase-by-phase work, and splitting long checks into scenarios is already listed in [todo.md](todo.md). **ANSWER: support needs to be added**
