import assert from 'node:assert/strict';
import { CopyObjectCommand, DeleteBucketCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { assertMissing, assertStatus, ignoreMissing, message, status, withBucket, withCleanup } from './resources.js';

// CopySource is a URL-encoded path, not an ordinary object key.
const copySource = (bucket, key) => `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

async function cleanObjects(client, bucket, keys) {
  const failures = [];
  for (const Key of keys) {
    try {
      await ignoreMissing(() => client.send(new DeleteObjectCommand({ Bucket: bucket, Key })), ['NoSuchBucket', 'NoSuchKey']);
    } catch (error) {
      failures.push(new Error(`${bucket}/${Key}: ${message(error)}`, { cause: error }));
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map(message).join('; '));
}

export async function verifyCopyObject(client) {
  await withBucket(client, async ({ Bucket: sourceBucket }) => {
    await withBucket(client, async ({ Bucket: destinationBucket }) => {
      const source = 'nested/雪 +&%?#.bin';
      const empty = 'empty';
      const dest = 'copy/雪 +&%?#.bin';
      const neighbor = `${dest}/child`;
      const emptyCopy = 'empty-copy';
      const absent = 'absent';
      const sourceKeys = [source, empty, absent];
      const destinationKeys = [dest, neighbor, emptyCopy];
      await withCleanup(async () => {
        await withCleanup(async () => {
          const body = Buffer.from([0, 1, 127, 128, 254, 255]);
          const fields = { ContentType: 'application/octet-stream', CacheControl: 'max-age=123',
            ContentDisposition: 'attachment; filename="sample.bin"', Metadata: { purpose: 'copy-check', revision: 'one' } };
          const replacement = { ContentType: 'text/plain', Metadata: { revision: 'two' } };
          const put = async (Bucket, Key, Body, extra = {}) => {
            const response = await client.send(new PutObjectCommand({ Bucket, Key, Body, ...extra }));
            assertStatus(response, 200, 'PutObject setup');
            assert.ok(response.ETag, 'PutObject setup ETag');
            return response.ETag;
          };
          const get = async (Bucket, Key, expectedBody, expectedFields, label, expectedTag) => {
            const response = await client.send(new GetObjectCommand({ Bucket, Key }));
            assertStatus(response, 200, label);
            assert.deepEqual(Buffer.from(await response.Body.transformToByteArray()), expectedBody, `${label} content`);
            assert.equal(response.ContentLength, expectedBody.length, `${label} ContentLength`);
            assert.equal(response.ContentType, expectedFields.ContentType, `${label} ContentType`);
            assert.equal(response.CacheControl, expectedFields.CacheControl, `${label} CacheControl`);
            assert.equal(response.ContentDisposition, expectedFields.ContentDisposition, `${label} ContentDisposition`);
            assert.deepEqual(response.Metadata ?? {}, expectedFields.Metadata ?? {}, `${label} metadata`);
            assert.ok(response.ETag, `${label} ETag`);
            if (expectedTag) assert.equal(response.ETag, expectedTag, `${label} ETag`);
          };
          const copy = async (Bucket, Key, sourceKey, extra = {}, from = sourceBucket) => {
            const result = await client.send(new CopyObjectCommand({ Bucket, Key, CopySource: copySource(from, sourceKey), ...extra }));
            assertStatus(result, 200, 'CopyObject');
            assert.ok(result.CopyObjectResult?.ETag, 'CopyObject result ETag');
            assert.ok(result.CopyObjectResult.LastModified instanceof Date && !Number.isNaN(result.CopyObjectResult.LastModified.getTime()), 'CopyObject result LastModified');
            return result.CopyObjectResult.ETag;
          };
          const tag = await put(sourceBucket, source, body, fields);
          const emptyTag = await put(sourceBucket, empty, Buffer.alloc(0), { ContentType: 'text/plain' });
          const neighborBody = Buffer.from('neighbor');
          const neighborTag = await put(destinationBucket, neighbor, neighborBody, { ContentType: 'text/plain' });
          await put(destinationBucket, dest, Buffer.from('old destination'), { ContentType: 'text/plain', Metadata: { stale: 'yes' } });

          const copiedTag = await copy(destinationBucket, dest, source);
          await get(destinationBucket, dest, body, fields, 'cross-bucket copy', copiedTag);
          await get(sourceBucket, source, body, fields, 'source after copy', tag);
          await get(destinationBucket, neighbor, neighborBody, { ContentType: 'text/plain' }, 'neighbor after copy', neighborTag);
          const emptyCopiedTag = await copy(destinationBucket, emptyCopy, empty);
          await get(destinationBucket, emptyCopy, Buffer.alloc(0), { ContentType: 'text/plain' }, 'empty copy', emptyCopiedTag);
          await get(sourceBucket, empty, Buffer.alloc(0), { ContentType: 'text/plain' }, 'empty source', emptyTag);

          const replacedTag = await copy(destinationBucket, dest, source, { MetadataDirective: 'REPLACE', ...replacement });
          await get(destinationBucket, dest, body, replacement, 'copy with replaced metadata', replacedTag);
          await get(sourceBucket, source, body, fields, 'source after replacement', tag);
          // A self-copy with REPLACE must update metadata without changing content.
          const selfTag = await copy(destinationBucket, dest, dest, { MetadataDirective: 'REPLACE', ...fields }, destinationBucket);
          await get(destinationBucket, dest, body, fields, 'self-copy', selfTag);

          const conditionalTag = await copy(destinationBucket, dest, source, { CopySourceIfMatch: tag });
          await get(destinationBucket, dest, body, fields, 'matching conditional copy', conditionalTag);
          const noneTag = await copy(destinationBucket, dest, source, { CopySourceIfNoneMatch: '"not-the-etag"' });
          await get(destinationBucket, dest, body, fields, 'nonmatching conditional copy', noneTag);
          // Make a failed copy observable even if the service writes the source before rejecting it.
          const sentinelTag = await copy(destinationBucket, dest, source, { MetadataDirective: 'REPLACE', ...replacement });
          await get(destinationBucket, dest, body, replacement, 'destination before rejected copies', sentinelTag);
          for (const [condition, label] of [
            [{ CopySourceIfMatch: '"not-the-etag"' }, 'nonmatching IfMatch'],
            [{ CopySourceIfNoneMatch: tag }, 'matching IfNoneMatch'],
          ]) {
            await assert.rejects(() => client.send(new CopyObjectCommand({ Bucket: destinationBucket, Key: dest,
              CopySource: copySource(sourceBucket, source), ...condition })), error => {
              assert.equal(status(error), 412, `CopyObject ${label} HTTP status`);
              return true;
            }, `CopyObject ${label} should reject`);
            await get(destinationBucket, dest, body, replacement, `destination after ${label}`, sentinelTag);
          }
          await assertMissing(() => client.send(new CopyObjectCommand({ Bucket: destinationBucket, Key: dest,
            CopySource: copySource(sourceBucket, absent) })), 'CopyObject missing source key', 'NoSuchKey');
          await get(destinationBucket, dest, body, replacement, 'destination after missing source', sentinelTag);
          await get(destinationBucket, neighbor, neighborBody, { ContentType: 'text/plain' }, 'neighbor after copies', neighborTag);
          await put(sourceBucket, source, Buffer.from('new source'), { ContentType: 'text/plain' });
          await get(destinationBucket, dest, body, replacement, 'destination after source overwrite', sentinelTag);
          await get(destinationBucket, emptyCopy, Buffer.alloc(0), { ContentType: 'text/plain' }, 'empty copy after source overwrite', emptyCopiedTag);
        }, () => cleanObjects(client, destinationBucket, destinationKeys), `objects in bucket ${destinationBucket}`);
      }, () => cleanObjects(client, sourceBucket, sourceKeys), `objects in bucket ${sourceBucket}`);
    });
  });

  // Use a created-then-deleted bucket to avoid colliding with an existing bucket.
  await withBucket(client, async ({ Bucket: existing }) => {
    const source = 'source';
    const dest = 'destination';
    await withCleanup(async () => {
      assertStatus(await client.send(new PutObjectCommand({ Bucket: existing, Key: source, Body: Buffer.from('source') })), 200, 'PutObject setup');
      await withBucket(client, async ({ Bucket: missing }) => {
        await withCleanup(async () => {
          assertStatus(await client.send(new DeleteBucketCommand({ Bucket: missing })), 204, 'DeleteBucket setup');
          await assertMissing(() => client.send(new CopyObjectCommand({ Bucket: missing, Key: dest,
            CopySource: copySource(existing, source) })), 'CopyObject missing destination bucket', 'NoSuchBucket');
          await assertMissing(() => client.send(new CopyObjectCommand({ Bucket: existing, Key: dest,
            CopySource: copySource(missing, source) })), 'CopyObject missing source bucket', 'NoSuchBucket');
          await assertMissing(() => client.send(new GetObjectCommand({ Bucket: existing, Key: dest })), 'destination after missing bucket', 'NoSuchKey');
        }, () => cleanObjects(client, missing, [source, dest]), `objects in bucket ${missing}`);
      });
    }, () => cleanObjects(client, existing, [source, dest]), `objects in bucket ${existing}`);
  });
}
