import assert from 'node:assert/strict';
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  DeleteBucketCommand, ListMultipartUploadsCommand, PutObjectCommand, UploadPartCommand,
} from '@aws-sdk/client-s3';
import { assertMissing, assertStatus, withBucket } from './resources.js';
import { withUploadCleanup } from './multipart-cleanup.js';
import { assertUrlEncoded } from './encoding.js';

export async function verifyListMultipartUploads(client) {
  await withBucket(client, async ({ Bucket, retainForUploads }) => {
    const keys = ['alpha/one', 'alpha/sub/a', 'alpha/sub/b', 'alpha/two', 'special/雪 +&%.txt'];
    await withUploadCleanup(client, Bucket, keys, retainForUploads, async known => {
      const list = async (input = {}) => {
        const result = await client.send(new ListMultipartUploadsCommand({ Bucket, ...input }));
        assertStatus(result, 200, 'ListMultipartUploads');
        assert.equal(result.Bucket, Bucket, 'listing bucket');
        assert.equal(typeof result.IsTruncated, 'boolean', 'listing IsTruncated');
        for (const field of ['Prefix', 'Delimiter', 'MaxUploads', 'KeyMarker', 'UploadIdMarker']) {
          if (input[field] !== undefined && !(input.EncodingType === 'url' && ['Prefix', 'Delimiter', 'KeyMarker'].includes(field))) {
            assert.equal(result[field], input[field], `listing ${field}`);
          }
        }
        assert.ok(result.Uploads === undefined || Array.isArray(result.Uploads), 'uploads array');
        assert.ok(result.CommonPrefixes === undefined || Array.isArray(result.CommonPrefixes), 'prefixes array');
        for (const upload of result.Uploads ?? []) {
          assert.ok(typeof upload.Key === 'string' && typeof upload.UploadId === 'string' && upload.UploadId.length, 'upload key and ID');
          assert.ok(upload.Initiated instanceof Date && !Number.isNaN(upload.Initiated.getTime()), 'upload initiation timestamp');
          assert.equal(upload.StorageClass, 'STANDARD', 'upload storage class');
        }
        return result;
      };
      const pairs = result => (result.Uploads ?? []).map(({ Key, UploadId }) => [Key, UploadId]);
      const page = async (input, expected, prefixes = []) => {
        const result = await list(input);
        assert.equal(result.IsTruncated, false, 'untruncated listing');
        assert.deepEqual(pairs(result), expected, 'listed uploads');
        assert.deepEqual((result.CommonPrefixes ?? []).map(p => p.Prefix), prefixes, 'listed common prefixes');
        return result;
      };
      await withBucket(client, async ({ Bucket: missing }) => {
        assertStatus(await client.send(new DeleteBucketCommand({ Bucket: missing })), 204, 'DeleteBucket setup');
        await assertMissing(() => client.send(new ListMultipartUploadsCommand({ Bucket: missing })), 'ListMultipartUploads missing bucket', 'NoSuchBucket');
      });
      await page({}, []);
      // A completed object is not an in-progress upload.
      assertStatus(await client.send(new PutObjectCommand({ Bucket, Key: keys[0], Body: 'existing' })), 200, 'PutObject setup');
      await page({}, []);
      const create = async Key => {
        const result = await client.send(new CreateMultipartUploadCommand({ Bucket, Key }));
        if (typeof result.UploadId === 'string' && result.UploadId) known.push({ Key, UploadId: result.UploadId });
        assertStatus(result, 200, 'CreateMultipartUpload setup');
        assert.ok(typeof result.UploadId === 'string' && result.UploadId, 'setup upload ID');
        return result.UploadId;
      };
      // Start out of key order and include two uploads for the same key.
      const special = await create(keys[4]);
      const subB = await create(keys[2]);
      const oneA = await create(keys[0]);
      const two = await create(keys[3]);
      const subA = await create(keys[1]);
      const oneB = await create(keys[0]);
      assert.equal(new Set([special, subB, oneA, two, subA, oneB]).size, 6, 'unique upload IDs');
      const all = await list();
      assert.equal(all.IsTruncated, false, 'all uploads fit in one page');
      const ordered = pairs(all);
      // S3 orders same-key uploads by initiation; ties need not use ID order.
      assert.deepEqual(ordered.map(([key]) => key), [keys[0], keys[0], keys[1], keys[2], keys[3], keys[4]], 'key ordering');
      assert.ok(all.Uploads[0].Initiated <= all.Uploads[1].Initiated, 'same-key initiation ordering');
      assert.deepEqual(new Set(ordered.map(pair => JSON.stringify(pair))), new Set([[keys[0], oneA], [keys[0], oneB], [keys[1], subA], [keys[2], subB], [keys[3], two], [keys[4], special]].map(pair => JSON.stringify(pair))), 'all upload identities');
      await page({ Prefix: 'alpha/' }, ordered.slice(0, 5));
      await page({ Prefix: 'missing/' }, []);
      await page({ Prefix: 'special/' }, ordered.slice(5));
      await page({ KeyMarker: keys[0] }, ordered.slice(2));
      await page({ Prefix: 'alpha/', Delimiter: '/' }, [ordered[0], ordered[1], ordered[4]], ['alpha/sub/']);
      await page({ Prefix: 'alpha/', Delimiter: '/', KeyMarker: 'alpha/sub/' }, [ordered[4]]);
      const encoded = await list({ Prefix: 'special/', EncodingType: 'url' });
      assert.equal(encoded.IsTruncated, false, 'encoded listing not truncated');
      assert.equal(encoded.EncodingType, 'url', 'encoding type');
      assertUrlEncoded(encoded.Prefix, 'special/', 'encoded prefix');
      assert.equal(encoded.Uploads?.length, 1, 'encoded listing uploads');
      assertUrlEncoded(encoded.Uploads[0].Key, keys[4], 'URL-encoded key');
      assert.equal(encoded.Uploads[0].UploadId, special, 'encoded listing upload ID');

      // Follow both markers, including across two uploads with the same key.
      let markers = {};
      const seen = new Set();
      for (let i = 0; i < ordered.length; i++) {
        const result = await list({ MaxUploads: 1, ...markers });
        assert.deepEqual(pairs(result), [ordered[i]], `pagination page ${i + 1}`);
        assert.deepEqual(result.CommonPrefixes ?? [], [], 'no unexpected prefixes');
        assert.equal(result.IsTruncated, i < ordered.length - 1, 'pagination truncation');
        if (result.IsTruncated) {
          assert.ok(typeof result.NextKeyMarker === 'string' && result.NextKeyMarker, 'next key marker');
          assert.ok(typeof result.NextUploadIdMarker === 'string' && result.NextUploadIdMarker, 'next upload ID marker');
          const token = JSON.stringify([result.NextKeyMarker, result.NextUploadIdMarker]);
          assert.ok(!seen.has(token), 'pagination markers advance');
          seen.add(token);
          markers = { KeyMarker: result.NextKeyMarker, UploadIdMarker: result.NextUploadIdMarker };
        }
      }
      // Prefix filtering must continue to apply on every page, including the last.
      markers = {};
      for (let i = 0; i < 3; i++) {
        const result = await list({ Prefix: 'alpha/', MaxUploads: 2, ...markers });
        assert.deepEqual(pairs(result), ordered.slice(i * 2, Math.min(i * 2 + 2, 5)), 'prefix pagination uploads');
        assert.equal(result.IsTruncated, i < 2, 'prefix pagination truncation');
        if (result.IsTruncated) {
          assert.ok(result.NextKeyMarker && result.NextUploadIdMarker, 'prefix pagination markers');
          markers = { KeyMarker: result.NextKeyMarker, UploadIdMarker: result.NextUploadIdMarker };
        }
      }
      // Rolled-up prefixes consume a slot and must not be repeated on the next page.
      markers = {};
      const grouped = [[ordered[0]], [ordered[1]], 'alpha/sub/', [ordered[4]]];
      for (let i = 0; i < grouped.length; i++) {
        const result = await list({ Prefix: 'alpha/', Delimiter: '/', MaxUploads: 1, ...markers });
        const group = grouped[i];
        assert.deepEqual(pairs(result), typeof group === 'string' ? [] : group, 'grouped page uploads');
        assert.deepEqual((result.CommonPrefixes ?? []).map(p => p.Prefix), typeof group === 'string' ? [group] : [], 'grouped page prefixes');
        assert.equal(result.IsTruncated, i < grouped.length - 1, 'grouped page truncation');
        if (result.IsTruncated) {
          // AWS leaves NextKeyMarker empty when a truncated page ends with a rolled-up
          // prefix; the prefix then serves as the key marker. Any other page must name its
          // last upload as the marker.
          const { NextKeyMarker, Uploads = [], CommonPrefixes = [] } = result;
          const last = [...Uploads.map(upload => upload.Key), ...CommonPrefixes.map(p => p.Prefix)].at(-1);
          const marker = NextKeyMarker || (Uploads.length === 0 ? CommonPrefixes.at(-1)?.Prefix : undefined);
          assert.ok(typeof marker === 'string' && marker, 'grouped next key marker');
          assert.equal(marker, last, 'grouped next key marker names the last listed entry');
          markers = { KeyMarker: marker };
          if (result.NextUploadIdMarker) markers.UploadIdMarker = result.NextUploadIdMarker;
        }
      }
      // Listing must not expose another bucket's uploads, even for the same key.
      await withBucket(client, async ({ Bucket: other, retainForUploads: retainOtherUploads }) => {
        await withUploadCleanup(client, other, [keys[0]], retainOtherUploads, async otherKnown => {
          const result = await client.send(new CreateMultipartUploadCommand({ Bucket: other, Key: keys[0] }));
          if (typeof result.UploadId === 'string' && result.UploadId) otherKnown.push({ Key: keys[0], UploadId: result.UploadId });
          assertStatus(result, 200, 'other bucket upload');
          assert.ok(result.UploadId, 'other bucket upload ID');
          await page({}, ordered);
          const otherList = await client.send(new ListMultipartUploadsCommand({ Bucket: other }));
          assertStatus(otherList, 200, 'other bucket listing');
          assert.equal(otherList.IsTruncated, false, 'other bucket listing not truncated');
          assert.deepEqual(pairs(otherList), [[keys[0], result.UploadId]], 'other bucket isolation');
        });
      });
      assertStatus(await client.send(new AbortMultipartUploadCommand({ Bucket, Key: keys[0], UploadId: oneA })), 204, 'abort setup');
      const part = await client.send(new UploadPartCommand({ Bucket, Key: keys[3], UploadId: two, PartNumber: 1, Body: 'complete' }));
      assertStatus(part, 200, 'upload part setup');
      assert.ok(part.ETag, 'part ETag');
      assertStatus(await client.send(new CompleteMultipartUploadCommand({ Bucket, Key: keys[3], UploadId: two, MultipartUpload: { Parts: [{ PartNumber: 1, ETag: part.ETag }] } })), 200, 'complete setup');
      await page({}, ordered.filter(([, id]) => id !== oneA && id !== two));
    });
  });
}
