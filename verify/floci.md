Target: http://localhost:4566 (from AWS_ENDPOINT_URL), region us-east-1
Timeouts: 30 s per request, 1800 s per run, 120 s cleanup grace

Bucket operations:
  PASS CreateBucket
  FAIL CreateBucket rejects an invalid bucket name: CreateBucket should reject an invalid bucket name
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
  FAIL CopyObject: copy with replaced metadata CacheControl
[32m+ actual[39m [31m- expected[39m

[32m+[39m 'max-age=123'
[31m- [39mundefined

  PASS DeleteObject
  FAIL DeleteObjects: Missing expected rejection: DeleteObjects over limit should reject
  PASS Object ETags are MD5 digests
  PASS PutObject validates Content-MD5
  PASS PutObject validates checksums
  PASS GetObject and HeadObject date conditions
  PASS CopyObject date conditions
  PASS HEAD and 304 responses have no body on the wire

Listing operations:
  PASS ListObjects
  PASS ListObjectsV2
  FAIL ListObjects URL encoding and special keys: ListObjects {"EncodingType":"url"} object keys
[32m+ actual[39m [31m- expected[39m
... Skipped lines

[39m  [
[39m    'ctl/cr\rhere.txt',
[39m    'ctl/del\x7Fhere.txt',
[39m    'ctl/nl\nhere.txt',
[39m    'ctl/soh\x01here.txt',
[34m...[39m
[39m    'enc/日本語/ü.txt',
[32m+[39m   'enc/😀.txt',
[39m    'enc/Ａ.txt',
[31m-[39m   'enc/😀.txt'
[39m  ]

  FAIL ListObjectsV2 URL encoding and special keys: ListObjectsV2 {"EncodingType":"url"} object keys
[32m+ actual[39m [31m- expected[39m
... Skipped lines

[39m  [
[39m    'ctl/cr\rhere.txt',
[39m    'ctl/del\x7Fhere.txt',
[39m    'ctl/nl\nhere.txt',
[39m    'ctl/soh\x01here.txt',
[34m...[39m
[39m    'enc/日本語/ü.txt',
[32m+[39m   'enc/😀.txt',
[39m    'enc/Ａ.txt',
[31m-[39m   'enc/😀.txt'
[39m  ]


Multipart operations:
  FAIL CreateMultipartUpload: all setup uploads fit in one page
[32m+ actual[39m [31m- expected[39m

[32m+[39m undefined
[31m- [39mfalse
; cleanup failed for uploads and objects in bucket micros3-verify-626c775c-8d06-40da-bd0f-8c4db7208db4: listing uploads: cleanup upload listing IsTruncated
[32mactual[39m [31mexpected[39m

[39m'[39m[32mu[39m[32mn[39m[32md[39m[31mb[39m[31mo[39m[31mo[39m[31ml[39m[39me[39m[32mf[39m[32mi[39m[31ma[39m[39mn[39m[32me[39m[32md[39m[39m'[39m
; cleanup failed for bucket micros3-verify-626c775c-8d06-40da-bd0f-8c4db7208db4: bucket micros3-verify-626c775c-8d06-40da-bd0f-8c4db7208db4 retained because multipart uploads may remain; inspect and remove manually
  FAIL UploadPart: Cleanup failed for uploads and objects in bucket micros3-verify-b24d85d2-f6b4-4df1-8106-c6753d82253e: listing uploads: cleanup upload listing IsTruncated
[32mactual[39m [31mexpected[39m

[39m'[39m[32mu[39m[32mn[39m[32md[39m[31mb[39m[31mo[39m[31mo[39m[31ml[39m[39me[39m[32mf[39m[32mi[39m[31ma[39m[39mn[39m[32me[39m[32md[39m[39m'[39m
; cleanup failed for bucket micros3-verify-b24d85d2-f6b4-4df1-8106-c6753d82253e: bucket micros3-verify-b24d85d2-f6b4-4df1-8106-c6753d82253e retained because multipart uploads may remain; inspect and remove manually; cleanup failed for uploads and objects in bucket micros3-verify-1051590e-cf1e-461f-a614-5d055b32a4c8: listing uploads: cleanup upload listing IsTruncated
[32mactual[39m [31mexpected[39m

[39m'[39m[32mu[39m[32mn[39m[32md[39m[31mb[39m[31mo[39m[31mo[39m[31ml[39m[39me[39m[32mf[39m[32mi[39m[31ma[39m[39mn[39m[32me[39m[32md[39m[39m'[39m
; cleanup failed for bucket micros3-verify-1051590e-cf1e-461f-a614-5d055b32a4c8: bucket micros3-verify-1051590e-cf1e-461f-a614-5d055b32a4c8 retained because multipart uploads may remain; inspect and remove manually
  FAIL ListParts: Cleanup failed for uploads and objects in bucket micros3-verify-6b76795c-d379-4aa2-a85c-e4fc1b3be1f9: listing uploads: cleanup upload listing IsTruncated
[32mactual[39m [31mexpected[39m

[39m'[39m[32mu[39m[32mn[39m[32md[39m[31mb[39m[31mo[39m[31mo[39m[31ml[39m[39me[39m[32mf[39m[32mi[39m[31ma[39m[39mn[39m[32me[39m[32md[39m[39m'[39m
; cleanup failed for bucket micros3-verify-6b76795c-d379-4aa2-a85c-e4fc1b3be1f9: bucket micros3-verify-6b76795c-d379-4aa2-a85c-e4fc1b3be1f9 retained because multipart uploads may remain; inspect and remove manually; cleanup failed for uploads and objects in bucket micros3-verify-e20aaddd-ccb3-40a2-a3a9-27c2b8943496: listing uploads: cleanup upload listing IsTruncated
[32mactual[39m [31mexpected[39m

[39m'[39m[32mu[39m[32mn[39m[32md[39m[31mb[39m[31mo[39m[31mo[39m[31ml[39m[39me[39m[32mf[39m[32mi[39m[31ma[39m[39mn[39m[32me[39m[32md[39m[39m'[39m
; cleanup failed for bucket micros3-verify-e20aaddd-ccb3-40a2-a3a9-27c2b8943496: bucket micros3-verify-e20aaddd-ccb3-40a2-a3a9-27c2b8943496 retained because multipart uploads may remain; inspect and remove manually
  FAIL ListMultipartUploads: listing IsTruncated
[32mactual[39m [31mexpected[39m

[39m'[39m[32mu[39m[32mn[39m[32md[39m[31mb[39m[31mo[39m[31mo[39m[31ml[39m[39me[39m[32mf[39m[32mi[39m[31ma[39m[39mn[39m[32me[39m[32md[39m[39m'[39m
; cleanup failed for uploads and objects in bucket micros3-verify-841d6a4e-2b53-4467-8a0d-b59ad654f1f9: listing uploads: cleanup upload listing IsTruncated
[32mactual[39m [31mexpected[39m

[39m'[39m[32mu[39m[32mn[39m[32md[39m[31mb[39m[31mo[39m[31mo[39m[31ml[39m[39me[39m[32mf[39m[32mi[39m[31ma[39m[39mn[39m[32me[39m[32md[39m[39m'[39m
; cleanup failed for bucket micros3-verify-841d6a4e-2b53-4467-8a0d-b59ad654f1f9: bucket micros3-verify-841d6a4e-2b53-4467-8a0d-b59ad654f1f9 retained because multipart uploads may remain; inspect and remove manually
  FAIL CompleteMultipartUpload: Missing expected rejection: CompleteMultipartUpload undersized part should reject with EntityTooSmall; cleanup failed for uploads and objects in bucket micros3-verify-babef558-0572-4dcc-9360-9a91e67fcbcb: listing uploads: cleanup upload listing IsTruncated
[32mactual[39m [31mexpected[39m

[39m'[39m[32mu[39m[32mn[39m[32md[39m[31mb[39m[31mo[39m[31mo[39m[31ml[39m[39me[39m[32mf[39m[32mi[39m[31ma[39m[39mn[39m[32me[39m[32md[39m[39m'[39m
; cleanup failed for bucket micros3-verify-babef558-0572-4dcc-9360-9a91e67fcbcb: bucket micros3-verify-babef558-0572-4dcc-9360-9a91e67fcbcb retained because multipart uploads may remain; inspect and remove manually
  FAIL AbortMultipartUpload: uploads fit in one page
[32m+ actual[39m [31m- expected[39m

[32m+[39m undefined
[31m- [39mfalse
; cleanup failed for uploads and objects in bucket micros3-verify-e6d22f7c-3f75-4eee-a64e-4e9a03f8ec40: listing uploads: cleanup upload listing IsTruncated
[32mactual[39m [31mexpected[39m

[39m'[39m[32mu[39m[32mn[39m[32md[39m[31mb[39m[31mo[39m[31mo[39m[31ml[39m[39me[39m[32mf[39m[32mi[39m[31ma[39m[39mn[39m[32me[39m[32md[39m[39m'[39m
; cleanup failed for bucket micros3-verify-e6d22f7c-3f75-4eee-a64e-4e9a03f8ec40: bucket micros3-verify-e6d22f7c-3f75-4eee-a64e-4e9a03f8ec40 retained because multipart uploads may remain; inspect and remove manually

CORS operations:
  PASS PutBucketCors
  PASS CORS configurations are isolated between buckets
  PASS PutBucketCors accepts 100 rules
  FAIL PutBucketCors rejects unsupported methods: Missing expected rejection: PutBucketCors should reject unsupported methods
  FAIL PutBucketCors rejects a rule without origins: Missing expected rejection: PutBucketCors should reject a rule without origins
  FAIL PutBucketCors rejects a rule without methods: Missing expected rejection: PutBucketCors should reject a rule without methods
  FAIL PutBucketCors rejects an empty configuration: Missing expected rejection: PutBucketCors should reject an empty configuration
  FAIL PutBucketCors rejects more than 100 rules: Missing expected rejection: PutBucketCors should reject more than 100 rules
  PASS GetBucketCors
  PASS DeleteBucketCors
  PASS CORS headers on actual requests

Encryption:
  PASS GetBucketEncryption
  PASS GetBucketEncryption rejects a missing bucket

Results: 27 passed, 16 failed
