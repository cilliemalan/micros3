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
  - [ ] DeleteObjects
  - [ ] CopyObject
- Listing:
  - [x] ListObjects
  - [x] ListObjectsV2
- Multipart:
  - [ ] CreateMultipartUpload
  - [ ] UploadPart
  - [ ] CompleteMultipartUpload
  - [ ] AbortMultipartUpload
  - [ ] ListMultipartUploads
  - [ ] ListParts
- CORS:
  - [ ] PutBucketCors
  - [ ] GetBucketCors
  - [ ] DeleteBucketCors
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

### Unsupported features
bucket and object tagging, ACLs, bucket policies, versioning, replication, object locking, website configuration, and changing bucket encryption configuration. S3 Table, S3 Select, S3 Vector are not supported.


