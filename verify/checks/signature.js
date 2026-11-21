// Signature checks: a request signed with the right access key ID but the
// wrong secret access key must be rejected with 403 SignatureDoesNotMatch, and
// must neither read nor change anything.
import assert from 'node:assert/strict';
import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListBucketsCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { scenario } from '../test-runner.js';
import { shareTimeouts } from '../timeouts.js';
import { assertStatus, cleanupDelete, status, withBucket, withCleanup } from './resources.js';

export const WRONG_SECRET = 'micros3-verify-wrong-secret-access-key';

// A client for the same endpoint, region and access key ID (and session token,
// if any) as `client`, which signs with a different secret access key. The
// caller destroys it.
export async function wrongSecretClient(client) {
  const credentials = await client.config.credentials();
  assert.notEqual(credentials.secretAccessKey, WRONG_SECRET, 'the configured secret must differ from the wrong one');
  const wrong = new S3Client({
    endpoint: client.config.endpoint,
    region: client.config.region,
    forcePathStyle: client.config.forcePathStyle,
    maxAttempts: 1,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: WRONG_SECRET,
      ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
    },
  });
  return shareTimeouts(client, wrong);
}

async function assertSignatureRejected(action, operation) {
  await assert.rejects(action, error => {
    assert.equal(status(error), 403, `${operation} with a wrong secret should return HTTP 403`);
    assert.equal(error.name, 'SignatureDoesNotMatch', `${operation} with a wrong secret error code`);
    return true;
  }, `${operation} with a wrong secret should be rejected`);
}

async function verifyWrongSecret(client) {
  const wrong = await wrongSecretClient(client);
  try {
    await scenario('ListBuckets', () =>
      assertSignatureRejected(() => wrong.send(new ListBucketsCommand({})), 'ListBuckets'));

    await withBucket(client, async ({ Bucket }) => {
      const Key = 'signed/雪 +&%.txt';
      const absent = 'signed/absent.txt';
      const original = 'stored with the right secret';
      await withCleanup(async () => {
        await scenario('setup', async () => {
          assertStatus(await client.send(new PutObjectCommand({ Bucket, Key, Body: original })), 200, 'PutObject setup');
        });

        await scenario('GetObject', () =>
          assertSignatureRejected(() => wrong.send(new GetObjectCommand({ Bucket, Key })), 'GetObject'));

        await scenario('PutObject overwrite', async () => {
          await assertSignatureRejected(() => wrong.send(new PutObjectCommand({ Bucket, Key, Body: 'overwritten' })), 'PutObject');
          const response = await client.send(new GetObjectCommand({ Bucket, Key }));
          assert.equal(await response.Body.transformToString(), original, 'a rejected PutObject must leave the object unchanged');
        });

        await scenario('PutObject new key', async () => {
          await assertSignatureRejected(() => wrong.send(new PutObjectCommand({ Bucket, Key: absent, Body: 'created' })), 'PutObject');
          await assert.rejects(() => client.send(new HeadObjectCommand({ Bucket, Key: absent })), error => {
            assert.equal(status(error), 404, 'a rejected PutObject must not create the object');
            return true;
          }, 'a rejected PutObject must not create the object');
        });

        await scenario('DeleteObject', async () => {
          await assertSignatureRejected(() => wrong.send(new DeleteObjectCommand({ Bucket, Key })), 'DeleteObject');
          assertStatus(await client.send(new HeadObjectCommand({ Bucket, Key })), 200, 'HeadObject after a rejected DeleteObject');
        });
      }, async () => {
        for (const key of [Key, absent]) await cleanupDelete(client, new DeleteObjectCommand({ Bucket, Key: key }));
      }, `objects in ${Bucket}`);
    });
  } finally {
    wrong.destroy();
  }
}

export default [
  { name: 'Requests signed with a wrong secret are rejected', run: ({ client }) => verifyWrongSecret(client) },
];
