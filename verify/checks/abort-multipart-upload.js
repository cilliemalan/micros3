import assert from 'node:assert/strict';
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  DeleteBucketCommand, GetObjectCommand, ListMultipartUploadsCommand,
  PutObjectCommand, UploadPartCommand,
} from '@aws-sdk/client-s3';
import { assertPartsMissing, listParts } from './list-parts.js';
import { withUploadCleanup } from './multipart-cleanup.js';
import { MISSING_BUCKET_UPLOAD_CODES, assertMissing, assertStatus, status, withBucket } from './resources.js';

export async function verifyAbortMultipartUpload(client) {
  await withBucket(client, async ({ Bucket, retainForUploads }) => {
    const key = 'nested/雪 +&%?#.bin';
    const neighbor = `${key}/child`;
    await withUploadCleanup(client, Bucket, [key, neighbor], retainForUploads, async known => {
      const old = Buffer.from('existing object');
      const body = Buffer.from([0, 1, 127, 128, 254, 255]);
      assertStatus(await client.send(new PutObjectCommand({ Bucket, Key: key, Body: old, ContentType: 'text/plain' })), 200, 'PutObject setup');
      const create = async Key => {
        const result = await client.send(new CreateMultipartUploadCommand({ Bucket, Key }));
        if (typeof result.UploadId === 'string' && result.UploadId) known.push({ Key, UploadId: result.UploadId });
        assertStatus(result, 200, 'CreateMultipartUpload setup');
        assert.ok(typeof result.UploadId === 'string' && result.UploadId, 'setup upload ID');
        return result.UploadId;
      };
      const aborted = await create(key);
      const survivor = await create(key);
      const adjacent = await create(neighbor);
      assert.equal(new Set([aborted, survivor, adjacent]).size, 3, 'independent upload IDs');
      const part = async (Key, UploadId, Body) => {
        const result = await client.send(new UploadPartCommand({ Bucket, Key, UploadId, PartNumber: 1, Body }));
        assertStatus(result, 200, 'UploadPart setup');
        assert.ok(result.ETag, 'setup part ETag');
        return result.ETag;
      };
      const abortedETag = await part(key, aborted, Buffer.from('discard this part'));
      const survivorETag = await part(key, survivor, body);
      const adjacentETag = await part(neighbor, adjacent, Buffer.from('neighbor part'));
      const list = async expected => {
        const result = await client.send(new ListMultipartUploadsCommand({ Bucket }));
        assertStatus(result, 200, 'ListMultipartUploads');
        assert.equal(result.IsTruncated, false, 'uploads fit in one page');
        assert.deepEqual((result.Uploads ?? []).map(({ Key, UploadId }) => [Key, UploadId]).sort(), expected.sort(), 'remaining uploads');
      };
      const parts = async (Key, UploadId, ETag) => {
        const result = await listParts(client, { Bucket, Key, UploadId });
        assert.equal(result.IsTruncated, false, 'parts fit in one page');
        assert.deepEqual((result.Parts ?? []).map(p => [p.PartNumber, p.ETag]), [[1, ETag]], 'surviving parts');
      };
      const getOld = async () => {
        const result = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        assertStatus(result, 200, 'GetObject existing object');
        assert.deepEqual(Buffer.from(await result.Body.transformToByteArray()), old, 'abort preserves existing content');
        assert.equal(result.ContentType, 'text/plain', 'abort preserves existing headers');
      };
      await list([[key, aborted], [key, survivor], [neighbor, adjacent]]);
      // An ID is scoped to its exact key; a failed abort must not consume it.
      await assertMissing(() => client.send(new AbortMultipartUploadCommand({ Bucket, Key: neighbor, UploadId: aborted })), 'AbortMultipartUpload wrong key', 'NoSuchUpload');
      await parts(key, aborted, abortedETag);
      assertStatus(await client.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: aborted })), 204, 'AbortMultipartUpload');
      await list([[key, survivor], [neighbor, adjacent]]);
      await assertPartsMissing(client, { Bucket, Key: key, UploadId: aborted }, 'aborted upload');
      await assertMissing(() => client.send(new UploadPartCommand({ Bucket, Key: key, UploadId: aborted, PartNumber: 1, Body: body })), 'UploadPart aborted upload', 'NoSuchUpload');
      await assertMissing(() => client.send(new CompleteMultipartUploadCommand({ Bucket, Key: key, UploadId: aborted, MultipartUpload: { Parts: [{ PartNumber: 1, ETag: abortedETag }] } })), 'CompleteMultipartUpload aborted upload', 'NoSuchUpload');
      // A repeated abort is idempotent on AWS (204); other implementations may reject it as
      // NoSuchUpload. Either way the upload must stay gone.
      let repeatedAbort;
      try {
        repeatedAbort = await client.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: aborted }));
      } catch (error) {
        assert.equal(status(error), 404, 'repeat AbortMultipartUpload HTTP status');
        assert.equal(error.name, 'NoSuchUpload', 'repeat AbortMultipartUpload error code');
      }
      if (repeatedAbort) assertStatus(repeatedAbort, 204, 'repeat AbortMultipartUpload HTTP status');
      await assertPartsMissing(client, { Bucket, Key: key, UploadId: aborted }, 'repeated abort');
      await assertMissing(() => client.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: 'nonexistent-upload-id' })), 'AbortMultipartUpload missing upload', 'NoSuchUpload');
      await getOld();
      await assertMissing(() => client.send(new GetObjectCommand({ Bucket, Key: neighbor })), 'uncompleted neighbor object', 'NoSuchKey');
      await parts(key, survivor, survivorETag);
      await parts(neighbor, adjacent, adjacentETag);
      // The remaining same-key upload can still be completed with its original part.
      assertStatus(await client.send(new CompleteMultipartUploadCommand({ Bucket, Key: key, UploadId: survivor, MultipartUpload: { Parts: [{ PartNumber: 1, ETag: survivorETag }] } })), 200, 'CompleteMultipartUpload survivor');
      const result = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      assertStatus(result, 200, 'GetObject survivor');
      assert.deepEqual(Buffer.from(await result.Body.transformToByteArray()), body, 'survivor content');
      await list([[neighbor, adjacent]]);
      // Aborting an upload with no parts also succeeds, without deleting the object.
      const empty = await create(key);
      assertStatus(await client.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: empty })), 204, 'AbortMultipartUpload without parts');
      await list([[neighbor, adjacent]]);
      const after = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      assertStatus(after, 200, 'GetObject after empty abort');
      assert.deepEqual(Buffer.from(await after.Body.transformToByteArray()), body, 'empty abort preserves object');

      await withBucket(client, async ({ Bucket: otherBucket, retainForUploads: retainOtherUploads }) => {
        await withUploadCleanup(client, otherBucket, [neighbor], retainOtherUploads, async otherKnown => {
          const created = await client.send(new CreateMultipartUploadCommand({ Bucket: otherBucket, Key: neighbor }));
          if (typeof created.UploadId === 'string' && created.UploadId) otherKnown.push({ Key: neighbor, UploadId: created.UploadId });
          assertStatus(created, 200, 'CreateMultipartUpload other bucket');
          assert.ok(typeof created.UploadId === 'string' && created.UploadId, 'other bucket upload ID');
          const otherPart = await client.send(new UploadPartCommand({ Bucket: otherBucket, Key: neighbor, UploadId: created.UploadId, PartNumber: 1, Body: body }));
          assertStatus(otherPart, 200, 'UploadPart other bucket');
          assert.ok(otherPart.ETag, 'other bucket part ETag');
          await assertMissing(() => client.send(new AbortMultipartUploadCommand({ Bucket: otherBucket, Key: neighbor, UploadId: adjacent })), 'AbortMultipartUpload wrong bucket', 'NoSuchUpload');
          await parts(neighbor, adjacent, adjacentETag);
          const otherParts = await listParts(client, { Bucket: otherBucket, Key: neighbor, UploadId: created.UploadId });
          assert.equal(otherParts.IsTruncated, false, 'other bucket parts fit in one page');
          assert.deepEqual((otherParts.Parts ?? []).map(p => [p.PartNumber, p.ETag]), [[1, otherPart.ETag]], 'other bucket upload remains intact');
          await list([[neighbor, adjacent]]);
        });
      });
    });
  });
  await withBucket(client, async ({ Bucket, retainForUploads }) => {
    await withUploadCleanup(client, Bucket, ['missing'], retainForUploads, async () => {
      assertStatus(await client.send(new DeleteBucketCommand({ Bucket })), 204, 'DeleteBucket setup');
      await assertMissing(() => client.send(new AbortMultipartUploadCommand({ Bucket, Key: 'missing', UploadId: 'missing' })), 'AbortMultipartUpload missing bucket', MISSING_BUCKET_UPLOAD_CODES);
    });
  });
}
