import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetBucketLocationCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

import {
  assertMissing, assertStatus, bucketName, cleanupDelete, createInput, creationRejected,
  message, status, withBucket, withCleanup,
} from './resources.js';

function locationRegion(location) {
  // S3 represents us-east-1 as an empty LocationConstraint and historically
  // used "EU" for eu-west-1.
  if (location === undefined || location === null || location === '') return 'us-east-1';
  return location === 'EU' ? 'eu-west-1' : location;
}

export default [
  { name: 'CreateBucket', async run({ client }) {
    await withBucket(client, async ({ Bucket, response }) => {
      assertStatus(response, 200, 'CreateBucket');
      if (response.Location !== undefined) {
        const location = new URL(response.Location, 'https://s3.invalid');
        assert.ok(location.hostname === Bucket || location.hostname.startsWith(`${Bucket}.`)
          || location.pathname.split('/').includes(Bucket), 'CreateBucket location should identify the bucket');
      }
      assertStatus(await client.send(new HeadBucketCommand({ Bucket })), 200, 'HeadBucket after create');
    });
  } },
  { name: 'CreateBucket rejects an invalid bucket name', async run({ client }) {
    const Bucket = `micros3_verify_${randomUUID()}`; // Underscores are invalid in S3 bucket names.
    const region = await client.config.region();
    let mayExist = true;
    await withCleanup(async () => {
      let rejected = false;
      let rejection;
      try {
        await client.send(new CreateBucketCommand(createInput(Bucket, region)));
      } catch (error) {
        rejected = true;
        rejection = error;
        if (creationRejected(error)) {
          mayExist = false;
          if (error.$metadata?.attempts > 1) {
            throw new Error(`CreateBucket failed after retries for ${Bucket}; inspect for a leftover bucket: ${message(error)}`, { cause: error });
          }
        }
      }
      assert.ok(rejected, 'CreateBucket should reject an invalid bucket name');
      assert.equal(status(rejection), 400, 'Invalid bucket name should return HTTP 400');
      assert.equal(rejection.name, 'InvalidBucketName', 'CreateBucket error code');
    }, async () => {
      if (mayExist) await cleanupDelete(client, new DeleteBucketCommand({ Bucket }));
    }, `bucket ${Bucket}`);
  } },
  { name: 'CreateBucket preserves an existing bucket on repeat creation', async run({ client }) {
    await withBucket(client, async ({ Bucket, region }) => {
      const Key = 'repeat-create-check';
      const content = 'repeat creation must preserve this object';
      await withCleanup(async () => {
        await client.send(new PutObjectCommand({ Bucket, Key, Body: content }));
        if (region === 'us-east-1') {
          // S3 retains a legacy idempotent response in this region.
          assertStatus(await client.send(new CreateBucketCommand(createInput(Bucket, region))), 200, 'Repeat CreateBucket');
        } else {
          await assert.rejects(() => client.send(new CreateBucketCommand(createInput(Bucket, region))), error => {
            assert.equal(status(error), 409, 'Repeat CreateBucket HTTP status');
            assert.equal(error.name, 'BucketAlreadyOwnedByYou', 'Repeat CreateBucket error code');
            return true;
          }, 'CreateBucket should reject a bucket already owned by the caller');
        }
        const object = await client.send(new GetObjectCommand({ Bucket, Key }));
        assertStatus(object, 200, 'GetObject after repeat create');
        assert.equal(await object.Body.transformToString(), content, 'Object content after repeat create');
      }, () => cleanupDelete(client, new DeleteObjectCommand({ Bucket, Key }), ['NoSuchBucket', 'NoSuchKey']), `object ${Bucket}/${Key}`);
    });
  } },
  { name: 'ListBuckets', async run({ client }) {
    await withBucket(client, async ({ Bucket: first }) => {
      await withBucket(client, async ({ Bucket: second }) => {
        const missing = new Set([first, second]);
        let token;
        let pages = 0;
        const seen = new Set();
        do {
          assert.ok(pages++ < 1000, 'ListBuckets exceeded 1000 pages without finding the buckets');
          const response = await client.send(new ListBucketsCommand({ MaxBuckets: 1000, ContinuationToken: token }));
          assertStatus(response, 200, 'ListBuckets');
          assert.ok(response.Buckets === undefined || Array.isArray(response.Buckets), 'ListBuckets should return an array');
          for (const bucket of response.Buckets ?? []) missing.delete(bucket.Name);
          if (missing.size === 0) return;
          token = response.ContinuationToken;
          if (token) {
            assert.ok(!seen.has(token), 'ListBuckets repeated a continuation token');
            seen.add(token);
          }
        } while (token);
        assert.fail(`ListBuckets did not include ${[...missing].join(', ')}`);
      });
    });
  } },
  { name: 'HeadBucket', async run({ client }) {
    await withBucket(client, async ({ Bucket, region }) => {
      const response = await client.send(new HeadBucketCommand({ Bucket }));
      assertStatus(response, 200, 'HeadBucket');
      if (response.BucketRegion !== undefined) {
        assert.equal(response.BucketRegion, region, 'HeadBucket region');
      }
      await assertMissing(() => client.send(new HeadBucketCommand({ Bucket: bucketName() })), 'HeadBucket');
    });
  } },
  { name: 'GetBucketLocation', async run({ client }) {
    await withBucket(client, async ({ Bucket, region }) => {
      const response = await client.send(new GetBucketLocationCommand({ Bucket }));
      assertStatus(response, 200, 'GetBucketLocation');
      assert.equal(locationRegion(response.LocationConstraint), region, 'GetBucketLocation region');
      await assertMissing(() => client.send(new GetBucketLocationCommand({ Bucket: bucketName() })), 'GetBucketLocation', 'NoSuchBucket');
    });
  } },
  { name: 'DeleteBucket', async run({ client }) {
    await withBucket(client, async ({ Bucket, markDeleted }) => {
      assertStatus(await client.send(new DeleteBucketCommand({ Bucket })), 204, 'DeleteBucket');
      await assertMissing(() => client.send(new HeadBucketCommand({ Bucket })), 'HeadBucket after delete');
      markDeleted();
      await assertMissing(() => client.send(new DeleteBucketCommand({ Bucket: bucketName() })), 'DeleteBucket', 'NoSuchBucket');
    });
  } },
  { name: 'DeleteBucket rejects a non-empty bucket', async run({ client }) {
    await withBucket(client, async ({ Bucket }) => {
      const Key = 'non-empty-check';
      const content = 'bucket deletion must preserve this object';
      await withCleanup(async () => {
        await client.send(new PutObjectCommand({ Bucket, Key, Body: content }));
        await assert.rejects(() => client.send(new DeleteBucketCommand({ Bucket })), error => {
          assert.equal(status(error), 409, 'DeleteBucket on a non-empty bucket should return HTTP 409');
          assert.equal(error.name, 'BucketNotEmpty', 'DeleteBucket error code');
          return true;
        }, 'DeleteBucket should reject a non-empty bucket');
        assertStatus(await client.send(new HeadBucketCommand({ Bucket })), 200, 'HeadBucket after rejected delete');
        const object = await client.send(new GetObjectCommand({ Bucket, Key }));
        assertStatus(object, 200, 'GetObject after rejected delete');
        assert.equal(await object.Body.transformToString(), content, 'Object content after rejected delete');
      }, () => cleanupDelete(client, new DeleteObjectCommand({ Bucket, Key }), ['NoSuchBucket', 'NoSuchKey']), `object ${Bucket}/${Key}`);
    });
  } },
];
