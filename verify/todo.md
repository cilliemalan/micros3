# S3 verification plan

The verifier will check the basic S3 operations listed in
[lib/README.md](../lib/README.md). First run the checks against the already-running
Floci instance to validate the verifier, using the endpoint, credentials, and
region supplied by `../floci.env` (loaded with `-e` or `--env`). Then use the
same checks against MicroS3 as its operations are implemented. The program
checks the connection on startup, then runs the operation checks below. Bucket,
object listing, PutObject, GetObject, HeadObject, CopyObject, DeleteObject, DeleteObjects,
CreateMultipartUpload, UploadPart, ListMultipartUploads, CompleteMultipartUpload, AbortMultipartUpload, CORS configuration, and encryption checks are implemented.

## Setup and cleanup

- [x] Configure the S3 client from the supplied environment variables and connect
      to the configured S3-compatible endpoint.
- [x] Use isolated bucket and object names, report individual failures, and attempt
      cleanup even on failure. Retain a bucket for manual cleanup if multipart
      uploads may remain or their removal cannot be verified.

## Bucket operations

- [x] **CreateBucket**: create a bucket and check the response, reject an invalid
      name, and verify repeat creation preserves existing content.
- [x] **ListBuckets**: confirm two created buckets appear in the list, following
      continuation tokens when necessary.
- [x] **HeadBucket**: confirm the created bucket exists; check a missing bucket.
- [x] **GetBucketLocation**: check the created bucket's location and a missing bucket.
- [x] **DeleteBucket**: delete an empty bucket and confirm it is gone; reject
      deletion of a non-empty bucket and preserve its object.

## Object operations

- [x] **PutObject**: verify binary and empty uploads, metadata and headers,
      overwrites, exact-key isolation, and a missing bucket.
- [x] **GetObject**: compare content, metadata and headers; verify empty objects,
      overwrites, ranges, ETag conditions, and missing keys and buckets.
- [x] **HeadObject**: check metadata, empty objects, overwrites, ranges and ETag
      conditions; check missing objects and buckets.
- [x] **CopyObject**: verify cross-bucket and self-copies, binary and empty content,
      metadata copying and replacement, overwrites, conditions, isolation and missing resources.
- [x] **DeleteObject**: verify deletion, idempotence, exact-key isolation, empty
      objects, recreation after deletion, and missing buckets.
- [x] **DeleteObjects**: verify verbose and quiet results, missing and repeated
      deletions, exact-key and bucket isolation, the 1,000-key limit, and a missing bucket.

## Listing operations

- [x] **ListObjects**: verify object keys, prefix filtering, and pagination.
- [x] **ListObjectsV2**: verify object keys, prefix filtering, and pagination.

## Multipart operations

- [x] **CreateMultipartUpload**: verify response and unique IDs, concurrent uploads,
      non-destructive initiation, metadata on completion, and missing buckets.
- [x] **UploadPart**: verify binary and empty parts, out-of-order uploads,
      replacement, part number bounds, ETags, isolation, assembled content,
      and missing, completed, or aborted uploads and buckets.
- [x] **ListMultipartUploads**: verify empty and missing buckets, upload identities and metadata,
      key order, prefixes, delimiters, URL encoding, marker pagination including same-key
      uploads and rolled-up prefixes, bucket isolation, and completed and aborted uploads.
- [x] **CompleteMultipartUpload**: verify selected parts, assembly, empty objects,
      response and metadata, overwrite and upload isolation, invalid manifests,
      recovery, and missing resources.
- [x] **AbortMultipartUpload**: verify removal of uploads and parts, repeated and
      invalid aborts, object and upload isolation, empty uploads, and a missing bucket.

## CORS and encryption

- [x] **PutBucketCors**: set and replace a bucket's CORS configuration; verify
      rule limits, invalid configurations, missing buckets, and bucket isolation.
- [x] **GetBucketCors**: retrieve and compare all rule fields; check a bucket
      without a configuration and a missing bucket.
- [x] **DeleteBucketCors**: delete the configuration, confirm it is removed,
      check repeat deletion and a missing bucket, and recreate it.
- [x] **GetBucketEncryption**: verify a new bucket's default SSE-S3 encryption
      configuration and check a missing bucket.

Bucket and object tagging, ACLs, bucket policies, versioning, replication,
object locking, website configuration, changes to bucket encryption, S3 Table,
S3 Select, and S3 Vector are outside MicroS3's planned scope.
