This library is (will be) the backend for micros3: an S3 emulator.

It is meant to implement these operations with basic support:

## Operations

- Bucket:
  - [ ] ListBuckets
  - [ ] CreateBucket
  - [ ] HeadBucket
  - [ ] DeleteBucket
  - [ ] GetBucketLocation
- Objects:
  - [ ] PutObject
  - [ ] GetObject
  - [ ] HeadObject
  - [ ] DeleteObject
  - [ ] DeleteObjects
  - [ ] CopyObject
- Listing:
  - [ ] ListObjects
  - [ ] ListObjectsV2
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
  - [ ] GetBucketEncryption

### Supported features
bucket creation, listing and deletion; object upload, download, copy and deletion; object listing; multipart uploads; bucket CORS; MD5 ETags for single-part objects; `Content-MD5` and CRC32/SHA-256 checksum validation on upload.

### Unsupported features
bucket and object tagging, ACLs, bucket policies, versioning, replication, object locking, website configuration, and changing bucket encryption configuration. S3 Table, S3 Select, S3 Vector are not supported.


