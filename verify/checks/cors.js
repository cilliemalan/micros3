import assert from 'node:assert/strict';
import { DeleteBucketCommand, DeleteBucketCorsCommand, GetBucketCorsCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3';
import { assertMissing, assertStatus, ignoreMissing, status, withBucket, withCleanup } from './resources.js';

const rules = [
  {
    ID: 'read-only',
    AllowedOrigins: ['https://app.example.com', 'https://*.example.net'],
    AllowedMethods: ['GET', 'HEAD'],
    AllowedHeaders: ['authorization', 'x-custom-*'],
    ExposeHeaders: ['ETag', 'x-amz-meta-owner'],
    MaxAgeSeconds: 3600,
  },
  {
    ID: 'write',
    AllowedOrigins: ['https://uploader.example.org'],
    AllowedMethods: ['PUT', 'POST', 'DELETE'],
    MaxAgeSeconds: 0,
  },
];
const replacement = [{ AllowedOrigins: ['*'], AllowedMethods: ['GET'] }];
const manyRules = count => Array.from({ length: count }, (_, i) => ({
  ID: `rule-${i}`, AllowedOrigins: ['https://example.com'], AllowedMethods: ['GET'],
}));

const invalidConfigurations = [
  ['unsupported methods', [{ AllowedOrigins: ['https://example.com'], AllowedMethods: ['TRACE'] }]],
  ['a rule without origins', [{ AllowedMethods: ['GET'] }]],
  ['a rule without methods', [{ AllowedOrigins: ['https://example.com'] }]],
  ['an empty configuration', []],
  ['more than 100 rules', manyRules(101)],
];

async function withCorsCleanup(client, Bucket, run) {
  // Even a failed PUT can have stored a configuration before its response was lost.
  return withCleanup(run, () => ignoreMissing(
    () => client.send(new DeleteBucketCorsCommand({ Bucket })), ['NoSuchBucket'],
  ), `CORS configuration in bucket ${Bucket}`);
}

async function withMissingBucket(client, run) {
  // Use a bucket we created and deleted, so an incorrectly accepted request
  // that recreates it can be cleaned up without deleting a name collision.
  return withBucket(client, async ({ Bucket }) => withCorsCleanup(client, Bucket, async () => {
    assertStatus(await client.send(new DeleteBucketCommand({ Bucket })), 204, 'DeleteBucket setup');
    return run(Bucket);
  }));
}

async function put(client, Bucket, CORSRules) {
  const response = await client.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules } }));
  assertStatus(response, 200, 'PutBucketCors');
}

function normalizedRules(rules) {
  // Rule order matters for matching; order within each rule's lists does not.
  return rules?.map(rule => {
    const normalized = { ...rule };
    for (const field of ['AllowedOrigins', 'AllowedMethods', 'AllowedHeaders', 'ExposeHeaders']) {
      if (normalized[field] !== undefined) normalized[field] = [...normalized[field]].sort();
    }
    return normalized;
  });
}

async function expectRules(client, Bucket, expected) {
  const response = await client.send(new GetBucketCorsCommand({ Bucket }));
  assertStatus(response, 200, 'GetBucketCors');
  assert.deepEqual(normalizedRules(response.CORSRules), normalizedRules(expected), 'CORS rules');
}

async function expectNoCors(client, Bucket) {
  await assert.rejects(() => client.send(new GetBucketCorsCommand({ Bucket })), error => {
    assert.equal(status(error), 404, 'GetBucketCors without configuration HTTP status');
    assert.equal(error.name, 'NoSuchCORSConfiguration', 'GetBucketCors without configuration error code');
    return true;
  }, 'GetBucketCors should reject a bucket without a CORS configuration');
}

export default [
  { name: 'PutBucketCors', async run({ client }) {
    await withBucket(client, async ({ Bucket }) => withCorsCleanup(client, Bucket, async () => {
      await put(client, Bucket, rules);
      await expectRules(client, Bucket, rules);
      await put(client, Bucket, replacement);
      await expectRules(client, Bucket, replacement);
      await withMissingBucket(client, missing => assertMissing(() => client.send(new PutBucketCorsCommand({
        Bucket: missing, CORSConfiguration: { CORSRules: rules },
      })), 'PutBucketCors', 'NoSuchBucket'));
    }));
  } },
  { name: 'CORS configurations are isolated between buckets', async run({ client }) {
    await withBucket(client, async ({ Bucket: first }) => withCorsCleanup(client, first, async () => {
      await withBucket(client, async ({ Bucket: second }) => withCorsCleanup(client, second, async () => {
        await put(client, first, rules);
        await expectNoCors(client, second);
        await put(client, second, replacement);
        await expectRules(client, first, rules);
        await expectRules(client, second, replacement);
        assertStatus(await client.send(new DeleteBucketCorsCommand({ Bucket: second })), 204, 'DeleteBucketCors');
        await expectNoCors(client, second);
        await expectRules(client, first, rules);
        await put(client, second, replacement);
        assertStatus(await client.send(new DeleteBucketCorsCommand({ Bucket: first })), 204, 'DeleteBucketCors');
        await expectNoCors(client, first);
        await expectRules(client, second, replacement);
      }));
    }));
  } },
  { name: 'PutBucketCors accepts 100 rules', async run({ client }) {
    await withBucket(client, async ({ Bucket }) => withCorsCleanup(client, Bucket, async () => {
      const maximum = manyRules(100);
      await put(client, Bucket, maximum);
      await expectRules(client, Bucket, maximum);
    }));
  } },
  ...invalidConfigurations.map(([description, invalidRules]) => ({
    name: `PutBucketCors rejects ${description}`,
    async run({ client }) {
      await withBucket(client, async ({ Bucket }) => withCorsCleanup(client, Bucket, async () => {
        await put(client, Bucket, rules);
        await assert.rejects(() => client.send(new PutBucketCorsCommand({
          Bucket, CORSConfiguration: { CORSRules: invalidRules },
        })), error => {
          assert.equal(status(error), 400, 'Invalid CORS configuration HTTP status');
          return true;
        }, `PutBucketCors should reject ${description}`);
        await expectRules(client, Bucket, rules);
      }));
    },
  })),
  { name: 'GetBucketCors', async run({ client }) {
    await withBucket(client, async ({ Bucket }) => withCorsCleanup(client, Bucket, async () => {
      await expectNoCors(client, Bucket);
      await put(client, Bucket, rules);
      await expectRules(client, Bucket, rules);
      await withMissingBucket(client, missing => assertMissing(
        () => client.send(new GetBucketCorsCommand({ Bucket: missing })), 'GetBucketCors', 'NoSuchBucket',
      ));
    }));
  } },
  { name: 'DeleteBucketCors', async run({ client }) {
    await withBucket(client, async ({ Bucket }) => withCorsCleanup(client, Bucket, async () => {
      await put(client, Bucket, rules);
      assertStatus(await client.send(new DeleteBucketCorsCommand({ Bucket })), 204, 'DeleteBucketCors');
      await expectNoCors(client, Bucket);
      assertStatus(await client.send(new DeleteBucketCorsCommand({ Bucket })), 204, 'Repeat DeleteBucketCors');
      await expectNoCors(client, Bucket);
      await put(client, Bucket, replacement);
      await expectRules(client, Bucket, replacement);
      await withMissingBucket(client, missing => assertMissing(
        () => client.send(new DeleteBucketCorsCommand({ Bucket: missing })), 'DeleteBucketCors', 'NoSuchBucket',
      ));
    }));
  } },
];
