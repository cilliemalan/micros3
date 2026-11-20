import assert from 'node:assert/strict';
import { DeleteBucketCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { assertMissing, assertStatus, ignoreMissing, message, status, withBucket, withCleanup } from './resources.js';

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

async function missingBucket(client, operation, command) {
  await withBucket(client, async ({ Bucket }) => {
    const Key = 'missing-bucket-key';
    await withCleanup(async () => {
      assertStatus(await client.send(new DeleteBucketCommand({ Bucket })), 204, 'DeleteBucket setup');
      await assertMissing(() => client.send(command({ Bucket, Key })), `${operation} missing bucket`, 'NoSuchBucket');
    }, () => cleanObjects(client, Bucket, [Key]), `object ${Bucket}/${Key}`);
  });
}

export async function verifyPutObject(client) {
  await withBucket(client, async ({ Bucket }) => {
    const key = 'nested/雪 +&%.bin';
    const child = `${key}/child`;
    const empty = 'empty';
    await withCleanup(async () => {
      const put = async (Key, Body, fields, label) => {
        const response = await client.send(new PutObjectCommand({ Bucket, Key, Body, ...fields }));
        assertStatus(response, 200, label);
        assert.ok(response.ETag, `${label} ETag`);
        return response.ETag;
      };
      const verify = async (Key, Body, fields, ETag, label) => {
        const response = await client.send(new GetObjectCommand({ Bucket, Key }));
        const actual = Buffer.from(await response.Body.transformToByteArray());
        assertStatus(response, 200, label);
        assert.deepEqual(actual, Body, `${label} content`);
        assert.equal(response.ContentLength, Body.length, `${label} ContentLength`);
        assert.equal(response.ETag, ETag, `${label} ETag`);
        assert.equal(response.ContentType, fields.ContentType, `${label} ContentType`);
        assert.equal(response.CacheControl, fields.CacheControl, `${label} CacheControl`);
        assert.equal(response.ContentDisposition, fields.ContentDisposition, `${label} ContentDisposition`);
        assert.deepEqual(response.Metadata ?? {}, fields.Metadata ?? {}, `${label} metadata`);
      };
      const body = Buffer.from([0, 1, 127, 128, 254, 255]);
      const fields = { ContentType: 'application/octet-stream', CacheControl: 'max-age=123',
        ContentDisposition: 'attachment; filename="sample.bin"', Metadata: { purpose: 'put-check', revision: 'one' } };
      const neighbor = Buffer.from('neighbor');
      const neighborFields = { ContentType: 'text/plain', Metadata: { purpose: 'neighbor' } };
      const emptyFields = { ContentType: 'text/plain' };
      const tag = await put(key, body, fields, 'PutObject');
      const neighborTag = await put(child, neighbor, neighborFields, 'PutObject neighboring key');
      const emptyTag = await put(empty, Buffer.alloc(0), emptyFields, 'PutObject empty');
      await verify(key, body, fields, tag, 'GetObject after PutObject');
      await verify(empty, Buffer.alloc(0), emptyFields, emptyTag, 'GetObject empty');
      const replacement = Buffer.from('replacement');
      const replacementFields = { ContentType: 'text/plain', Metadata: { revision: 'two' } };
      const replacementTag = await put(key, replacement, replacementFields, 'PutObject overwrite');
      await verify(key, replacement, replacementFields, replacementTag, 'GetObject after overwrite');
      await verify(child, neighbor, neighborFields, neighborTag, 'GetObject neighboring key after overwrite');
      await verify(empty, Buffer.alloc(0), emptyFields, emptyTag, 'GetObject empty after overwrite');
    }, () => cleanObjects(client, Bucket, [key, child, empty]), `objects in bucket ${Bucket}`);
  });
  await missingBucket(client, 'PutObject', input => new PutObjectCommand({ ...input, Body: Buffer.from('test') }));
}

export async function verifyGetObject(client) {
  await withBucket(client, async ({ Bucket }) => {
    const key = 'nested/雪 +&%.bin';
    const empty = 'empty';
    const absent = 'absent';
    await withCleanup(async () => {
      const get = input => client.send(new GetObjectCommand({ Bucket, ...input }));
      const missing = () => assertMissing(() => get({ Key: absent }), 'GetObject missing key', 'NoSuchKey');
      await missing();
      const body = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
      const fields = { ContentType: 'application/octet-stream', CacheControl: 'max-age=123',
        ContentDisposition: 'attachment; filename="sample.bin"', Metadata: { purpose: 'get-check', revision: 'one' } };
      const setup = async (Key, Body, extra) => {
        const response = await client.send(new PutObjectCommand({ Bucket, Key, Body, ...extra }));
        assertStatus(response, 200, 'PutObject setup');
        assert.ok(response.ETag, 'PutObject setup ETag');
        return response.ETag;
      };
      const tag = await setup(key, body, fields);
      const emptyTag = await setup(empty, Buffer.alloc(0), { ContentType: 'text/plain' });
      const verify = async (input, expected, code, label) => {
        const response = await get(input);
        const actual = Buffer.from(await response.Body.transformToByteArray());
        assertStatus(response, code, label);
        assert.deepEqual(actual, expected, `${label} content`);
        assert.equal(response.ContentLength, expected.length, `${label} ContentLength`);
        return response;
      };
      const response = await verify({ Key: key }, body, 200, 'GetObject');
      assert.equal(response.ETag, tag, 'GetObject ETag');
      assert.equal(response.ContentType, fields.ContentType, 'GetObject ContentType');
      assert.equal(response.CacheControl, fields.CacheControl, 'GetObject CacheControl');
      assert.equal(response.ContentDisposition, fields.ContentDisposition, 'GetObject ContentDisposition');
      assert.deepEqual(response.Metadata ?? {}, fields.Metadata, 'GetObject metadata');
      assert.ok(response.LastModified instanceof Date && !Number.isNaN(response.LastModified.getTime()), 'GetObject LastModified');
      const emptyResponse = await verify({ Key: empty }, Buffer.alloc(0), 200, 'GetObject empty');
      assert.equal(emptyResponse.ETag, emptyTag, 'GetObject empty ETag');
      assert.equal(emptyResponse.ContentType, 'text/plain', 'GetObject empty ContentType');
      assert.deepEqual(emptyResponse.Metadata ?? {}, {}, 'GetObject empty metadata');
      await missing();
      for (const [Range, expected, contentRange] of [
        ['bytes=1-3', body.subarray(1, 4), 'bytes 1-3/7'],
        ['bytes=4-', body.subarray(4), 'bytes 4-6/7'],
        ['bytes=-2', body.subarray(5), 'bytes 5-6/7'],
      ]) {
        const ranged = await verify({ Key: key, Range }, expected, 206, `GetObject ${Range}`);
        assert.equal(ranged.ContentRange, contentRange, `GetObject ${Range} ContentRange`);
        assert.equal(ranged.ETag, tag, `GetObject ${Range} ETag`);
      }
      for (const [input, expected, label] of [
        [{ Range: 'bytes=100-200' }, 416, 'unsatisfiable range'],
        [{ IfMatch: '"not-the-etag"' }, 412, 'IfMatch'],
        [{ IfNoneMatch: tag }, 304, 'IfNoneMatch'],
      ]) {
        await assert.rejects(() => get({ Key: key, ...input }), error => {
          assert.equal(status(error), expected, `GetObject ${label} HTTP status`);
          return true;
        }, `GetObject ${label} should reject`);
      }
      await verify({ Key: key, IfMatch: tag }, body, 200, 'GetObject matching IfMatch');
      await verify({ Key: key, IfNoneMatch: '"not-the-etag"' }, body, 200, 'GetObject nonmatching IfNoneMatch');
      const replacement = Buffer.from('new content');
      const replacementFields = { ContentType: 'text/plain', Metadata: { revision: 'two' } };
      const replacementTag = await setup(key, replacement, replacementFields);
      const after = await verify({ Key: key }, replacement, 200, 'GetObject after overwrite');
      assert.equal(after.ETag, replacementTag, 'GetObject after overwrite ETag');
      assert.equal(after.ContentType, replacementFields.ContentType, 'GetObject after overwrite ContentType');
      assert.deepEqual(after.Metadata ?? {}, replacementFields.Metadata, 'GetObject after overwrite metadata');
      assert.equal(after.CacheControl, undefined, 'GetObject after overwrite CacheControl');
      assert.equal(after.ContentDisposition, undefined, 'GetObject after overwrite ContentDisposition');
      const unchanged = await verify({ Key: empty }, Buffer.alloc(0), 200, 'GetObject empty after overwrite');
      assert.equal(unchanged.ETag, emptyTag, 'GetObject empty after overwrite ETag');
    }, () => cleanObjects(client, Bucket, [key, empty, absent]), `objects in bucket ${Bucket}`);
  });
  await missingBucket(client, 'GetObject', input => new GetObjectCommand(input));
}
