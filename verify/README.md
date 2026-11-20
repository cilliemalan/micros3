# MicroS3 verification program

This program is intended to verify the S3 operations planned for MicroS3's
[backend](../lib/README.md). It will initially run against an already-running
Floci instance to validate the verifier before checking MicroS3. See
[todo.md](todo.md) for the planned checks.

The verifier first calls ListBuckets to check the S3 connection, then runs the
operation checks in sequence and reports each result and a summary. Implemented
checks cover bucket creation, listing, existence, location and deletion,
including invalid names, repeat creation, missing buckets and non-empty buckets.
Both object-listing APIs are checked for ordered keys and metadata, empty and
missing buckets, prefixes, delimiters, and pagination (including rolled-up
prefixes). Separate checks list keys containing URL- and XML-sensitive
characters, whitespace, control characters and multibyte characters (including
characters outside the Basic Multilingual Plane, whose UTF-8 order differs from
their UTF-16 order) with `EncodingType=url` for both listing APIs. They verify
UTF-8 binary key order, that every encoded field (keys, common prefixes,
`Prefix`, `Delimiter`, `Marker`/`NextMarker` and `StartAfter`) is printable
ASCII that decodes to the original value, prefix and delimiter filtering, and
pagination with decoded markers and opaque continuation tokens. Because S3
encodes a space as `+` and does not document which safe characters it leaves
unescaped, any encoding that form-decodes to the original value is accepted.
Keys that XML 1.0 can represent are also listed without encoding to check XML
escaping and whitespace preservation. The raw response XML is checked to be
valid UTF-8 without characters XML 1.0 forbids, which the SDK's parser would
otherwise tolerate. PutObject checks binary and empty uploads, metadata and headers,
overwrites, key isolation, and missing buckets. GetObject checks binary and empty
content, metadata and headers, overwrites, ranges, ETag conditions, and missing
keys and buckets. HeadObject checks binary and empty objects, metadata and headers,
overwrites, ranges, ETag conditions, and missing keys and buckets. The SDK
exposes no response body for HEAD; the check does not inspect the wire for an
improperly sent body. CopyObject checks cross-bucket and self-copies, binary and
empty objects, URL-encoded keys, metadata and headers, metadata replacement,
overwrites, conditional copies, isolation, and missing keys and buckets.
Integrity checks compare ETags with independently calculated MD5 digests for
binary, empty, overwritten and SSE-S3 single-part uploads and for copies (as
returned by PutObject, GetObject, HeadObject and the CopyObject result), and
verify that PutObject rejects a mismatched `Content-MD5` (`BadDigest`), a
malformed one (`InvalidDigest`), and mismatched CRC32 or SHA-256 checksums
(`BadDigest`) without creating or replacing the object. They also check the
checksum echoed by PutObject. Multipart, SSE-KMS and SSE-C ETags are not
assumed to be MD5 digests and are not checked.
DeleteObject checks binary and empty objects, exact-key
isolation, missing and repeated deletions, recreation, and missing buckets.
DeleteObjects checks verbose and quiet responses, deletion of existing, empty
and absent keys, repeat deletion, recreation, exact-key and bucket isolation,
the 1,000-key limit, and a missing bucket. It does not exercise per-key errors
requiring permissions or versioned deletions (versioning is outside scope).
CreateMultipartUpload checks unique upload IDs, simultaneous uploads for the same
and neighboring keys, non-destructive initiation, independent completion and
metadata, and a missing bucket. UploadPart checks binary and empty parts,
out-of-order uploads, replacement, part number bounds, ETags, isolation,
assembled content, and missing, completed or aborted uploads and buckets.
ListParts checks an upload without parts, part numbers, ETags, sizes and
modification times in part-number order after out-of-order uploads and
replacement, `MaxParts` and `PartNumberMarker` pagination (including markers
that name no part and an exact fit), isolation across uploads, keys and
buckets, and missing, aborted or completed uploads and buckets.
ListMultipartUploads checks empty and missing buckets, upload identities, initiation
timestamps and storage class, key ordering, prefix and delimiter filtering, URL
encoding, marker pagination across same-key uploads and common prefixes, bucket
isolation, and removal after abort and completion. Owner and initiator identity,
permissions, versioning, and directory buckets are not exercised.
CompleteMultipartUpload checks selected parts and assembly, empty objects, response
and metadata, overwriting an object, independent uploads across keys and buckets,
invalid part order, ETags, missing parts and undersized non-final parts, recovery
after rejection, and missing, aborted or completed uploads and buckets. Completion
errors are accepted either with their usual HTTP status or embedded in an HTTP 200
response (which the AWS SDK reports as 503); an ordinary 503 is not accepted. Checksums,
conditional completion and versioning are not exercised. AbortMultipartUpload checks removal of uploads
and parts, repeat and invalid aborts, preservation of existing objects and other
uploads across keys and buckets, completion of a surviving upload, empty uploads,
and a missing bucket.
These checks require ListMultipartUploads, ListParts, UploadPart,
CompleteMultipartUpload and AbortMultipartUpload support. UploadPart,
CompleteMultipartUpload and AbortMultipartUpload use ListParts to observe part
state. When such a ListParts request fails or is unsupported (or returns an
error other than `NoSuchUpload` for a finished upload), the check is reported
as `BLOCKED` with the failed prerequisite rather than as a failure of the
operation under test; blocked checks also fail the run. Incorrect content in a
successful listing is still attributed to the operation under test. CORS configuration checks cover multiple ordered rules and their
fields, replacement, bucket isolation, the 100-rule limit, invalid inputs, and
missing configurations and buckets. Encryption checks verify the SSE-S3 default
configuration on a newly created bucket and the missing-bucket error. Changing
encryption configuration is outside the planned scope. A connection error stops the run, and any
connection or check failure gives a nonzero exit status.

