This library is (will be) the backend for micros3: an S3 emulator.

It is meant to implement these operations with basic support:

## Operations

- Bucket:
  - [x] ListBuckets
  - [x] CreateBucket
  - [x] HeadBucket
  - [x] DeleteBucket
  - [x] GetBucketLocation
- Objects:
  - [x] PutObject
  - [x] GetObject
  - [x] HeadObject
  - [x] DeleteObject
  - [x] DeleteObjects
  - [x] CopyObject
- Listing:
  - [x] ListObjects
  - [x] ListObjectsV2
- Multipart:
  - [x] CreateMultipartUpload
  - [x] UploadPart
  - [x] CompleteMultipartUpload
  - [x] AbortMultipartUpload
  - [x] ListMultipartUploads
  - [x] ListParts
- CORS:
  - [x] PutBucketCors
  - [x] GetBucketCors
  - [x] DeleteBucketCors
- Encryption:
  - [x] GetBucketEncryption

### Supported features
bucket creation, listing and deletion; object upload, download, copy and deletion; object listing; multipart uploads; bucket CORS; MD5 ETags for single-part objects; `Content-MD5` and CRC32/SHA-256 checksum validation on upload.

### Conditional requests
GetObject and HeadObject support `If-Match`, `If-None-Match`, `If-Modified-Since`
and `If-Unmodified-Since`; CopyObject supports the corresponding
`x-amz-copy-source-if-*` headers. Conditions are evaluated in the order of
[RFC 9110 section 13.2.2](https://www.rfc-editor.org/rfc/rfc9110#section-13.2.2),
as S3 documents: a date condition is ignored when the corresponding ETag
condition is present. Dates are compared with the one-second `Last-Modified`
value. A failed read condition returns 304 (`If-None-Match`/`If-Modified-Since`)
or 412 (`If-Match`/`If-Unmodified-Since`); a failed copy condition returns 412
`PreconditionFailed`. HEAD and 304 responses carry no body. Handling of future
or unparseable dates, and conditional writes (`If-None-Match` on PutObject or
CompleteMultipartUpload), are not defined.

### CORS
A bucket's CORS rules are evaluated in order, and the first rule that matches
is used. A preflight `OPTIONS` request on a bucket or object path needs no
signature. It matches a rule when its `Origin`, its
`Access-Control-Request-Method` and every header in its
`Access-Control-Request-Headers` are allowed. A matched preflight returns 200 with
`Access-Control-Allow-Origin`, `-Allow-Methods`, `-Allow-Headers` (the requested
headers), `-Expose-Headers` and `-Max-Age`. A rejected one returns 403
`AccessForbidden` with no CORS headers. A missing `Origin` or an invalid requested
method returns 400 `BadRequest`. Signed requests with an `Origin` get the same
headers, except `-Allow-Headers`, from the first rule that allows the origin and
method. CORS does not authorize requests, so an unmatched request still succeeds
without CORS headers. An origin or header pattern may hold one `*`, which matches
any run of characters. Header names are compared case-insensitively. The
response echoes the origin, with `Access-Control-Allow-Credentials: true`,
unless the matching pattern is `*`. Responses on a bucket with a CORS
configuration carry `Vary: Origin`.

### Unsupported features
bucket and object tagging, ACLs, bucket policies, versioning, replication, object locking, website configuration, and changing bucket encryption configuration. S3 Table, S3 Select, S3 Vector are not supported.


