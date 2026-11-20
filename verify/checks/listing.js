import assert from 'node:assert/strict';
import {
  DeleteObjectCommand,
  ListObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  assertMissing, assertStatus, bucketName, cleanupDelete, message, withBucket, withCleanup,
} from './resources.js';

// Deliberately upload out of order, with nested and empty objects.
const objects = [
  { Key: 'beta/four.txt', Body: 'four' },
  { Key: 'alpha/sub/three.txt', Body: 'three' },
  { Key: 'root.txt', Body: 'root object' },
  { Key: 'alpha/two.txt', Body: '' },
  { Key: 'special/風.txt', Body: 'later key' },
  { Key: 'special/雪 +&%.txt', Body: 'special key' },
  { Key: 'alpha/third/deep.txt', Body: 'nested' },
  { Key: 'alpha/sub/second.txt', Body: 'second' },
  { Key: 'alpha/one.txt', Body: 'one' },
];
const allKeys = [
  'alpha/one.txt', 'alpha/sub/second.txt', 'alpha/sub/three.txt', 'alpha/third/deep.txt',
  'alpha/two.txt', 'beta/four.txt', 'root.txt', 'special/雪 +&%.txt', 'special/風.txt',
];
const alphaKeys = [
  'alpha/one.txt', 'alpha/sub/second.txt', 'alpha/sub/three.txt', 'alpha/third/deep.txt', 'alpha/two.txt',
];

async function withObjects(client, Bucket, run) {
  const attempted = [];
  const expected = new Map();
  await withCleanup(async () => {
    for (const { Key, Body } of objects) {
      // A failed request may still have stored the object.
      attempted.push(Key);
      const response = await client.send(new PutObjectCommand({ Bucket, Key, Body: Buffer.from(Body) }));
      assertStatus(response, 200, 'PutObject setup');
      assert.ok(response.ETag, `PutObject setup ETag for ${Key}`);
      expected.set(Key, { Size: Buffer.byteLength(Body), ETag: response.ETag });
    }
    await run(expected);
  }, async () => {
    const failures = [];
    for (const Key of attempted) {
      try {
        await cleanupDelete(client, new DeleteObjectCommand({ Bucket, Key }), ['NoSuchBucket', 'NoSuchKey']);
      } catch (error) {
        failures.push(new Error(`${Bucket}/${Key}: ${message(error)}`, { cause: error }));
      }
    }
    if (failures.length) throw new AggregateError(failures, failures.map(message).join('; '));
  }, `objects in bucket ${Bucket}`);
}

function assertPage(response, { name, Bucket, expected, keys, prefixes = [], truncated, input, v2 }) {
  assertStatus(response, 200, name);
  assert.equal(response.Name, Bucket, `${name} bucket name`);
  assert.equal(response.IsTruncated, truncated, `${name} IsTruncated`);
  if (input.Prefix !== undefined) assert.equal(response.Prefix, input.Prefix, `${name} prefix`);
  if (input.Delimiter !== undefined) assert.equal(response.Delimiter, input.Delimiter, `${name} delimiter`);
  if (input.MaxKeys !== undefined) assert.equal(response.MaxKeys, input.MaxKeys, `${name} MaxKeys`);
  for (const parameter of v2 ? ['StartAfter', 'ContinuationToken'] : ['Marker']) {
    if (input[parameter] !== undefined) assert.equal(response[parameter], input[parameter], `${name} ${parameter}`);
  }
  assert.ok(response.Contents === undefined || Array.isArray(response.Contents), `${name} contents array`);
  assert.ok(response.CommonPrefixes === undefined || Array.isArray(response.CommonPrefixes), `${name} common prefixes array`);
  const contents = response.Contents ?? [];
  assert.deepEqual(contents.map(item => item.Key), keys, `${name} object keys`);
  assert.deepEqual((response.CommonPrefixes ?? []).map(item => item.Prefix), prefixes, `${name} common prefixes`);
  for (const item of contents) {
    const object = expected.get(item.Key);
    assert.equal(item.Size, object.Size, `${name} size for ${item.Key}`);
    assert.equal(item.ETag, object.ETag, `${name} ETag for ${item.Key}`);
    assert.ok(item.LastModified instanceof Date && !Number.isNaN(item.LastModified.getTime()), `${name} LastModified for ${item.Key}`);
  }
  if (v2) assert.equal(response.KeyCount, keys.length + prefixes.length, `${name} KeyCount`);
}

