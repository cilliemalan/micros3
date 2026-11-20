import assert from 'node:assert/strict';
import { DeleteBucketCommand, GetBucketEncryptionCommand } from '@aws-sdk/client-s3';
import { assertMissing, assertStatus, withBucket } from './resources.js';

export default [
  { name: 'GetBucketEncryption', async run({ client }) {
    await withBucket(client, async ({ Bucket }) => {
      const response = await client.send(new GetBucketEncryptionCommand({ Bucket }));
      assertStatus(response, 200, 'GetBucketEncryption');
      const rules = response.ServerSideEncryptionConfiguration?.Rules;
      assert.ok(Array.isArray(rules), 'GetBucketEncryption must return encryption rules');
      assert.equal(rules.length, 1, 'A new bucket must have exactly one default encryption rule');
      const rule = rules[0];
      assert.equal(rule?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm, 'AES256', 'Default encryption algorithm');
      assert.equal(rule.ApplyServerSideEncryptionByDefault.KMSMasterKeyID, undefined, 'SSE-S3 must not specify a KMS key');
      // Some services omit the optional flag; both omitted and false mean disabled.
      assert.ok(rule.BucketKeyEnabled === undefined || rule.BucketKeyEnabled === false, 'SSE-S3 must not enable an S3 Bucket Key');
    });
  } },
  { name: 'GetBucketEncryption rejects a missing bucket', async run({ client }) {
    // Keep cleanup armed after deletion, in case a broken GET recreates the bucket.
    await withBucket(client, async ({ Bucket }) => {
      assertStatus(await client.send(new DeleteBucketCommand({ Bucket })), 204, 'DeleteBucket setup');
      await assertMissing(() => client.send(new GetBucketEncryptionCommand({ Bucket })), 'GetBucketEncryption', 'NoSuchBucket');
    });
  } },
];
