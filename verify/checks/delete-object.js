import assert from 'node:assert/strict';
import { DeleteBucketCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { assertMissing, assertStatus, ignoreMissing, message, withBucket, withCleanup } from './resources.js';

async function cleanObjects(client, Bucket, keys) {
  const failures = [];
  for (const Key of keys) {
    try {
      await ignoreMissing(() => client.send(new DeleteObjectCommand({ Bucket, Key })), ['NoSuchBucket', 'NoSuchKey']);
    } catch (error) {
      failures.push(new Error(`${Bucket}/${Key}: ${message(error)}`, { cause: error }));
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map(message).join('; '));
}

export async function verifyDeleteObject(client) {
  await withBucket(client, async ({ Bucket }) => {
    const key = 'nested/雪 +&%.bin';
    const child = `${key}/child`;
    const empty = 'empty';
    const absent = 'absent';
    const keys = [key, child, empty, absent];
    await withCleanup(async () => {
      const del = async (Key, label) => {
        const response = await client.send(new DeleteObjectCommand({ Bucket, Key }));
        assertStatus(response, 204, label);
      };
      const missing = (Key, label) => assertMissing(
        () => client.send(new GetObjectCommand({ Bucket, Key })), label, 'NoSuchKey',
      );
      const contents = async (Key, body, metadata, label) => {
        const response = await client.send(new GetObjectCommand({ Bucket, Key }));
        assertStatus(response, 200, label);
        assert.deepEqual(Buffer.from(await response.Body.transformToByteArray()), body, `${label} content`);
        assert.deepEqual(response.Metadata ?? {}, metadata, `${label} metadata`);
      };
      const body = Buffer.from([0, 1, 127, 128, 255]);
      const childBody = Buffer.from('keep the neighboring key');
      for (const [Key, Body, Metadata] of [
        [key, body, { purpose: 'delete' }],
        [child, childBody, { purpose: 'keep' }],
        [empty, Buffer.alloc(0), {}],
      ]) {
        assertStatus(await client.send(new PutObjectCommand({ Bucket, Key, Body, Metadata })), 200, 'PutObject setup');
      }
      await contents(key, body, { purpose: 'delete' }, 'GetObject before delete');
      await contents(empty, Buffer.alloc(0), {}, 'GetObject empty before delete');
      await del(absent, 'DeleteObject missing key');
      await missing(absent, 'GetObject missing key after delete');
      await contents(key, body, { purpose: 'delete' }, 'GetObject after missing-key delete');
      await del(key, 'DeleteObject');
      await missing(key, 'GetObject after delete');
      await contents(child, childBody, { purpose: 'keep' }, 'GetObject neighboring key after delete');
      await contents(empty, Buffer.alloc(0), {}, 'GetObject empty after neighboring delete');
      await del(key, 'DeleteObject repeated');
      await missing(key, 'GetObject after repeated delete');
      await contents(child, childBody, { purpose: 'keep' }, 'GetObject neighboring key after repeated delete');
      const replacement = Buffer.from('recreated after deletion');
      assertStatus(await client.send(new PutObjectCommand({ Bucket, Key: key, Body: replacement, Metadata: { purpose: 'replacement' } })), 200, 'PutObject recreation');
      await contents(key, replacement, { purpose: 'replacement' }, 'GetObject recreated key');
      await del(key, 'DeleteObject recreated key');
      await missing(key, 'GetObject after deleting recreated key');
      await contents(child, childBody, { purpose: 'keep' }, 'GetObject neighboring key after recreated key delete');
      await del(empty, 'DeleteObject empty');
      await missing(empty, 'GetObject empty after delete');
      await contents(child, childBody, { purpose: 'keep' }, 'GetObject neighboring key after empty delete');
    }, () => cleanObjects(client, Bucket, keys), `objects in bucket ${Bucket}`);
  });

  // Delete a bucket we own first, rather than assuming a random name is unused.
  // Keep cleanup armed in case a faulty request recreates the bucket or key.
  await withBucket(client, async ({ Bucket }) => {
    const Key = 'missing-bucket-key';
    await withCleanup(async () => {
      assertStatus(await client.send(new DeleteBucketCommand({ Bucket })), 204, 'DeleteBucket setup');
      await assertMissing(() => client.send(new DeleteObjectCommand({ Bucket, Key })), 'DeleteObject missing bucket', 'NoSuchBucket');
    }, () => cleanObjects(client, Bucket, [Key]), `object ${Bucket}/${Key}`);
  });
}
