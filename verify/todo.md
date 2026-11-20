# S3 verification plan

The verifier will check the basic S3 operations listed in
[lib/README.md](../lib/README.md). First run the checks against the already-running
Floci instance to validate the verifier, using the endpoint, credentials, and
region supplied by `../floci.env` (loaded with `-e` or `--env`). Then use the
same checks against MicroS3 as its operations are implemented. The program
currently lists buckets on startup to check the connection; the operation checks
below are still planned.

## Setup and cleanup

- [x] Configure the S3 client from the supplied environment variables and connect
      to the configured S3-compatible endpoint.
- [ ] Use isolated bucket and object names, report individual failures, and clean
      up created objects, uploads, CORS configuration, and buckets even on failure.

## Bucket operations

- [ ] **CreateBucket**: create a bucket and check the response.
- [ ] **ListBuckets**: confirm the created bucket appears in the list.
- [ ] **HeadBucket**: confirm the created bucket exists; check a missing bucket.
- [ ] **GetBucketLocation**: check the created bucket's location.
- [ ] **DeleteBucket**: delete an empty bucket and confirm it is gone.

## Object operations

- [ ] **PutObject**: upload an object with known content and metadata.
- [ ] **GetObject**: download it and compare its content and metadata.
- [ ] **HeadObject**: check its metadata without downloading its body; check a
      missing object.
- [ ] **CopyObject**: copy an object and verify the copy's content and metadata.
- [ ] **DeleteObject**: delete an object and confirm it is gone.
- [ ] **DeleteObjects**: delete multiple objects and verify the results.

## Listing operations

- [ ] **ListObjects**: verify object keys, prefix filtering, and pagination.
- [ ] **ListObjectsV2**: verify object keys, prefix filtering, and pagination.

## Multipart operations

- [ ] **CreateMultipartUpload**: initiate an upload and capture its upload ID.
- [ ] **UploadPart**: upload parts and capture their ETags.
- [ ] **ListMultipartUploads**: confirm an in-progress upload is listed.
- [ ] **CompleteMultipartUpload**: complete an upload and verify the assembled
      object's content.
- [ ] **AbortMultipartUpload**: abort an in-progress upload and confirm it is no
      longer listed.

## CORS and encryption

- [ ] **PutBucketCors**: set a bucket's CORS configuration.
- [ ] **GetBucketCors**: retrieve and compare the configuration.
- [ ] **DeleteBucketCors**: delete the configuration and confirm it is removed.
- [ ] **GetBucketEncryption**: check the response for bucket encryption configuration.

Bucket and object tagging, ACLs, bucket policies, versioning, replication,
object locking, website configuration, changes to bucket encryption, S3 Table,
S3 Select, and S3 Vector are outside MicroS3's planned scope.
