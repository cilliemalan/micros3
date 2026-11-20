import assert from 'node:assert/strict';
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  DeleteBucketCommand, DeleteObjectCommand, GetObjectCommand, ListMultipartUploadsCommand,
  PutObjectCommand, UploadPartCommand,
} from '@aws-sdk/client-s3';
import { assertMissing, assertStatus, ignoreMissing, message, withBucket, withCleanup } from './resources.js';

// A create response can be lost (or retried after success), leaving upload IDs we
// never received. Enumerate the entire isolated bucket before aborting anything.
async function cleanUploads(client, Bucket, known) {
  const uploads = new Map(known.map(({ Key, UploadId }) => [JSON.stringify([Key, UploadId]), { Key, UploadId }]));
  const failures = [];
  try {
    let markers = {};
    const seen = new Set();
    for (let page = 0; ; page++) {
      if (page >= 1000) throw new Error('upload listing exceeded 1000 pages');
      const result = await client.send(new ListMultipartUploadsCommand({ Bucket, ...markers }));
      assertStatus(result, 200, 'cleanup ListMultipartUploads');
      for (const upload of result.Uploads ?? []) {
        assert.ok(typeof upload.Key === 'string' && typeof upload.UploadId === 'string' && upload.UploadId.length, 'cleanup upload key and ID');
        uploads.set(JSON.stringify([upload.Key, upload.UploadId]), upload);
      }
      assert.equal(typeof result.IsTruncated, 'boolean', 'cleanup upload listing IsTruncated');
      if (!result.IsTruncated) break;
      const { NextKeyMarker, NextUploadIdMarker } = result;
      assert.ok(typeof NextKeyMarker === 'string' && NextKeyMarker.length && typeof NextUploadIdMarker === 'string' && NextUploadIdMarker.length, 'cleanup upload listing markers');
      const token = JSON.stringify([NextKeyMarker, NextUploadIdMarker]);
      assert.ok(!seen.has(token), 'cleanup upload listing repeated markers');
      seen.add(token);
      markers = { KeyMarker: NextKeyMarker, UploadIdMarker: NextUploadIdMarker };
    }
  } catch (error) {
    // A deleted bucket needs no cleanup; other listing failures can hide uploads.
    if (!(error.name === 'NoSuchBucket' && error.$metadata?.httpStatusCode === 404)) failures.push(new Error(`listing uploads: ${message(error)}`, { cause: error }));
  }
  for (const { Key, UploadId } of uploads.values()) {
    try {
      await ignoreMissing(() => client.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId })), ['NoSuchBucket', 'NoSuchUpload']);
    } catch (error) {
      failures.push(new Error(`abort ${Bucket}/${Key} upload ${UploadId}: ${message(error)}`, { cause: error }));
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map(message).join('; '));
}

async function withUploadCleanup(client, Bucket, keys, run) {
  const known = [];
  await withCleanup(() => run(known), async () => {
    const failures = [];
    try { await cleanUploads(client, Bucket, known); } catch (error) { failures.push(error); }
    for (const Key of keys) {
      try {
        await ignoreMissing(() => client.send(new DeleteObjectCommand({ Bucket, Key })), ['NoSuchBucket', 'NoSuchKey']);
      } catch (error) { failures.push(new Error(`delete ${Bucket}/${Key}: ${message(error)}`, { cause: error })); }
    }
    if (failures.length) throw new AggregateError(failures, failures.map(message).join('; '));
  }, `uploads and objects in bucket ${Bucket}`);
}

