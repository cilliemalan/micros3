# S3 verification plan

This todo list is regarding the verifier application 
in `verify`. It is a nodejs application using pnpm 
for package management.

## Summary

The verifier will check the basic S3 operations listed in
[lib/README.md](lib/README.md). First run the checks against the already-running
Floci instance to validate the verifier, using the endpoint, credentials, and
region supplied by `floci.env` (loaded with `-e` or `--env`). Then use the
same checks against MicroS3 as its operations are implemented. The program
checks the connection on startup, then runs the operation checks below. Bucket,
object listing, PutObject, GetObject, HeadObject, CopyObject, DeleteObject, DeleteObjects,
CreateMultipartUpload, UploadPart, ListParts, ListMultipartUploads, CompleteMultipartUpload, AbortMultipartUpload, CORS configuration, and encryption checks are implemented. The checked boxes below mean a check exists, not that every S3 behavior has been covered or that the check passes against Floci or AWS. See the follow-up work below.

## Verification review and follow-up

### Results and limitations

- The offline suite passed all 153 tests (`npm run test:unit`). The configured
  Floci run (`npm test -- -e floci.env`) reported 20 passes and 13 failures.
  A check stops at its first assertion failure, so this is not a count of all
  defects or proof that later scenarios passed. The six buckets retained by this
  run listed no uploads or objects and were manually removed afterward. Because
  Floci's listing is malformed, this cannot prove that it omitted no uploads;
  the verifier's conservative cleanup should not be weakened based on this run.
