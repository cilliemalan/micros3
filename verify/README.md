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
prefixes). PutObject checks binary and empty uploads, metadata and headers,
overwrites, key isolation, and missing buckets. GetObject checks binary and empty
content, metadata and headers, overwrites, ranges, ETag conditions, and missing
keys and buckets. HeadObject checks binary and empty objects, metadata and headers,
overwrites, ranges, ETag conditions, and missing keys and buckets. The SDK
exposes no response body for HEAD; the check does not inspect the wire for an
improperly sent body. CopyObject checks cross-bucket and self-copies, binary and
empty objects, URL-encoded keys, metadata and headers, metadata replacement,
overwrites, conditional copies, isolation, and missing keys and buckets.
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
ListMultipartUploads checks empty and missing buckets, upload identities, initiation
timestamps and storage class, key ordering, prefix and delimiter filtering, URL
encoding, marker pagination across same-key uploads and common prefixes, bucket
isolation, and removal after abort and completion. Owner and initiator identity,
permissions, versioning, and directory buckets are not exercised.
CompleteMultipartUpload checks selected parts and assembly, empty objects, response
and metadata, overwriting an object, independent uploads across keys and buckets,
invalid part order, ETags, missing parts and undersized non-final parts, recovery
after rejection, and missing, aborted or completed uploads and buckets. Checksums,
conditional completion and versioning are not exercised. AbortMultipartUpload checks removal of uploads
and parts, repeat and invalid aborts, preservation of existing objects and other
uploads across keys and buckets, completion of a surviving upload, empty uploads,
and a missing bucket.
These checks require ListMultipartUploads, ListParts, UploadPart,
CompleteMultipartUpload and AbortMultipartUpload support. CORS configuration checks cover multiple ordered rules and their
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

`pnpm start` is an alias for the verifier and accepts the same options. Without
a custom endpoint, the AWS SDK uses its default AWS S3 endpoint and credentials,
so ensure the intended endpoint and credentials are configured before running.
The bucket, PutObject, GetObject, HeadObject, CopyObject, DeleteObject, DeleteObjects,
listing, multipart creation, part upload, upload listing, completion and abort, CORS and encryption checks create uniquely named buckets and temporary
objects, uploads or CORS configurations. They attempt cleanup even after failures;
cleanup errors identify the affected resources, which may need manual removal.
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
lost or retried creation responses; listing failures may require manual cleanup.

The configured Floci instance currently accepts invalid bucket names, invalid
CORS configurations and DeleteObjects requests with more than 1,000 keys; its
CopyObject metadata replacement also retains old headers. Multipart listings omit
`IsTruncated`, preventing the multipart creation, part upload, upload listing, completion and abort checks and leaving cleanup unable
to confirm that every upload was discovered. Floci also accepts a completion with an undersized non-final part. When the flag is normalized for
investigation, Floci also loses the initiation's Cache-Control on completion and
returns NoSuchUpload instead of NoSuchBucket when aborting or uploading a part in a missing bucket.
Those checks fail against it. They are retained to verify S3's validation rules.
The CORS checks verify configuration APIs; they do not test HTTP preflight or
response headers.

## Implementing checks

Checks are grouped by operation in `checks/`. Each test has a name and a
`run({ client })` function, which may be asynchronous. Checks throw on failure,
for example using `node:assert/strict`. The runner
continues after failures, so each implemented test should manage its own setup,
use isolated resource names, and clean up resources in `finally` even if an
assertion fails. Add new sections to the suite list in `index.js`.

Run `pnpm test:unit` to test the runner, startup behavior, bucket, PutObject,
GetObject, HeadObject, CopyObject, DeleteObject, DeleteObjects, listing, multipart creation, part upload, upload listing, completion and abort, CORS and encryption
checks offline using mock services. This does not run the S3
operation checks against a real endpoint.