export async function verifyCreateMultipartUpload(client) {
  await withBucket(client, async ({ Bucket }) => {
    const key = 'nested/雪 +&%?#.bin';
    const neighbor = `${key}/child`;
    await withUploadCleanup(client, Bucket, [key, neighbor], async known => {
      const old = Buffer.from('original object');
      const body = Buffer.from([0, 1, 127, 128, 254, 255]);
      const fields = { ContentType: 'application/octet-stream', CacheControl: 'max-age=123', Metadata: { purpose: 'multipart', revision: 'one' } };
      assertStatus(await client.send(new PutObjectCommand({ Bucket, Key: key, Body: old, ContentType: 'text/plain' })), 200, 'PutObject setup');
      const create = async (Key, extra = {}) => {
        const result = await client.send(new CreateMultipartUploadCommand({ Bucket, Key, ...extra }));
        // Record even a malformed response before making assertions, for cleanup.
        if (typeof result.UploadId === 'string' && result.UploadId) known.push({ Key, UploadId: result.UploadId });
        assertStatus(result, 200, 'CreateMultipartUpload');
        assert.equal(result.Bucket, Bucket, 'CreateMultipartUpload bucket');
        assert.equal(result.Key, Key, 'CreateMultipartUpload key');
        assert.ok(typeof result.UploadId === 'string' && result.UploadId.length > 0, 'CreateMultipartUpload upload ID');
        return result.UploadId;
      };
      const first = await create(key, fields);
      const second = await create(key, { ContentType: 'text/plain', Metadata: { revision: 'two' } });
      const third = await create(neighbor);
      assert.equal(new Set([first, second, third]).size, 3, 'each initiation has a distinct upload ID');

      const listing = await client.send(new ListMultipartUploadsCommand({ Bucket }));
      assertStatus(listing, 200, 'ListMultipartUploads');
      assert.equal(listing.IsTruncated, false, 'all setup uploads fit in one page');
      assert.deepEqual((listing.Uploads ?? []).map(({ Key, UploadId }) => [Key, UploadId]).sort(),
        [[key, first], [key, second], [neighbor, third]].sort(), 'initiated uploads are independent and listed');
      const before = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      assertStatus(before, 200, 'GetObject before completion');
      assert.deepEqual(Buffer.from(await before.Body.transformToByteArray()), old, 'initiation does not overwrite existing object');
      assert.equal(before.ContentType, 'text/plain', 'initiation preserves existing object headers');
      await assertMissing(() => client.send(new GetObjectCommand({ Bucket, Key: neighbor })), 'uncompleted upload object', 'NoSuchKey');

      const part = await client.send(new UploadPartCommand({ Bucket, Key: key, UploadId: first, PartNumber: 1, Body: body }));
      assertStatus(part, 200, 'UploadPart setup');
      assert.ok(part.ETag, 'UploadPart setup ETag');
      assertStatus(await client.send(new CompleteMultipartUploadCommand({ Bucket, Key: key, UploadId: first,
        MultipartUpload: { Parts: [{ PartNumber: 1, ETag: part.ETag }] } })), 200, 'CompleteMultipartUpload setup');
      const completed = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      assertStatus(completed, 200, 'GetObject completed upload');
      assert.deepEqual(Buffer.from(await completed.Body.transformToByteArray()), body, 'completed content');
      assert.equal(completed.ContentLength, body.length, 'completed ContentLength');
      assert.equal(completed.ContentType, fields.ContentType, 'initiation ContentType');
      assert.equal(completed.CacheControl, fields.CacheControl, 'initiation CacheControl');
      assert.deepEqual(completed.Metadata, fields.Metadata, 'initiation user metadata');
      // Completing one same-key upload must not consume the other or its metadata.
      const otherBody = Buffer.from('second independent upload');
      const otherPart = await client.send(new UploadPartCommand({ Bucket, Key: key, UploadId: second, PartNumber: 1, Body: otherBody }));
      assertStatus(otherPart, 200, 'UploadPart second upload');
      assert.ok(otherPart.ETag, 'UploadPart second upload ETag');
      assertStatus(await client.send(new CompleteMultipartUploadCommand({ Bucket, Key: key, UploadId: second,
        MultipartUpload: { Parts: [{ PartNumber: 1, ETag: otherPart.ETag }] } })), 200, 'CompleteMultipartUpload second upload');
      const other = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      assertStatus(other, 200, 'GetObject second upload');
      assert.deepEqual(Buffer.from(await other.Body.transformToByteArray()), otherBody, 'second upload content');
      assert.equal(other.ContentType, 'text/plain', 'second upload ContentType');
      assert.deepEqual(other.Metadata, { revision: 'two' }, 'second upload metadata');
      await assertMissing(() => client.send(new GetObjectCommand({ Bucket, Key: neighbor })), 'neighbor after completions', 'NoSuchKey');
      const remaining = await client.send(new ListMultipartUploadsCommand({ Bucket }));
      assertStatus(remaining, 200, 'ListMultipartUploads after completion');
      assert.equal(remaining.IsTruncated, false, 'remaining uploads fit in one page');
      assert.deepEqual((remaining.Uploads ?? []).map(({ Key, UploadId }) => [Key, UploadId]), [[neighbor, third]], 'neighbor upload remains independent');
    });
  });

  await withBucket(client, async ({ Bucket }) => {
    await withUploadCleanup(client, Bucket, ['missing'], async () => {
      assertStatus(await client.send(new DeleteBucketCommand({ Bucket })), 204, 'DeleteBucket setup');
      await assertMissing(() => client.send(new CreateMultipartUploadCommand({ Bucket, Key: 'missing' })), 'CreateMultipartUpload missing bucket', 'NoSuchBucket');
    });
  });
}
