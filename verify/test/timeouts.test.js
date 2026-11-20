import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  GetObjectCommand, HeadBucketCommand, ListBucketsCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { withBucket } from '../checks/resources.js';
import { withUploadCleanup } from '../checks/multipart-cleanup.js';
import { runTests } from '../test-runner.js';
import { runVerification } from '../verification.js';
import {
  DEFAULT_CLEANUP_GRACE_MS, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS,
  VerifierTimeoutError, applyTimeouts, createRunDeadline, parseTimeoutSeconds, resolveTimeouts,
} from '../timeouts.js';

// A minimal S3 endpoint. `hang(request)` returns true for requests that should
// never be answered; `respond` can override the default response.
async function startS3(t, { hang = () => false, respond } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const entry = { method: request.method, path: url.pathname.replace(/(.)\/$/, '$1'), query: url.search, at: Date.now() };
    requests.push(entry);
    request.resume();
    request.on('end', () => {
      if (hang(entry)) return;
      if (respond?.(entry, response)) return;
      if (entry.method === 'GET' && entry.path === '/') {
        response.writeHead(200, { 'Content-Type': 'application/xml' });
        response.end('<ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>');
      } else if (entry.method === 'DELETE') {
        response.writeHead(204).end();
      } else if (entry.method === 'HEAD') {
        response.writeHead(404).end();
      } else {
        response.writeHead(200, { ETag: '"0"' }).end();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return { endpoint: `http://127.0.0.1:${server.address().port}`, requests };
}

function s3Client(endpoint, maxAttempts = 3) {
  return new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    maxAttempts,
    credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
  });
}

const quiet = { log() {}, error() {} };

test('timeout options are parsed in seconds with defaults and validation', () => {
  assert.deepEqual(resolveTimeouts({}), {
    requestTimeout: DEFAULT_REQUEST_TIMEOUT_MS,
    runTimeout: DEFAULT_RUN_TIMEOUT_MS,
    cleanupGrace: DEFAULT_CLEANUP_GRACE_MS,
  });
  assert.deepEqual(resolveTimeouts({ 'request-timeout': '2.5', 'run-timeout': '60', 'cleanup-grace': ' 10 ' }),
    { requestTimeout: 2500, runTimeout: 60_000, cleanupGrace: 10_000 });
  for (const value of ['', '0', '-1', 'abc', '1e3', 'Infinity', '0.0001', '3000000']) {
    assert.throws(() => parseTimeoutSeconds(value, '--run-timeout', 1), RangeError, value);
  }
  assert.throws(() => resolveTimeouts({ 'request-timeout': '0' }), /--request-timeout must be a positive number/);
});

test('a hung request times out with a status-less error, including SDK retries', async t => {
  const { endpoint, requests } = await startS3(t, { hang: request => request.method === 'HEAD' });
  const client = applyTimeouts(s3Client(endpoint), { requestTimeout: 200 });
  t.after(() => client.destroy());

  const started = Date.now();
  await assert.rejects(client.send(new HeadBucketCommand({ Bucket: 'hung' })), error => {
    assert.ok(error instanceof VerifierTimeoutError);
    assert.equal(error.message, 'HeadBucket timed out after 200 ms');
    assert.equal(error.$metadata, undefined, 'a timeout must not look like an HTTP response');
    return true;
  });
  assert.ok(Date.now() - started < 2000, 'the timeout bounds the whole operation');
  assert.equal(requests.length, 1, 'the aborted request is not retried');

  // The client remains usable for later requests.
  const listed = await client.send(new ListBucketsCommand({}));
  assert.equal(listed.$metadata.httpStatusCode, 200);
});

test('a response body that stalls is cut off by the request timeout', async t => {
  const { endpoint } = await startS3(t, {
    respond(request, response) {
      if (request.method !== 'GET' || request.path === '/') return false;
      response.writeHead(200, { 'Content-Length': '10', ETag: '"0"' });
      response.write('abc');
      return true;
    },
  });
  const client = applyTimeouts(s3Client(endpoint), { requestTimeout: 300 });
  t.after(() => client.destroy());

  const result = await client.send(new GetObjectCommand({ Bucket: 'b', Key: 'k' }));
  const started = Date.now();
  await assert.rejects(result.Body.transformToByteArray(), /GetObject timed out after 300 ms while reading the response body/);
  assert.ok(Date.now() - started < 2000);
});

test('a completed response body does not trip the timeout later', async t => {
  const { endpoint } = await startS3(t, {
    respond(request, response) {
      if (request.method !== 'GET' || request.path === '/') return false;
      response.writeHead(200, { 'Content-Length': '3', ETag: '"0"' }).end('abc');
      return true;
    },
  });
  const client = applyTimeouts(s3Client(endpoint), { requestTimeout: 100 });
  t.after(() => client.destroy());

  const result = await client.send(new GetObjectCommand({ Bucket: 'b', Key: 'k' }));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(Buffer.from(await result.Body.transformToByteArray()).toString(), 'abc');
});

test('the run timeout cancels a check, lets its cleanup finish, and skips the rest', async t => {
  const { endpoint, requests } = await startS3(t, { hang: request => request.method === 'PUT' && request.path.split('/').length === 3 });
  const client = s3Client(endpoint);
  const lines = [];
  const errors = [];
  const output = { log: line => lines.push(line), error: line => errors.push(line) };
  let bucket;
  const suites = [{ name: 'Timeouts', tests: [
    { name: 'hangs', run: ({ client }) => withBucket(client, async ({ Bucket }) => {
      bucket = Bucket;
      await client.send(new PutObjectCommand({ Bucket, Key: 'key', Body: 'x' }));
    }) },
    { name: 'later', run() { throw new Error('must not run'); } },
  ] }];

  const started = Date.now();
  const ok = await runVerification(client, suites, output,
    { requestTimeout: 10_000, runTimeout: 300, cleanupGrace: 5_000 });
  assert.equal(ok, false);
  assert.ok(Date.now() - started < 3000);
  assert.deepEqual(lines.slice(1), [
    '  FAIL hangs: PutObject cancelled: run timeout reached',
    '  NOT RUN later: run timeout reached',
    '\nResults: 0 passed, 1 failed, 1 not run',
  ]);
  assert.deepEqual(errors, ['Run timeout of 300 ms reached; 1 checks not run']);

  // Cleanup ran after the deadline: the bucket was deleted and confirmed gone.
  const put = requests.find(request => request.method === 'PUT' && request.path === `/${bucket}/key`);
  const cleanup = requests.filter(request => request.at > put.at && request.path === `/${bucket}`);
  assert.deepEqual(cleanup.map(request => request.method), ['DELETE', 'HEAD']);
});

test('cleanup that outlasts the grace period is cancelled and names the resource', async t => {
  const { endpoint, requests } = await startS3(t, {
    hang: request => request.method === 'DELETE' || (request.method === 'PUT' && request.path.split('/').length === 3),
  });
  const client = s3Client(endpoint);
  const lines = [];
  let bucket;
  const suites = [{ name: 'Timeouts', tests: [
    { name: 'hangs', run: ({ client }) => withBucket(client, async ({ Bucket }) => {
      bucket = Bucket;
      await client.send(new PutObjectCommand({ Bucket, Key: 'key', Body: 'x' }));
    }) },
  ] }];

  const started = Date.now();
  assert.equal(await runVerification(client, suites, { log: line => lines.push(line), error() {} },
    { requestTimeout: 10_000, runTimeout: 200, cleanupGrace: 300 }), false);
  assert.ok(Date.now() - started < 3000);
  const failure = lines.find(line => line.startsWith('  FAIL hangs:'));
  assert.ok(failure.includes('PutObject cancelled: run timeout reached'), failure);
  assert.ok(failure.includes(`cleanup failed for bucket ${bucket}`), failure);
  assert.ok(failure.includes('DeleteBucket cancelled: cleanup grace period expired'), failure);
  assert.ok(requests.some(request => request.method === 'DELETE' && request.path === `/${bucket}`));
});

test('a check that never settles is abandoned after the cleanup grace period', async () => {
  const deadline = createRunDeadline({ runTimeout: 100, cleanupGrace: 100 });
  const lines = [];
  const suites = [{ name: 'Timeouts', tests: [
    { name: 'stuck', run: () => new Promise(() => {}) },
    { name: 'after', run() {} },
  ] }];
  try {
    const result = await runTests(suites, {}, { log: line => lines.push(line) }, { deadline });
    assert.deepEqual(result, { passed: 0, failed: 1, notRun: 1 });
    assert.match(lines[1], /^ {2}FAIL stuck: abandoned after the run timeout and cleanup grace period; its resources may remain/);
    assert.equal(lines[2], '  NOT RUN after: run timeout reached');
  } finally {
    deadline.dispose();
  }
});

test('a timed-out upload listing during cleanup retains the bucket', async t => {
  const { endpoint, requests } = await startS3(t, {
    hang: request => request.method === 'GET' && request.query.includes('uploads'),
  });
  const client = applyTimeouts(s3Client(endpoint), { requestTimeout: 200 });
  t.after(() => client.destroy());

  let bucket;
  await assert.rejects(withBucket(client, ({ Bucket, retainForUploads }) => {
    bucket = Bucket;
    return withUploadCleanup(client, Bucket, ['key'], retainForUploads, async () => {});
  }), error => {
    assert.match(error.message, /ListMultipartUploads timed out after 200 ms/);
    assert.match(error.message, new RegExp(`bucket ${bucket} retained because multipart uploads may remain`));
    return true;
  });
  assert.ok(!requests.some(request => request.method === 'DELETE' && request.path === `/${bucket}`),
    'a bucket with possibly remaining uploads is not deleted');
  assert.ok(requests.some(request => request.method === 'DELETE' && request.path === `/${bucket}/key`),
    'object cleanup continues after the upload listing fails');
});

test('a timed-out bucket creation is still cleaned up', async t => {
  const { endpoint, requests } = await startS3(t, {
    hang: request => request.method === 'PUT' && request.path.split('/').length === 2,
  });
  const client = applyTimeouts(s3Client(endpoint), { requestTimeout: 200 });
  t.after(() => client.destroy());

  let ran = false;
  await assert.rejects(withBucket(client, () => { ran = true; }), /CreateBucket timed out after 200 ms/);
  assert.equal(ran, false);
  const created = requests.find(request => request.method === 'PUT');
  assert.deepEqual(requests.filter(request => request.path === created.path).map(request => request.method),
    ['PUT', 'DELETE', 'HEAD']);
});
