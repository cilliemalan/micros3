$ node index.js --aws
Target: default AWS S3 endpoint (opted in with --aws; real resources may incur charges), region af-south-1
Timeouts: 30 s per request, 1800 s per run, 120 s cleanup grace

Bucket operations:
  PASS CreateBucket
  PASS CreateBucket rejects an invalid bucket name
  PASS CreateBucket preserves an existing bucket on repeat creation
  PASS ListBuckets
  PASS HeadBucket
  PASS GetBucketLocation
  PASS DeleteBucket
  PASS DeleteBucket rejects a non-empty bucket

Object operations:
  PASS PutObject
  PASS GetObject
  PASS HeadObject
  PASS CopyObject
  PASS DeleteObject
  PASS DeleteObjects
  PASS Object ETags are MD5 digests
  PASS PutObject validates Content-MD5
  PASS PutObject validates checksums
  PASS GetObject and HeadObject date conditions
  PASS CopyObject date conditions
  PASS HEAD and 304 responses have no body on the wire

Listing operations:
  PASS ListObjects
  PASS ListObjectsV2
  PASS ListObjects URL encoding and special keys
  PASS ListObjectsV2 URL encoding and special keys

Multipart operations:
  PASS CreateMultipartUpload
  PASS UploadPart
  PASS ListParts
  FAIL ListMultipartUploads: grouped next key marker
  FAIL CompleteMultipartUpload: Missing expected rejection: CompleteMultipartUpload completed upload should reject with NoSuchUpload
  FAIL AbortMultipartUpload: Missing expected rejection: repeat AbortMultipartUpload should reject a missing bucket

CORS operations:
  PASS PutBucketCors
  PASS CORS configurations are isolated between buckets
  PASS PutBucketCors accepts 100 rules
  PASS PutBucketCors rejects unsupported methods
  PASS PutBucketCors rejects a rule without origins
  PASS PutBucketCors rejects a rule without methods
  PASS PutBucketCors rejects an empty configuration
  PASS PutBucketCors rejects more than 100 rules
  PASS GetBucketCors
  PASS DeleteBucketCors
  FAIL CORS preflight matches origins, methods and headers: client.config.endpoint is not a function
  FAIL CORS preflight uses the first matching rule: client.config.endpoint is not a function
  PASS CORS headers on actual requests
  FAIL CORS behavior follows configuration changes: client.config.endpoint is not a function

Encryption:
  PASS GetBucketEncryption
  PASS GetBucketEncryption rejects a missing bucket

Results: 40 passed, 6 failed

