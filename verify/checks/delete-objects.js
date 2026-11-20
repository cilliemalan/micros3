import assert from 'node:assert/strict';
import { DeleteBucketCommand, DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { assertMissing, assertStatus, cleanupDelete, message, status, withBucket, withCleanup } from './resources.js';

async function cleanObjects(client, Bucket, keys) {
  const failures = [];
  for (const Key of keys) {
    try {
      await cleanupDelete(client, new DeleteObjectCommand({ Bucket, Key }), ['NoSuchBucket', 'NoSuchKey']);
    } catch (error) {
      failures.push(new Error(`${Bucket}/${Key}: ${message(error)}`, { cause: error }));
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map(message).join('; '));
}

export async function verifyDeleteObjects(client) {
  await withBucket(client, async ({ Bucket }) => withBucket(client, async ({ Bucket: otherBucket }) => {
    const key = 'nested/雪 +&%.bin';
    const child = `${key}/child`;
    const empty = 'empty';
    const absent = 'absent';
    const limitKey = 'limit-existing';
    const keys = [key, child, empty, absent, limitKey];
    await withCleanup(async () => withCleanup(async () => {
      const put = async (Key, Body, Metadata = {}) => {
        assertStatus(await client.send(new PutObjectCommand({ Bucket, Key, Body, Metadata })), 200, 'PutObject setup');
      };
      const contents = async (Key, body, metadata, label) => {
        const result = await client.send(new GetObjectCommand({ Bucket, Key }));
        assertStatus(result, 200, label);
        assert.deepEqual(Buffer.from(await result.Body.transformToByteArray()), body, `${label} content`);
        assert.deepEqual(result.Metadata ?? {}, metadata, `${label} metadata`);
      };
      const missing = (Key, label) => assertMissing(() => client.send(new GetObjectCommand({ Bucket, Key })), label, 'NoSuchKey');
      const del = async (objects, quiet, label) => {
        const response = await client.send(new DeleteObjectsCommand({
          Bucket, Delete: { Objects: objects.map(Key => ({ Key })), ...(quiet === undefined ? {} : { Quiet: quiet }) },
        }));
        assertStatus(response, 200, label);
        assert.deepEqual(response.Errors ?? [], [], `${label} errors`);
        const deleted = response.Deleted ?? [];
        assert.deepEqual(deleted.map(item => item.Key).sort(), quiet ? [] : [...objects].sort(), `${label} deleted keys`);
        return response;
      };
      const body = Buffer.from([0, 1, 127, 128, 255]);
      const neighbor = Buffer.from('keep neighboring key');
      assertStatus(await client.send(new PutObjectCommand({ Bucket: otherBucket, Key: key, Body: neighbor, Metadata: { purpose: 'other-bucket' } })), 200, 'PutObject other bucket setup');
      await put(key, body, { purpose: 'delete' });
      await put(child, neighbor, { purpose: 'keep' });
      await put(empty, Buffer.alloc(0));
      await contents(key, body, { purpose: 'delete' }, 'GetObject before multi-delete');
      await contents(empty, Buffer.alloc(0), {}, 'GetObject empty before multi-delete');
      await del([key, empty, absent], undefined, 'DeleteObjects verbose');
      for (const Key of [key, empty, absent]) await missing(Key, 'GetObject after multi-delete');
      await contents(child, neighbor, { purpose: 'keep' }, 'GetObject neighboring key after multi-delete');
      await del([key, empty, absent], false, 'DeleteObjects repeated');
      for (const Key of [key, empty, absent]) await missing(Key, 'GetObject after repeated multi-delete');
      await contents(child, neighbor, { purpose: 'keep' }, 'GetObject neighboring key after repeated multi-delete');

      const replacement = Buffer.from('recreated');
      await put(key, replacement, { purpose: 'replacement' });
      await put(empty, Buffer.alloc(0));
      await contents(key, replacement, { purpose: 'replacement' }, 'GetObject recreated key');
      await del([key, empty, absent], true, 'DeleteObjects quiet');
      for (const Key of [key, empty, absent]) await missing(Key, 'GetObject after quiet multi-delete');
      await contents(child, neighbor, { purpose: 'keep' }, 'GetObject neighboring key after quiet multi-delete');

      // The service accepts at most 1,000 identifiers. Use absent keys to avoid
      // creating 1,000 objects, and a real key to detect partial application.
      await put(limitKey, body, { purpose: 'limit' });
      const limitKeys = Array.from({ length: 999 }, (_, i) => `limit-absent-${i}`);
      await assert.rejects(() => client.send(new DeleteObjectsCommand({
        Bucket, Delete: { Objects: [limitKey, ...limitKeys, 'limit-extra'].map(Key => ({ Key })) },
      })), error => {
        assert.equal(status(error), 400, 'DeleteObjects over limit HTTP status');
        return true;
      }, 'DeleteObjects over limit should reject');
      await contents(limitKey, body, { purpose: 'limit' }, 'GetObject after oversized multi-delete');
      await del([limitKey, ...limitKeys], false, 'DeleteObjects 1000 keys');
      await missing(limitKey, 'GetObject after 1000-key multi-delete');
      await contents(child, neighbor, { purpose: 'keep' }, 'GetObject neighboring key after 1000-key multi-delete');
      const other = await client.send(new GetObjectCommand({ Bucket: otherBucket, Key: key }));
      assertStatus(other, 200, 'GetObject other bucket');
      assert.deepEqual(Buffer.from(await other.Body.transformToByteArray()), neighbor, 'GetObject other bucket content');
      assert.deepEqual(other.Metadata ?? {}, { purpose: 'other-bucket' }, 'GetObject other bucket metadata');
    }, () => cleanObjects(client, Bucket, keys), `objects in bucket ${Bucket}`),
    () => cleanObjects(client, otherBucket, [key]), `objects in bucket ${otherBucket}`);
  }));

  await withBucket(client, async ({ Bucket }) => {
    const Key = 'missing-bucket-key';
    await withCleanup(async () => {
      assertStatus(await client.send(new DeleteBucketCommand({ Bucket })), 204, 'DeleteBucket setup');
      await assertMissing(() => client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: [{ Key }] } })),
        'DeleteObjects missing bucket', 'NoSuchBucket');
    }, () => cleanObjects(client, Bucket, [Key]), `object ${Bucket}/${Key}`);
  });
}
