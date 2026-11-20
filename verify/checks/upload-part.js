import assert from 'node:assert/strict';
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  DeleteBucketCommand, GetObjectCommand, PutObjectCommand, UploadPartCommand,
} from '@aws-sdk/client-s3';
import { listParts } from './list-parts.js';
import { withUploadCleanup } from './multipart-cleanup.js';
import { MISSING_BUCKET_UPLOAD_CODES, assertMissing, assertStatus, withBucket } from './resources.js';

export async function verifyUploadPart(client) {
  await withBucket(client, async ({ Bucket, retainForUploads }) => {
    const Key = 'nested/雪 +&%?#.bin';
    const neighbor = `${Key}/child`;
    await withUploadCleanup(client, Bucket, [Key, neighbor], retainForUploads, async known => {
      const original = Buffer.from('existing object');
      assertStatus(await client.send(new PutObjectCommand({ Bucket, Key, Body: original })), 200, 'PutObject setup');
      const create = async key => {
        const result = await client.send(new CreateMultipartUploadCommand({ Bucket, Key: key }));
        if (typeof result.UploadId === 'string' && result.UploadId) known.push({ Key: key, UploadId: result.UploadId });
        assertStatus(result, 200, 'CreateMultipartUpload setup');
        assert.ok(typeof result.UploadId === 'string' && result.UploadId, 'setup upload ID');
        return result.UploadId;
      };
      const id = await create(Key);
      const other = await create(Key);
      const adjacent = await create(neighbor);
      assert.equal(new Set([id, other, adjacent]).size, 3, 'independent upload IDs');
      const upload = async (key, uploadId, number, body) => {
        const response = await client.send(new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: number, Body: body }));
        assertStatus(response, 200, 'UploadPart');
        assert.ok(typeof response.ETag === 'string' && response.ETag.length, 'UploadPart ETag');
        return response.ETag;
      };
      const list = async (key, uploadId, expected) => {
        const response = await listParts(client, { Bucket, Key: key, UploadId: uploadId });
        assert.equal(response.IsTruncated, false, 'parts fit in one page');
        assert.deepEqual((response.Parts ?? []).map(({ PartNumber, ETag, Size }) => [PartNumber, ETag, Size]), expected, 'listed parts');
      };
      const first = Buffer.alloc(5 * 1024 * 1024, 0x5a); // non-final parts must be at least 5 MiB
      first[0] = 0; first[first.length - 1] = 255;
      const last = Buffer.from([0, 1, 127, 128, 254, 255]);
      const secondTag = await upload(Key, id, 2, last); // out-of-order upload
      const oldTag = await upload(Key, id, 1, Buffer.from('replaced'));
      const maxTag = await upload(Key, id, 10000, Buffer.alloc(0));
      const otherTag = await upload(Key, other, 1, Buffer.from('other'));
      const adjacentTag = await upload(neighbor, adjacent, 1, Buffer.from('adjacent'));
      await list(Key, id, [[1, oldTag, 8], [2, secondTag, last.length], [10000, maxTag, 0]]);
      const firstTag = await upload(Key, id, 1, first);
      await list(Key, id, [[1, firstTag, first.length], [2, secondTag, last.length], [10000, maxTag, 0]]);
      await list(Key, other, [[1, otherTag, 5]]);
      await list(neighbor, adjacent, [[1, adjacentTag, 8]]);
      const before = await client.send(new GetObjectCommand({ Bucket, Key }));
      assertStatus(before, 200, 'GetObject before completion');
      assert.deepEqual(Buffer.from(await before.Body.transformToByteArray()), original, 'uploading parts does not overwrite object');
      await assertMissing(() => client.send(new GetObjectCommand({ Bucket, Key: neighbor })), 'uncompleted upload object', 'NoSuchKey');
      await assertMissing(() => client.send(new UploadPartCommand({ Bucket, Key: neighbor, UploadId: id, PartNumber: 1, Body: last })), 'UploadPart wrong key', 'NoSuchUpload');
      await assertMissing(() => client.send(new UploadPartCommand({ Bucket, Key, UploadId: 'nonexistent-upload-id', PartNumber: 1, Body: last })), 'UploadPart missing upload', 'NoSuchUpload');
      for (const PartNumber of [0, 10001]) {
        await assert.rejects(() => client.send(new UploadPartCommand({ Bucket, Key, UploadId: id, PartNumber, Body: last })), error => {
          assert.equal(error.$metadata?.httpStatusCode, 400, `invalid part ${PartNumber} HTTP status`);
          assert.equal(error.name, 'InvalidArgument', `invalid part ${PartNumber} error code`);
          return true;
        });
      }
      await list(Key, id, [[1, firstTag, first.length], [2, secondTag, last.length], [10000, maxTag, 0]]);
      await withBucket(client, async ({ Bucket: otherBucket, retainForUploads: retainOtherUploads }) => {
        await withUploadCleanup(client, otherBucket, [Key], retainOtherUploads, async otherKnown => {
          const created = await client.send(new CreateMultipartUploadCommand({ Bucket: otherBucket, Key }));
          if (typeof created.UploadId === 'string' && created.UploadId) otherKnown.push({ Key, UploadId: created.UploadId });
          assertStatus(created, 200, 'CreateMultipartUpload other bucket');
          assert.ok(typeof created.UploadId === 'string' && created.UploadId, 'other bucket upload ID');
          const part = await client.send(new UploadPartCommand({ Bucket: otherBucket, Key, UploadId: created.UploadId, PartNumber: 1, Body: last }));
          assertStatus(part, 200, 'UploadPart other bucket');
          assert.ok(typeof part.ETag === 'string' && part.ETag, 'other bucket part ETag');
          await assertMissing(() => client.send(new UploadPartCommand({ Bucket: otherBucket, Key, UploadId: id, PartNumber: 1, Body: last })), 'UploadPart wrong bucket', 'NoSuchUpload');
          const parts = await listParts(client, { Bucket: otherBucket, Key, UploadId: created.UploadId });
          assert.equal(parts.IsTruncated, false, 'other bucket parts fit in one page');
          assert.deepEqual((parts.Parts ?? []).map(({ PartNumber, ETag, Size }) => [PartNumber, ETag, Size]), [[1, part.ETag, last.length]], 'other bucket part intact');
          await list(Key, id, [[1, firstTag, first.length], [2, secondTag, last.length], [10000, maxTag, 0]]);
        });
      });
      const complete = await client.send(new CompleteMultipartUploadCommand({ Bucket, Key, UploadId: id,
        MultipartUpload: { Parts: [{ PartNumber: 1, ETag: firstTag }, { PartNumber: 2, ETag: secondTag }] } }));
      assertStatus(complete, 200, 'CompleteMultipartUpload');
      const result = await client.send(new GetObjectCommand({ Bucket, Key }));
      assertStatus(result, 200, 'GetObject completed upload');
      assert.equal(result.ContentLength, first.length + last.length, 'completed content length');
      assert.ok(Buffer.from(await result.Body.transformToByteArray()).equals(Buffer.concat([first, last])), 'completed part bytes and order');
      await assertMissing(() => client.send(new UploadPartCommand({ Bucket, Key, UploadId: id, PartNumber: 1, Body: last })), 'UploadPart completed upload', 'NoSuchUpload');
      assertStatus(await client.send(new AbortMultipartUploadCommand({ Bucket, Key: neighbor, UploadId: adjacent })), 204, 'AbortMultipartUpload setup');
      await assertMissing(() => client.send(new UploadPartCommand({ Bucket, Key: neighbor, UploadId: adjacent, PartNumber: 1, Body: last })), 'UploadPart aborted upload', 'NoSuchUpload');
      await list(Key, other, [[1, otherTag, 5]]);
    });
  });
  await withBucket(client, async ({ Bucket, retainForUploads }) => {
    await withUploadCleanup(client, Bucket, ['missing'], retainForUploads, async () => {
      assertStatus(await client.send(new DeleteBucketCommand({ Bucket })), 204, 'DeleteBucket setup');
      await assertMissing(() => client.send(new UploadPartCommand({ Bucket, Key: 'missing', UploadId: 'missing', PartNumber: 1, Body: Buffer.alloc(0) })), 'UploadPart missing bucket', MISSING_BUCKET_UPLOAD_CODES);
    });
  });
}
