import assert from 'node:assert/strict';
import test from 'node:test';
import checks, { WRONG_SECRET, wrongSecretClient } from '../checks/signature.js';
import { runVerification } from '../verification.js';
import { applyTimeouts } from '../timeouts.js';
import { S3Client } from '@aws-sdk/client-s3';
import { S3Fixture, ACCESS_KEY_ID, errorXml } from './fixtures/s3-http.js';

const check = checks.find(item => item.name === 'Requests signed with a wrong secret are rejected');

const quiet = () => {
  const lines = [];
  return { lines, log: line => lines.push(line), error: line => lines.push(line) };
};

async function outcome(client) {
  try {
    await check.run({ client });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function fixture(t) {
  const service = await new S3Fixture().start(t);
  const client = service.client();
  t.after(() => client.destroy());
  return { service, client };
}

test('the wrong-secret check passes against a service that checks signatures, and cleans up', async t => {
  const service = await new S3Fixture().start(t);
  const output = quiet();
  const passed = await runVerification(service.client(), [{ name: 'Authentication', tests: checks }], output,
    { requestTimeout: 10_000, runTimeout: 60_000, cleanupGrace: 10_000 });
  assert.ok(passed, output.lines.join('\n'));
  const rejected = service.requests.filter(record => record.signature !== 'valid');
  assert.deepEqual(rejected.map(record => [record.method, record.signature, record.status]), [
    ['GET', 'signature does not match', 403],
    ['GET', 'signature does not match', 403],
    ['PUT', 'signature does not match', 403],
    ['PUT', 'signature does not match', 403],
    ['DELETE', 'signature does not match', 403],
  ]);
  for (const record of rejected) {
    assert.match(record.headers.authorization, new RegExp(`Credential=${ACCESS_KEY_ID}/`), 'the access key ID is kept');
  }
  assert.deepEqual([...service.buckets.keys()], [], 'all buckets were cleaned up');
});

test('the wrong-secret client keeps the endpoint, region, key ID and timeouts', async t => {
  const { client } = await fixture(t);
  const unbounded = await wrongSecretClient(client);
  t.after(() => unbounded.destroy());
  assert.equal(unbounded.send, S3Client.prototype.send, 'no timeouts to share');
  applyTimeouts(client, { requestTimeout: 10_000 });
  const wrong = await wrongSecretClient(client);
  t.after(() => wrong.destroy());
  assert.notEqual(wrong.send, S3Client.prototype.send, 'the timeouts are shared');
  const credentials = await wrong.config.credentials();
  assert.equal(credentials.accessKeyId, ACCESS_KEY_ID);
  assert.equal(credentials.secretAccessKey, WRONG_SECRET);
  assert.equal(await wrong.config.region(), await client.config.region());
  assert.deepEqual(await wrong.config.endpoint(), await client.config.endpoint());
});

test('the wrong-secret check fails when a wrong signature is accepted', async t => {
  const { service, client } = await fixture(t);
  service.ignoreSignatures = true;
  assert.match(await outcome(client), /^ListBuckets: .*ListBuckets with a wrong secret should be rejected/);
  assert.deepEqual([...service.buckets.keys()], []);
});

test('the wrong-secret check names the scenario and the defect', async t => {
  const defects = [
    // A rejected write that is applied anyway.
    [/^PutObject overwrite: a rejected PutObject must leave the object unchanged/, (service, info, next) => {
      if (info.operation === 'PutObject' && info.signatureProblem) {
        return next().then(() => ({ status: 403, body: errorXml('SignatureDoesNotMatch') }));
      }
      return undefined;
    }],
    // The wrong error code.
    [/^GetObject: .*GetObject with a wrong secret error code/, (service, info) =>
      info.operation === 'GetObject' && info.signatureProblem ? { status: 403, body: errorXml('AccessDenied') } : undefined],
    // The wrong status.
    [/^DeleteObject: .*DeleteObject with a wrong secret should return HTTP 403/, (service, info) =>
      info.operation === 'DeleteObject' && info.signatureProblem ? { status: 400, body: errorXml('SignatureDoesNotMatch') } : undefined],
  ];
  for (const [pattern, defect] of defects) {
    const { service, client } = await fixture(t);
    service.ignoreSignatures = true;
    service.intercept = async (info, next) => (await defect(service, info, next)) ?? (info.signatureProblem
      ? { status: 403, body: errorXml('SignatureDoesNotMatch') } : next());
    assert.match(await outcome(client) ?? 'passed', pattern);
    assert.deepEqual([...service.buckets.keys()], [], `${pattern} cleans up`);
  }
});