async function verifyListing(client, v2) {
  const Command = v2 ? ListObjectsV2Command : ListObjectsCommand;
  const name = v2 ? 'ListObjectsV2' : 'ListObjects';

  await withBucket(client, async ({ Bucket }) => {
    const list = input => client.send(new Command({ Bucket, ...input }));
    const page = async (input, expected, keys, prefixes = [], truncated = false) => {
      const response = await list(input);
      assertPage(response, { name, Bucket, expected, keys, prefixes, truncated, input, v2 });
      return response;
    };

    await assertMissing(() => client.send(new Command({ Bucket: bucketName() })), name, 'NoSuchBucket');
    await page({}, new Map(), []);
    await withObjects(client, Bucket, async expected => {
      await page({}, expected, allKeys);
      await page({ Prefix: 'alpha/' }, expected, alphaKeys);
      await page({ Prefix: 'special/' }, expected, ['special/雪 +&%.txt', 'special/風.txt']);
      await page({ Prefix: 'missing/' }, expected, []);

      // Explicit marker/start-after is exclusive, independently of continuation.
      await page(v2 ? { StartAfter: 'alpha/two.txt' } : { Marker: 'alpha/two.txt' },
        expected, ['beta/four.txt', 'root.txt', 'special/雪 +&%.txt', 'special/風.txt']);
      await page(v2 ? { StartAfter: 'special/雪 +&%.txt' } : { Marker: 'special/雪 +&%.txt' },
        expected, ['special/風.txt']);

      async function pages(input, expectedPages) {
        let token;
        const seen = new Set();
        for (let i = 0; i < expectedPages.length; i++) {
          const request = { ...input, ...(token ? { [v2 ? 'ContinuationToken' : 'Marker']: token } : {}) };
          const { keys, prefixes = [] } = expectedPages[i];
          const truncated = i < expectedPages.length - 1;
          const response = await page(request, expected, keys, prefixes, truncated);
          if (truncated) {
            // V1 may omit NextMarker. Fall back to the last key only when
            // this page contains no rolled-up prefixes that could follow it.
            token = v2 ? response.NextContinuationToken : response.NextMarker ?? (prefixes.length === 0 ? keys.at(-1) : undefined);
            assert.ok(typeof token === 'string' && token.length > 0, `${name} continuation for truncated page`);
            assert.ok(!seen.has(token), `${name} repeated continuation`);
            seen.add(token);
          } else if (v2) {
            assert.ok(!response.NextContinuationToken, `${name} continuation on final page`);
          }
        }
      }

      await pages({ MaxKeys: 2 }, [
        { keys: ['alpha/one.txt', 'alpha/sub/second.txt'] },
        { keys: ['alpha/sub/three.txt', 'alpha/third/deep.txt'] },
        { keys: ['alpha/two.txt', 'beta/four.txt'] },
        { keys: ['root.txt', 'special/雪 +&%.txt'] },
        { keys: ['special/風.txt'] },
      ]);
      await pages({ Prefix: 'special/', MaxKeys: 1 }, [
        { keys: ['special/雪 +&%.txt'] },
        { keys: ['special/風.txt'] },
      ]);
      await pages({ Prefix: 'alpha/', MaxKeys: 2 }, [
        { keys: ['alpha/one.txt', 'alpha/sub/second.txt'] },
        { keys: ['alpha/sub/three.txt', 'alpha/third/deep.txt'] },
        { keys: ['alpha/two.txt'] },
      ]);
      await page({ Prefix: 'alpha/', Delimiter: '/' }, expected,
        ['alpha/one.txt', 'alpha/two.txt'], ['alpha/sub/', 'alpha/third/']);
      await pages({ Prefix: 'alpha/', Delimiter: '/', MaxKeys: 1 }, [
        { keys: ['alpha/one.txt'] },
        { keys: [], prefixes: ['alpha/sub/'] },
        { keys: [], prefixes: ['alpha/third/'] },
        { keys: ['alpha/two.txt'] },
      ]);
    });
  });
}

export default [
  { name: 'ListObjects', run: ({ client }) => verifyListing(client, false) },
  { name: 'ListObjectsV2', run: ({ client }) => verifyListing(client, true) },
];