- Reproduced S3 incompatibilities in Floci:
  - An underscore-containing bucket name was accepted. [AWS bucket naming
    rules](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html)
    exclude underscores.
  - `CopyObject` with `REPLACE` retained the source's `Cache-Control` even
    though it was not supplied in the replacement. AWS requires explicitly
    providing the user-configurable metadata to retain when replacing it:
    [copying objects](https://docs.aws.amazon.com/AmazonS3/latest/userguide/copy-object.html).
  - `DeleteObjects` accepted 1,001 identifiers, above the documented
    [1,000-key maximum](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html).
  - `PutBucketCors` accepted an unsupported method, missing origins, missing
    methods, an empty configuration, and 101 rules. See
    [CORSRule](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CORSRule.html)
    and [PutBucketCors](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutBucketCors.html).
  - Raw `ListMultipartUploads` XML omitted `IsTruncated`, pagination markers,
    and `StorageClass`; for `MaxUploads=1` it returned both uploads in reverse
    key order. A truncated response must provide the truncation and continuation
    information and respect the limit; see [ListMultipartUploads](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListMultipartUploads.html).
    This also causes cleanup to retain buckets because it cannot prove the
    listing is complete. Omission on an untruncated response alone should not
    be used as evidence that uploads are gone.
  - Completing two one-byte parts succeeded and produced a two-byte object;
    [CompleteMultipartUpload](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html)
    specifies `EntityTooSmall` for an undersized non-final part.
  - When the missing truncation flag was normalized **only for a diagnostic
    run**, completed multipart content lost the initiation's `Cache-Control`.
    This establishes an end-to-end discrepancy, not which operation loses it.
- Floci returns `NoSuchUpload`/404 for UploadPart, AbortMultipartUpload and
  CompleteMultipartUpload when both the bucket and upload ID are missing. The
  checks previously demanded `NoSuchBucket`/404 and now accept either code. AWS documents `NoSuchUpload` for
  missing uploads, but the operation docs do not specify which error takes
  precedence when both are missing. Do not classify this as a confirmed Floci
  defect without an AWS comparison. No AWS credentials were supplied and no AWS
  reference run was performed for this review.

### Correctness and trustworthy results

- [x] Fix multipart completion error handling in
      [complete-multipart-upload.js](checks/complete-multipart-upload.js).
      S3 can embed an error in an HTTP 200 response. A local HTTP fixture using
      the installed AWS SDK and `maxAttempts: 1` returned an `EntityTooSmall`
      exception with SDK metadata status **503** for such a response; the check
      requires status 400 and would fail a valid response. Keep checking the
      error code and distinguish embedded errors from ordinary 503 responses;
      add real-SDK HTTP regression tests for both embedded and normal errors.
      See [CompleteMultipartUpload](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html).
- [x] Establish AWS's missing-bucket versus missing-upload error precedence for
      UploadPart, AbortMultipartUpload and CompleteMultipartUpload with an
      isolated AWS test, or accept documented 404 alternatives if the contract
      does not guarantee precedence. Update the mock tests as well as the
      verifier. Correct [README.md](README.md), which currently presents this
      error-code difference as a confirmed Floci defect.
      No AWS credentials were available, and the operation docs do not
      guarantee precedence, so the checks now accept `NoSuchBucket` or
      `NoSuchUpload` with HTTP 404 (`MISSING_BUCKET_UPLOAD_CODES` in
      [resources.js](../verify/checks/resources.js)). An AWS comparison can
      still narrow this later.
- [ ] Report or track the confirmed Floci discrepancies and rerun the complete
      verifier when they are fixed; do not relax valid S3 assertions merely to
      make Floci pass.
- [ ] Split long operation checks into independently reported scenarios, or
      report unexecuted scenarios and cleanup failures separately. In particular,
      the first CopyObject, DeleteObjects and multipart failures currently mask
      later validation, isolation and missing-resource checks. Keep setup and
      cleanup isolated and retain unsafe-to-delete buckets.
- [ ] Validate the assertions against a dedicated, disposable AWS S3 bucket or
      another independently validated reference implementation, with explicit
      permission, credentials and cleanup. Current offline fakes implement the
      same assumptions as the checks and bypass SDK serialization; passing them
      does not establish S3 compatibility. Record the endpoint/version and
      distinguish reference-service limitations from verifier defects.
- [x] Resolve the undocumented `ListParts` dependency: it is required by the
      UploadPart, CompleteMultipartUpload and AbortMultipartUpload checks but
      is not in [MicroS3's planned operations](lib/README.md). Either add it
      to the supported contract and verify it, including pagination, or design
      equivalent checks without requiring it. Report missing prerequisites
      separately from the operation being tested.
      ListParts is now in the [planned operations](../lib/README.md) and has
      its own check ([list-parts.js](../verify/checks/list-parts.js)). The
      other multipart checks call it through `listParts`/`assertPartsMissing`,
      which raise a `PrerequisiteError` when the request itself fails; the
      runner reports those checks as `BLOCKED` and they still fail the run.
      Against Floci the ListParts scenarios passed; the check failed only in
      cleanup because of the known `ListMultipartUploads` defect, and the
      retained buckets were removed manually.

### Coverage gaps

- [ ] Test actual CORS behavior, not just configuration storage: matching and
      nonmatching origins, methods and headers; first-match rule order and
      wildcards; preflight OPTIONS and actual response headers; and changes
      after replacement/deletion. See [PutBucketCors](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutBucketCors.html).
- [ ] Check independently calculated ETags for small single-part SSE-S3/plain
      uploads and copies, and exercise checksum validation including mismatched
      checksums where supported. Current checks mostly compare a service's ETag
      with itself, so a consistently wrong value can pass: the offline PutObject
      fake uses the body bytes as hex instead of an MD5 and still passes. Do not
      assume a multipart, SSE-KMS or SSE-C ETag is MD5; see
      [Object ETag](https://docs.aws.amazon.com/AmazonS3/latest/API/API_Object.html).
- [ ] Extend listing coverage to `EncodingType=url` for both object-listing
      APIs, XML-sensitive/control-character and multibyte keys, and encoded
      continuation/marker behavior. Verify raw HTTP/XML as well as SDK-decoded
      values where necessary.
- [ ] Cover date-based conditional GET/HEAD/copy requests and their interaction
      with ETag conditions, and test the actual HEAD response on the wire;
      the SDK does not expose an improperly sent HEAD body. Define which
      optional headers and behaviors MicroS3 intends to support first.
- [ ] Add SDK-to-HTTP integration fixtures for signed requests, XML errors and
      serialization, including the 200-with-error response. Clarify separately
      whether authentication, permissions and other optional S3 features are in
      scope; the current tests do not establish them.

### Operational safety

- [x] Require an explicit endpoint or an explicit opt-in before using the AWS
      default endpoint, and show the selected target before creating resources.
      The current default credential chain can otherwise create real buckets
      and incur charges. Add tests for the guard and environment precedence.
      [target.js](../verify/target.js) resolves `--endpoint`, then
      `AWS_ENDPOINT_URL_S3`, then `AWS_ENDPOINT_URL`; otherwise `--aws` is
      required (and ignores shared-config `endpoint_url`). The target is printed
      before the connection check.
- [x] Add bounded request and run timeouts with cleanup-aware cancellation and
      tests for hung requests. Preserve resource identifiers and the current
      conservative multipart cleanup behavior when completion is uncertain.
      [timeouts.js](../verify/timeouts.js) bounds every request (including SDK
      retries and body reads; `--request-timeout`, default 30 s) and the run
      (`--run-timeout`, default 30 min). At the run deadline, check requests
      are cancelled and unstarted checks reported `NOT RUN`; cleanup inside
      `withCleanup` continues for `--cleanup-grace` (default 2 min), after
      which a check is abandoned and reported. Timeout errors carry no HTTP
      status, so uncertain creations are still cleaned up and buckets whose
      uploads cannot be listed are retained. Real-SDK hung-server tests are in
      [timeouts.test.js](../verify/test/timeouts.test.js).

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
- [x] **ListParts**: verify empty uploads, part order, ETags and sizes after
      replacement, `MaxParts`/`PartNumberMarker` pagination, isolation, and
      missing, aborted or completed uploads and buckets.
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