Install Node.js 20 or newer and pnpm, then install dependencies and run the program:

```sh
cd verify
pnpm install
pnpm test
```

To load environment variables from a file, pass its path with `-e` or `--env`:

```sh
pnpm test -e ../floci.env
# or
pnpm test --env ../floci.env
```

The repository's `floci.env` provides the connection settings for the running
Floci instance: `AWS_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
and `AWS_DEFAULT_REGION`. The client uses path-style addressing and the AWS SDK's
credential provider chain; `AWS_REGION` takes precedence over
`AWS_DEFAULT_REGION`. Existing environment variables are not overwritten by the
environment file.

The verifier requires an explicit endpoint. It is taken from `--endpoint <url>`,
then `AWS_ENDPOINT_URL_S3`, then `AWS_ENDPOINT_URL`, and must be an http or https
URL. An `endpoint_url` in the shared AWS config file is not accepted as explicit.
Without an endpoint the verifier refuses to run, unless `--aws` is passed to opt
into the default AWS S3 endpoint; this creates real buckets with your default
credentials and may incur charges. In that mode configured endpoint URLs are
ignored, and `--aws` combined with an endpoint is rejected as ambiguous. The
selected target, its source and the region are printed before any request is
made.

Requests and the run as a whole are bounded. `--request-timeout <seconds>`
(default 30) limits each request, including SDK retries and reading a response
body. `--run-timeout <seconds>` (default 1800) limits the run: checks not yet
started are reported as `NOT RUN` and fail the run, and the requests of a check
in progress are cancelled. Cleanup requests are exempt from the run timeout
(but not the request timeout) for a further `--cleanup-grace <seconds>`
(default 120), so an interrupted check still removes its resources or reports
them by name. A check that has not finished cleaning up by then is abandoned
and reported as a failure whose resources may remain. A timed-out request is
never treated as proof that a resource is missing: an uncertain bucket
creation is still cleaned up, and a bucket is retained when its multipart
uploads cannot be listed and aborted.

`pnpm start` is an alias for the verifier and accepts the same options.
The bucket, object, listing, multipart, CORS and encryption checks create uniquely
named buckets and temporary objects, uploads or CORS configurations. Object keys
are isolated by their per-check buckets. Cleanup is attempted even after failures;
errors identify the resources without hiding the original check failure. Cleanup
validates delete responses and checks that deleted valid test buckets no longer
exist. It is best-effort:
failed or misleading S3 operations can still require manual intervention.
A rejected creation is not cleaned up when the response could indicate a bucket
owned by someone else; after an ambiguous SDK retry, manually inspect the named
bucket. The repeat-creation and
non-empty deletion checks also require PutObject, GetObject and DeleteObject
support. The HeadObject and object listing checks require PutObject and DeleteObject support.
The PutObject, GetObject and CopyObject checks require PutObject and GetObject
and DeleteObject for cleanup; CopyObject also requires cross-bucket access.
The DeleteObject and DeleteObjects checks require PutObject and GetObject
support, including metadata; DeleteObjects also uses DeleteObject for cleanup.
The bucket listing check follows up to 1,000 pages when looking for its two test
buckets. Multipart cleanup lists and aborts uploads, including unknown IDs from
lost or retried creation responses, and lists again after aborting to detect
remaining uploads. It continues deleting objects even if an upload cleanup fails.
If uploads remain or their removal cannot be verified (including a malformed or
failed listing), the bucket is retained instead of being deleted: deleting a
general-purpose bucket can strand in-progress uploads. Inspect the reported bucket,
abort any remaining uploads, remove objects, and delete the bucket manually.
This precaution cannot detect uploads omitted by an otherwise plausible listing.
Timed-out part uploads may still be in flight; S3 may require repeated aborts to
release their storage.

The configured Floci instance currently accepts invalid bucket names, invalid
CORS configurations and DeleteObjects requests with more than 1,000 keys; its
CopyObject metadata replacement also retains old headers. Multipart listings omit
`IsTruncated`, preventing the multipart checks and leaving cleanup unable to
confirm that every upload was discovered. Consequently the verifier retains the
affected test buckets for manual inspection and cleanup. Floci also accepts a
completion with an undersized non-final part. When the flag is normalized for
investigation, Floci also loses the initiation's Cache-Control on completion.
Its object listings order keys by UTF-16 code units instead of UTF-8 bytes, and
ListObjectsV2 continuation tokens embed the raw key, so a key containing a
control character yields XML that XML 1.0 forbids.
Those checks fail against it.

When UploadPart, AbortMultipartUpload or CompleteMultipartUpload address an
upload in a missing bucket, both the bucket and the upload are missing. S3 does
not document which error takes precedence, so the checks accept either
`NoSuchBucket` or `NoSuchUpload`, provided the status is 404. Floci returns
`NoSuchUpload`, which is therefore not treated as a defect. They are retained to verify S3's validation rules.
The CORS checks verify configuration APIs; they do not test HTTP preflight or
response headers.

## Implementing checks

Checks are grouped by operation in `checks/`. Each test has a name and a
`run({ client })` function, which may be asynchronous. Checks throw on failure,
for example using `node:assert/strict`. The runner
continues after failures, so each implemented test should manage its own setup,
use isolated resource names, and clean up resources in `finally` even if an
assertion fails. Add new sections to the suite list in `index.js`.

Run `pnpm test:unit` to test the runner, startup behavior (including target
selection and the endpoint guard), resource isolation and
cleanup (including lost responses, malformed listings, failed deletions and
retained buckets), and the operation checks offline using mock services. This does
not run the S3 operation checks against a real endpoint.
