import assert from 'node:assert/strict';
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  DeleteBucketCommand, ListPartsCommand, UploadPartCommand,
} from '@aws-sdk/client-s3';
import { withUploadCleanup } from './multipart-cleanup.js';
import { MISSING_BUCKET_UPLOAD_CODES, assertMissing, assertStatus, status, withBucket } from './resources.js';
import { PrerequisiteError, scenario } from '../test-runner.js';

// Other multipart checks use ListParts to observe upload state. A failed or
// unsupported ListParts request is reported as a missing prerequisite; the
// listed content remains an assertion about the operation under test.
export async function listParts(client, input) {
  let response;
  try {
    response = await client.send(new ListPartsCommand(input));
    assertStatus(response, 200, 'ListParts');
    assert.equal(typeof response.IsTruncated, 'boolean', 'ListParts IsTruncated');
    assert.ok(response.Parts === undefined || Array.isArray(response.Parts), 'ListParts parts array');
  } catch (error) {
    throw new PrerequisiteError('ListParts', error);
  }
  return response;
}

// A finished upload must be reported as NoSuchUpload. A listing that still
// succeeds is the tested operation's failure; any other error is ListParts'.
export async function assertPartsMissing(client, input, operation) {
  try {
    await client.send(new ListPartsCommand(input));
  } catch (error) {
    if (status(error) === 404 && error.name === 'NoSuchUpload') return;
    throw new PrerequisiteError('ListParts', error);
  }
  assert.fail(`${operation}: ListParts still lists the upload`);
}

const summary = parts => (parts ?? []).map(({ PartNumber, ETag, Size }) => [PartNumber, ETag, Size]);

