import assert from 'node:assert/strict';
import { DeleteBucketCommand, DeleteObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { assertStatus, cleanupDelete, message, status, withBucket, withCleanup } from './resources.js';
import { verifyCopyObject } from './copy-object.js';
import { verifyDeleteObject } from './delete-object.js';
import { verifyDeleteObjects } from './delete-objects.js';
import { verifyGetObject, verifyPutObject } from './put-get-object.js';
import integrityTests from './integrity.js';

async function verifyHeadObject(client) {
  await withBucket(client, async ({ Bucket }) => {
    const keys = ['nested/雪 +&%.bin', 'empty', 'absent'];
    const [Key, empty, absent] = keys;
    await withCleanup(async () => {
      const head = input => client.send(new HeadObjectCommand({ Bucket, ...input }));
      const put = async (key, body, fields = {}) => {
        const response = await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ...fields }));
        assertStatus(response, 200, 'PutObject setup');
        assert.ok(response.ETag, 'PutObject setup ETag');
        return response.ETag;
      };
      const missing = async (input, label) => {
        // HEAD responses need not contain an S3 XML error code.
        await assert.rejects(() => head(input), error => {
          assert.equal(status(error), 404, `${label} HTTP status`);
          return true;
        }, `${label} should reject`);
      };
      await missing({ Key: absent }, 'HeadObject missing key');
      const body = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
      const fields = {
        ContentType: 'application/octet-stream', CacheControl: 'max-age=123',
        ContentDisposition: 'attachment; filename="sample.bin"',
        Metadata: { purpose: 'head-check', revision: 'one' },
      };
      const etag = await put(Key, body, fields);
      const emptyTag = await put(empty, Buffer.alloc(0), { ContentType: 'text/plain' });
      const verify = (response, size, tag, type, metadata, label) => {
        assertStatus(response, 200, label);
        assert.equal(response.ContentLength, size, `${label} ContentLength`);
        assert.equal(response.ETag, tag, `${label} ETag`);
        assert.equal(response.ContentType, type, `${label} ContentType`);
        assert.deepEqual(response.Metadata ?? {}, metadata, `${label} metadata`);
        assert.ok(response.LastModified instanceof Date && !Number.isNaN(response.LastModified.getTime()), `${label} LastModified`);
        assert.equal(response.Body, undefined, `${label} must not expose a body`);
      };
      const first = await head({ Key });
      verify(first, body.length, etag, fields.ContentType, fields.Metadata, 'HeadObject');
      assert.equal(first.CacheControl, fields.CacheControl, 'HeadObject CacheControl');
      assert.equal(first.ContentDisposition, fields.ContentDisposition, 'HeadObject ContentDisposition');
      verify(await head({ Key: empty }), 0, emptyTag, 'text/plain', {}, 'HeadObject empty');
      await missing({ Key: absent }, 'HeadObject missing key after upload');

      const ranged = await head({ Key, Range: 'bytes=1-3' });
      // S3 documents the range's effect on ContentLength, but does not require
      // ContentRange in a HEAD response. Accept either successful status.
      assert.ok([200, 206].includes(status(ranged)), 'HeadObject range HTTP status');
      assert.equal(ranged.ContentLength, 3, 'HeadObject range ContentLength');
      if (ranged.ContentRange !== undefined) {
        assert.equal(ranged.ContentRange, `bytes 1-3/${body.length}`, 'HeadObject ContentRange');
      }
      assert.equal(ranged.ETag, etag, 'HeadObject range ETag');
      assert.equal(ranged.Body, undefined, 'HeadObject range must not expose a body');
      for (const [input, expected, label] of [
        [{ Range: 'bytes=100-200' }, 416, 'unsatisfiable range'],
        [{ IfMatch: '"not-the-etag"' }, 412, 'IfMatch'],
        [{ IfNoneMatch: etag }, 304, 'IfNoneMatch'],
      ]) {
        await assert.rejects(() => head({ Key, ...input }), error => {
          assert.equal(status(error), expected, `HeadObject ${label} HTTP status`);
          return true;
        }, `HeadObject ${label} should reject`);
      }
      assertStatus(await head({ Key, IfMatch: etag }), 200, 'HeadObject matching IfMatch');
      assertStatus(await head({ Key, IfNoneMatch: '"not-the-etag"' }), 200, 'HeadObject nonmatching IfNoneMatch');

      const replacement = Buffer.from('new content');
      const replacementFields = { ContentType: 'text/plain', Metadata: { revision: 'two' } };
      const replacementTag = await put(Key, replacement, replacementFields);
      const after = await head({ Key });
      verify(after, replacement.length, replacementTag, replacementFields.ContentType, replacementFields.Metadata, 'HeadObject after overwrite');
      assert.equal(after.CacheControl, undefined, 'HeadObject overwrite removes old CacheControl');
      assert.equal(after.ContentDisposition, undefined, 'HeadObject overwrite removes old ContentDisposition');
      verify(await head({ Key: empty }), 0, emptyTag, 'text/plain', {}, 'HeadObject other key after overwrite');
    }, async () => {
      const failures = [];
      // Even failed requests can have created a resource; also clean up the missing key.
      for (const Key of keys) {
        try {
          await cleanupDelete(client, new DeleteObjectCommand({ Bucket, Key }), ['NoSuchBucket', 'NoSuchKey']);
        } catch (error) {
          failures.push(new Error(`${Bucket}/${Key}: ${message(error)}`, { cause: error }));
        }
      }
      if (failures.length) throw new AggregateError(failures, failures.map(message).join('; '));
    }, `objects in bucket ${Bucket}`);
  });

  // Use a bucket we created and deleted, not a random name that might exist.
  // Leave cleanup armed in case a broken HEAD recreates it.
  await withBucket(client, async ({ Bucket }) => {
    assertStatus(await client.send(new DeleteBucketCommand({ Bucket })), 204, 'DeleteBucket setup');
    await assert.rejects(() => client.send(new HeadObjectCommand({ Bucket, Key: 'missing' })), error => {
      assert.equal(status(error), 404, 'HeadObject missing bucket HTTP status');
      return true;
    }, 'HeadObject missing bucket should reject');
  });
}

export default [
  { name: 'PutObject', run: ({ client }) => verifyPutObject(client) },
  { name: 'GetObject', run: ({ client }) => verifyGetObject(client) },
  { name: 'HeadObject', run: ({ client }) => verifyHeadObject(client) },
  { name: 'CopyObject', run: ({ client }) => verifyCopyObject(client) },
  { name: 'DeleteObject', run: ({ client }) => verifyDeleteObject(client) },
  { name: 'DeleteObjects', run: ({ client }) => verifyDeleteObjects(client) },
  ...integrityTests,
];
