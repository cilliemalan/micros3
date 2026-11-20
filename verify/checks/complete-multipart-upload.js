import assert from 'node:assert/strict';
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  DeleteBucketCommand, GetObjectCommand, ListPartsCommand, PutObjectCommand, UploadPartCommand,
} from '@aws-sdk/client-s3';
import { withUploadCleanup } from './multipart-cleanup.js';
import { assertMissing, assertStatus, withBucket } from './resources.js';

export async function verifyCompleteMultipartUpload(client) {
  await withBucket(client, async ({ Bucket }) => {
    const Key = 'nested/雪 +&%?#.bin';
    const neighbor = `${Key}/child`;
    const emptyKey = 'empty';
    await withUploadCleanup(client, Bucket, [Key, neighbor, emptyKey], async known => {
      const original = Buffer.from('original object');
      assertStatus(await client.send(new PutObjectCommand({ Bucket, Key, Body: original })), 200, 'PutObject setup');
      const create = async (key, extra = {}) => {
        const result = await client.send(new CreateMultipartUploadCommand({ Bucket, Key: key, ...extra }));
        if (typeof result.UploadId === 'string' && result.UploadId) known.push({ Key: key, UploadId: result.UploadId });
        assertStatus(result, 200, 'CreateMultipartUpload setup');
        assert.ok(typeof result.UploadId === 'string' && result.UploadId, 'setup upload ID');
        return result.UploadId;
      };
      const id = await create(Key, { ContentType: 'application/octet-stream', CacheControl: 'max-age=123', Metadata: { purpose: 'complete' } });
      const other = await create(Key);
      const small = await create(neighbor);
      const aborted = await create(neighbor);
      assert.equal(new Set([id, other, small, aborted]).size, 4, 'independent upload IDs');
      const upload = async (key, UploadId, PartNumber, Body) => {
        const result = await client.send(new UploadPartCommand({ Bucket, Key: key, UploadId, PartNumber, Body }));
        assertStatus(result, 200, 'UploadPart setup');
        assert.ok(typeof result.ETag === 'string' && result.ETag, 'setup part ETag');
        return { PartNumber, ETag: result.ETag };
      };
      const first = Buffer.alloc(5 * 1024 * 1024, 0x5a);
      first[0] = 0; first[first.length - 1] = 255;
      const last = Buffer.from([0, 1, 127, 128, 254, 255]);
      const p3 = await upload(Key, id, 3, last);
      const p1 = await upload(Key, id, 1, first);
      const p2 = await upload(Key, id, 2, Buffer.from('unselected part'));
      const otherPart = await upload(Key, other, 1, Buffer.from('other upload'));
      const tiny1 = await upload(neighbor, small, 1, Buffer.from('too small'));
      const tiny2 = await upload(neighbor, small, 2, Buffer.from('last'));
      assertStatus(await client.send(new AbortMultipartUploadCommand({ Bucket, Key: neighbor, UploadId: aborted })), 204, 'AbortMultipartUpload setup');
      const complete = (key, UploadId, Parts) => client.send(new CompleteMultipartUploadCommand({ Bucket, Key: key, UploadId, MultipartUpload: { Parts } }));
      const reject = async (action, code) => assert.rejects(action, error => {
        assert.equal(error.$metadata?.httpStatusCode, 400, `${code} HTTP status`);
        assert.equal(error.name, code, `${code} error code`);
        return true;
      }, `CompleteMultipartUpload should reject with ${code}`);
      await reject(() => complete(Key, id, [p3, p1]), 'InvalidPartOrder');
      await reject(() => complete(Key, id, [p1, { ...p3, ETag: '"incorrect-etag"' }]), 'InvalidPart');
      await reject(() => complete(Key, id, [p1, { PartNumber: 4, ETag: p3.ETag }]), 'InvalidPart');
      await reject(() => complete(neighbor, small, [tiny1, tiny2]), 'EntityTooSmall');
      await assertMissing(() => complete(neighbor, id, [p1]), 'CompleteMultipartUpload wrong key', 'NoSuchUpload');
      await assertMissing(() => complete(Key, 'nonexistent-upload-id', [p1]), 'CompleteMultipartUpload missing upload', 'NoSuchUpload');
      await assertMissing(() => complete(neighbor, aborted, [tiny1]), 'CompleteMultipartUpload aborted upload', 'NoSuchUpload');
      const before = await client.send(new GetObjectCommand({ Bucket, Key }));
      assertStatus(before, 200, 'GetObject after failed completions');
      assert.deepEqual(Buffer.from(await before.Body.transformToByteArray()), original, 'failed completions preserve existing object');
      await assertMissing(() => client.send(new GetObjectCommand({ Bucket, Key: neighbor })), 'failed completion object', 'NoSuchKey');
      const parts = await client.send(new ListPartsCommand({ Bucket, Key, UploadId: id }));
      assertStatus(parts, 200, 'ListParts after failed completions');
      assert.equal(parts.IsTruncated, false, 'all parts fit in one page');
      assert.deepEqual((parts.Parts ?? []).map(({ PartNumber, ETag }) => ({ PartNumber, ETag })), [p1, p2, p3], 'failed completions preserve parts');
      await withBucket(client, async ({ Bucket: otherBucket }) => {
        await withUploadCleanup(client, otherBucket, [Key], async otherKnown => {
          const created = await client.send(new CreateMultipartUploadCommand({ Bucket: otherBucket, Key }));
          if (typeof created.UploadId === 'string' && created.UploadId) otherKnown.push({ Key, UploadId: created.UploadId });
          assertStatus(created, 200, 'CreateMultipartUpload other bucket');
          assert.ok(typeof created.UploadId === 'string' && created.UploadId, 'other bucket upload ID');
          const part = await client.send(new UploadPartCommand({ Bucket: otherBucket, Key, UploadId: created.UploadId, PartNumber: 1, Body: last }));
          assertStatus(part, 200, 'UploadPart other bucket');
          assert.ok(typeof part.ETag === 'string' && part.ETag, 'other bucket part ETag');
          await assertMissing(() => client.send(new CompleteMultipartUploadCommand({ Bucket: otherBucket, Key, UploadId: id, MultipartUpload: { Parts: [p1] } })), 'CompleteMultipartUpload wrong bucket', 'NoSuchUpload');
          const completed = await client.send(new CompleteMultipartUploadCommand({ Bucket: otherBucket, Key, UploadId: created.UploadId, MultipartUpload: { Parts: [{ PartNumber: 1, ETag: part.ETag }] } }));
          assertStatus(completed, 200, 'CompleteMultipartUpload other bucket');
          const object = await client.send(new GetObjectCommand({ Bucket: otherBucket, Key }));
          assertStatus(object, 200, 'GetObject other bucket');
          assert.deepEqual(Buffer.from(await object.Body.transformToByteArray()), last, 'other bucket upload is intact');
        });
      });
      const result = await complete(Key, id, [p1, p3]);
      assertStatus(result, 200, 'CompleteMultipartUpload');
      assert.equal(result.Bucket, Bucket, 'completion bucket');
      assert.equal(result.Key, Key, 'completion key');
      assert.ok(typeof result.ETag === 'string' && result.ETag.length, 'completion ETag');
      const object = await client.send(new GetObjectCommand({ Bucket, Key }));
      assertStatus(object, 200, 'GetObject completed upload');
      assert.equal(object.ContentLength, first.length + last.length, 'completed content length');
      assert.ok(Buffer.from(await object.Body.transformToByteArray()).equals(Buffer.concat([first, last])), 'selected parts assembled in order');
      assert.equal(object.ETag, result.ETag, 'completion and object ETags match');
      assert.equal(object.ContentType, 'application/octet-stream', 'initiation ContentType');
      assert.equal(object.CacheControl, 'max-age=123', 'initiation CacheControl');
      assert.deepEqual(object.Metadata, { purpose: 'complete' }, 'initiation metadata');
      await assertMissing(() => complete(Key, id, [p1, p3]), 'CompleteMultipartUpload completed upload', 'NoSuchUpload');
      await assertMissing(() => client.send(new ListPartsCommand({ Bucket, Key, UploadId: id })), 'ListParts completed upload', 'NoSuchUpload');
      const survivor = await complete(Key, other, [otherPart]);
      assertStatus(survivor, 200, 'CompleteMultipartUpload independent upload');
      const overwritten = await client.send(new GetObjectCommand({ Bucket, Key }));
      assertStatus(overwritten, 200, 'GetObject independent upload');
      assert.deepEqual(Buffer.from(await overwritten.Body.transformToByteArray()), Buffer.from('other upload'), 'independent upload can overwrite completed object');
      const recovered = await complete(neighbor, small, [tiny2]);
      assertStatus(recovered, 200, 'CompleteMultipartUpload after EntityTooSmall');
      const neighborObject = await client.send(new GetObjectCommand({ Bucket, Key: neighbor }));
      assertStatus(neighborObject, 200, 'GetObject recovered upload');
      assert.deepEqual(Buffer.from(await neighborObject.Body.transformToByteArray()), Buffer.from('last'), 'failed upload remains completable');
      const emptyId = await create(emptyKey);
      const emptyPart = await upload(emptyKey, emptyId, 1, Buffer.alloc(0));
      assertStatus(await complete(emptyKey, emptyId, [emptyPart]), 200, 'CompleteMultipartUpload empty object');
      const empty = await client.send(new GetObjectCommand({ Bucket, Key: emptyKey }));
      assertStatus(empty, 200, 'GetObject empty object');
      assert.equal(empty.ContentLength, 0, 'empty object length');
      assert.equal((await empty.Body.transformToByteArray()).length, 0, 'empty object content');
    });
  });
  await withBucket(client, async ({ Bucket }) => {
    await withUploadCleanup(client, Bucket, ['missing'], async () => {
      assertStatus(await client.send(new DeleteBucketCommand({ Bucket })), 204, 'DeleteBucket setup');
      await assertMissing(() => client.send(new CompleteMultipartUploadCommand({ Bucket, Key: 'missing', UploadId: 'missing', MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"missing"' }] } })), 'CompleteMultipartUpload missing bucket', 'NoSuchBucket');
    });
  });
}