export async function verifyListParts(client) {
  await withBucket(client, async ({ Bucket, retainForUploads }) => {
    const Key = 'parts/雪 +&%?#.bin';
    const neighbor = `${Key}/child`;
    await withUploadCleanup(client, Bucket, [Key, neighbor], retainForUploads, async known => {
      const create = async key => {
        const result = await client.send(new CreateMultipartUploadCommand({ Bucket, Key: key }));
        if (typeof result.UploadId === 'string' && result.UploadId) known.push({ Key: key, UploadId: result.UploadId });
        assertStatus(result, 200, 'CreateMultipartUpload setup');
        assert.ok(typeof result.UploadId === 'string' && result.UploadId, 'setup upload ID');
        return result.UploadId;
      };
      const upload = async (key, UploadId, PartNumber, body) => {
        const result = await client.send(new UploadPartCommand({ Bucket, Key: key, UploadId, PartNumber, Body: body }));
        assertStatus(result, 200, 'UploadPart setup');
        assert.ok(typeof result.ETag === 'string' && result.ETag.length, 'setup part ETag');
        return [PartNumber, result.ETag, body.length];
      };
      const list = async (key, UploadId, input = {}) => {
        const result = await client.send(new ListPartsCommand({ Bucket, Key: key, UploadId, ...input }));
        assertStatus(result, 200, 'ListParts');
        assert.equal(result.Bucket, Bucket, 'ListParts bucket');
        assert.equal(result.Key, key, 'ListParts key');
        assert.equal(result.UploadId, UploadId, 'ListParts upload ID');
        assert.equal(typeof result.IsTruncated, 'boolean', 'ListParts IsTruncated');
        assert.equal(result.StorageClass, 'STANDARD', 'ListParts storage class');
        if (input.MaxParts !== undefined) assert.equal(result.MaxParts, input.MaxParts, 'ListParts MaxParts');
        if (input.PartNumberMarker !== undefined) assert.equal(String(result.PartNumberMarker), input.PartNumberMarker, 'ListParts PartNumberMarker');
        assert.ok(result.Parts === undefined || Array.isArray(result.Parts), 'ListParts parts array');
        for (const part of result.Parts ?? []) {
          assert.ok(Number.isInteger(part.PartNumber), 'part number');
          assert.ok(typeof part.ETag === 'string' && part.ETag.length, 'part ETag');
          assert.ok(Number.isInteger(part.Size), 'part size');
          assert.ok(part.LastModified instanceof Date && !Number.isNaN(part.LastModified.getTime()), 'part LastModified');
        }
        return result;
      };
      const page = async (key, UploadId, input, expected) => {
        const result = await list(key, UploadId, input);
        assert.equal(result.IsTruncated, false, 'untruncated parts listing');
        assert.deepEqual(summary(result.Parts), expected, 'listed parts');
        return result;
      };

      const { id, other, adjacent } = await scenario('setup', async () => {
        const ids = { id: await create(Key), other: await create(Key), adjacent: await create(neighbor) };
        assert.equal(new Set(Object.values(ids)).size, 3, 'independent upload IDs');
        return ids;
      });
      // A new upload has no parts.
      await scenario('new upload', () => page(Key, id, {}, []));

      // Upload out of order and replace a part; the listing is ordered by part number.
      const { all, seventh } = await scenario('out-of-order uploads and replacement', async () => {
        const third = await upload(Key, id, 3, Buffer.from('third part'));
        await upload(Key, id, 1, Buffer.from('to be replaced'));
        const seventh = await upload(Key, id, 7, Buffer.alloc(0));
        const second = await upload(Key, id, 2, Buffer.from([0, 1, 127, 128, 254, 255]));
        const first = await upload(Key, id, 1, Buffer.from('first'));
        const all = [first, second, third, seventh];
        await page(Key, id, {}, all);
        return { all, seventh };
      });
      const otherPart = await scenario('isolation across uploads and keys', async () => {
        const otherPart = await upload(Key, other, 1, Buffer.from('other upload'));
        const adjacentPart = await upload(neighbor, adjacent, 4, Buffer.from('adjacent'));
        await page(Key, other, {}, [otherPart]);
        await page(neighbor, adjacent, {}, [adjacentPart]);
        return otherPart;
      });

      // Follow NextPartNumberMarker one part at a time.
      await scenario('one part per page', async () => {
        let marker;
        const seen = new Set();
        for (let i = 0; i < all.length; i++) {
          const input = { MaxParts: 1, ...(marker === undefined ? {} : { PartNumberMarker: marker }) };
          const result = await list(Key, id, input);
          assert.deepEqual(summary(result.Parts), [all[i]], `parts page ${i + 1}`);
          assert.equal(result.IsTruncated, i < all.length - 1, `parts page ${i + 1} truncation`);
          if (result.IsTruncated) {
            assert.equal(String(result.NextPartNumberMarker), String(all[i][0]), `parts page ${i + 1} NextPartNumberMarker`);
            assert.ok(!seen.has(result.NextPartNumberMarker), 'parts markers advance');
            seen.add(result.NextPartNumberMarker);
            marker = String(result.NextPartNumberMarker);
          }
        }
      });
      await scenario('pages of three parts', async () => {
        const firstPage = await list(Key, id, { MaxParts: 3 });
        assert.deepEqual(summary(firstPage.Parts), all.slice(0, 3), 'first page of three parts');
        assert.equal(firstPage.IsTruncated, true, 'first page of three truncated');
        assert.equal(String(firstPage.NextPartNumberMarker), '3', 'first page of three marker');
        await page(Key, id, { MaxParts: 3, PartNumberMarker: '3' }, all.slice(3));
      });
      // An exact fit is not truncated; a marker need not name an existing part.
      await scenario('exact fit and markers naming no part', async () => {
        await page(Key, id, { MaxParts: 4 }, all);
        await page(Key, id, { PartNumberMarker: '4' }, [seventh]);
        await page(Key, id, { PartNumberMarker: '7' }, []);
      });

      // Upload IDs are scoped to their exact key.
      await scenario('wrong key', () => assertMissing(
        () => client.send(new ListPartsCommand({ Bucket, Key: neighbor, UploadId: id })), 'ListParts wrong key', 'NoSuchUpload'));
      await scenario('missing upload', () => assertMissing(
        () => client.send(new ListPartsCommand({ Bucket, Key, UploadId: 'nonexistent-upload-id' })), 'ListParts missing upload', 'NoSuchUpload'));
      await scenario('wrong bucket', () => withBucket(client, async ({ Bucket: otherBucket, retainForUploads: retainOtherUploads }) => {
        await withUploadCleanup(client, otherBucket, [Key], retainOtherUploads, async otherKnown => {
          const created = await client.send(new CreateMultipartUploadCommand({ Bucket: otherBucket, Key }));
          if (typeof created.UploadId === 'string' && created.UploadId) otherKnown.push({ Key, UploadId: created.UploadId });
          assertStatus(created, 200, 'CreateMultipartUpload other bucket');
          assert.ok(typeof created.UploadId === 'string' && created.UploadId, 'other bucket upload ID');
          await assertMissing(() => client.send(new ListPartsCommand({ Bucket: otherBucket, Key, UploadId: id })), 'ListParts wrong bucket', 'NoSuchUpload');
          const listed = await client.send(new ListPartsCommand({ Bucket: otherBucket, Key, UploadId: created.UploadId }));
          assertStatus(listed, 200, 'ListParts other bucket');
          assert.equal(listed.IsTruncated, false, 'other bucket parts not truncated');
          assert.deepEqual(summary(listed.Parts), [], 'other bucket upload has no parts');
        });
      }));

      // Finished uploads have no parts to list; others are unaffected.
      await scenario('aborted upload', async () => {
        assertStatus(await client.send(new AbortMultipartUploadCommand({ Bucket, Key: neighbor, UploadId: adjacent })), 204, 'AbortMultipartUpload setup');
        await assertMissing(() => client.send(new ListPartsCommand({ Bucket, Key: neighbor, UploadId: adjacent })), 'ListParts aborted upload', 'NoSuchUpload');
      });
      await scenario('completed upload', async () => {
        const completed = await client.send(new CompleteMultipartUploadCommand({ Bucket, Key, UploadId: other,
          MultipartUpload: { Parts: [{ PartNumber: otherPart[0], ETag: otherPart[1] }] } }));
        assertStatus(completed, 200, 'CompleteMultipartUpload setup');
        await assertMissing(() => client.send(new ListPartsCommand({ Bucket, Key, UploadId: other })), 'ListParts completed upload', 'NoSuchUpload');
        await page(Key, id, {}, all);
      });
    });
  });
  await scenario('missing bucket', () => withBucket(client, async ({ Bucket, retainForUploads }) => {
    await withUploadCleanup(client, Bucket, ['missing'], retainForUploads, async () => {
      assertStatus(await client.send(new DeleteBucketCommand({ Bucket })), 204, 'DeleteBucket setup');
      await assertMissing(() => client.send(new ListPartsCommand({ Bucket, Key: 'missing', UploadId: 'missing' })), 'ListParts missing bucket', MISSING_BUCKET_UPLOAD_CODES);
    });
  }));
}
