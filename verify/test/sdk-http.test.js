// SDK-to-HTTP integration tests. The verifier's checks run through the real
// AWS SDK (request signing, serialization, XML parsing and error handling)
// against an in-memory S3 fixture that verifies each request's Signature
// Version 4 independently of the SDK. The other offline tests mostly replace
// `client.send` and therefore bypass all of this.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import {
  CopyObjectCommand, CreateBucketCommand, GetObjectCommand, HeadObjectCommand, ListBucketsCommand, PutObjectCommand,
} from '@aws-sdk/client-s3';
import bucketChecks from '../checks/bucket.js';
import encryptionChecks from '../checks/encryption.js';
import objectChecks from '../checks/object.js';
import { rawExchange, signedRequest } from '../checks/conditional.js';
import { assertS3Error } from '../checks/resources.js';
import { runVerification } from '../verification.js';
import { runTests } from '../test-runner.js';
import { S3Fixture, errorXml } from './fixtures/s3-http.js';

const quiet = () => {
  const lines = [];
  return { lines, log: line => lines.push(line), error: line => lines.push(line) };
};

async function fixture(t) {
  const service = await new S3Fixture().start(t);
  const client = service.client();
  t.after(() => client.destroy());
  return { service, client };
}

const check = (checks, name) => {
  const found = checks.find(item => item.name === name);
  assert.ok(found, `check ${name}`);
  return found;
};

// Runs one check and returns its failure message, or undefined if it passed.
async function outcome(client, checkDefinition) {
  try {
    await checkDefinition.run({ client });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

test('bucket, object and encryption checks pass through the real SDK with every request signed', async t => {
  const service = await new S3Fixture().start(t);
  const output = quiet();
  const suites = [
    { name: 'Bucket operations', tests: bucketChecks },
    { name: 'Object operations', tests: objectChecks },
    { name: 'Encryption', tests: encryptionChecks },
  ];
  // runVerification destroys the client it is given.
  const passed = await runVerification(service.client(), suites, output, { requestTimeout: 10_000, runTimeout: 120_000, cleanupGrace: 10_000 });
  assert.ok(passed, output.lines.join('\n'));
  assert.ok(output.lines.some(line => line.includes(`${bucketChecks.length + objectChecks.length + encryptionChecks.length} passed, 0 failed`)), output.lines.join('\n'));

  const unsigned = service.requests.filter(record => record.signature !== 'valid');
  assert.deepEqual(unsigned.map(record => `${record.method} ${record.url}: ${record.signature}`), []);
  const operations = new Set(service.requests.map(record => record.operation));
  for (const operation of ['ListBuckets', 'CreateBucket', 'HeadBucket', 'GetBucketLocation', 'DeleteBucket', 'GetBucketEncryption',
    'PutObject', 'GetObject', 'HeadObject', 'CopyObject', 'DeleteObject', 'DeleteObjects']) {
    assert.ok(operations.has(operation), `${operation} was exercised over HTTP`);
  }
  assert.deepEqual([...service.buckets.keys()], [], 'all buckets were cleaned up');
});

test('the fixture rejects requests signed with the wrong secret, and the verifier reports it', async t => {
  const service = await new S3Fixture().start(t);
  const output = quiet();
  const client = service.client({ credentials: { accessKeyId: 'fixture-key', secretAccessKey: 'wrong-secret' } });
  assert.equal(await runVerification(client, [{ name: 'Bucket operations', tests: bucketChecks }], output), false);
  assert.ok(output.lines.includes('Initial check failed'), output.lines.join('\n'));
  assert.ok(output.lines.some(line => /signature does not match/.test(line)), output.lines.join('\n'));
  assert.deepEqual(service.requests.map(record => [record.operation, record.status]), [[undefined, 403]]);
});

test('raw replays of SDK-signed requests are accepted unchanged and rejected when tampered with', async t => {
  const { service, client } = await fixture(t);
  const Bucket = 'raw-signing';
  const Key = 'wire/雪 +&%?#.bin';
  await client.send(new CreateBucketCommand({ Bucket }));
  await client.send(new PutObjectCommand({ Bucket, Key, Body: 'signed content' }));

  const signed = () => signedRequest(client, new GetObjectCommand({ Bucket, Key, Range: 'bytes=0-5' }));
  const unchanged = await rawExchange(client, await signed(), 'GetObject');
  assert.equal(unchanged.status, 206);
  assert.ok(unchanged.trailing.includes('signed'), 'raw GET returns the range');

  const tamper = {
    'path encoding': request => { request.path = request.path.replace('%20', '+'); },
    'added query parameter': request => { request.query = { ...request.query, partNumber: '1' }; },
    'changed signed header': request => { request.headers.range = 'bytes=0-6'; },
    'changed date': request => { request.headers['x-amz-date'] = request.headers['x-amz-date'].replace(/\d{2}Z$/, '59Z'); },
    'removed signature': request => { delete request.headers.authorization; },
  };
  for (const [label, change] of Object.entries(tamper)) {
    const request = await signed();
    change(request);
    const result = await rawExchange(client, request, label);
    assert.equal(result.status, 403, `${label} is rejected`);
    assert.match(result.trailing.toString(), /<Code>(SignatureDoesNotMatch|AccessDenied)<\/Code>/, label);
  }

  // A body that differs from the signed payload hash is rejected.
  const put = await signedRequest(client, new PutObjectCommand({ Bucket, Key, Body: 'original body' }));
  assert.match(put.headers['x-amz-content-sha256'], /^[0-9a-f]{64}$/, 'the SDK signs the payload over HTTP');
  const status = await new Promise((resolve, reject) => {
    const headers = { ...put.headers };
    delete headers['content-length'];
    const req = httpRequest({ host: put.hostname, port: put.port, method: put.method, path: put.path, headers }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on('error', reject);
    req.end('altered body!');
  });
  assert.equal(status, 400);
  assert.equal((await client.send(new GetObjectCommand({ Bucket, Key }))).ContentLength, 'signed content'.length, 'the altered upload was not stored');
  assert.ok(service.requests.filter(record => record.signature !== 'valid').length >= Object.keys(tamper).length + 1);
});

test('checks attribute XML error codes and statuses parsed by the SDK', async t => {
  const cases = [
    ['GetBucketLocation', bucketChecks, info => info.operation === 'GetBucketLocation' && !info.service.buckets.has(info.bucket)
      && { status: 404, body: errorXml('NoSuchKey') }, /GetBucketLocation error code/],
    ['DeleteBucket rejects a non-empty bucket', bucketChecks, info => info.operation === 'DeleteBucket' && info.service.buckets.get(info.bucket)?.objects.size
      && { status: 400, body: errorXml('BucketNotEmpty') }, /HTTP 409/],
    ['CreateBucket rejects an invalid bucket name', bucketChecks, info => info.operation === 'CreateBucket' && info.bucket.includes('_')
      && { status: 400, body: '<html><body>Bad Request</body></html>', headers: { 'content-type': 'text/html' } }, /CreateBucket error code/],
    ['GetBucketEncryption rejects a missing bucket', encryptionChecks, info => info.operation === 'GetBucketEncryption'
      && { status: 404, body: '' }, /GetBucketEncryption error code/],
    ['DeleteObject', objectChecks, info => info.operation === 'GetObject' && !info.service.buckets.get(info.bucket)?.objects.has(info.key)
      && { status: 404, body: errorXml('NoSuchBucket') }, /error code/],
  ];
  for (const [name, checks, defect, pattern] of cases) {
    const { service, client } = await fixture(t);
    service.intercept = (info, next) => defect({ ...info, service }) || next();
    const failure = await outcome(client, check(checks, name));
    assert.match(failure ?? 'passed', pattern, name);
    assert.deepEqual([...service.buckets.keys()], [], `${name} cleaned up`);
  }
});

test('checks detect incorrect XML response serialization', async t => {
  const cases = [
    ['DeleteObjects', objectChecks, 'DeleteObjects', (info, result) => (info.body.includes('<Quiet>true</Quiet>') ? result
      : { ...result, body: result.body.replace(/<Deleted>[\s\S]*<\/Deleted>/, '') }), /DeleteObjects verbose deleted keys/],
    ['DeleteObjects', objectChecks, 'DeleteObjects', (info, result) => ({ ...result,
      body: result.body.replace('</DeleteResult>', '<Error><Key>absent</Key><Code>InternalError</Code><Message>x</Message></Error></DeleteResult>') }), /errors/],
    ['GetBucketEncryption', encryptionChecks, 'GetBucketEncryption', (info, result) => ({ ...result,
      body: result.body.replace('AES256', 'aws:kms') }), /Default encryption algorithm/],
    ['GetBucketLocation', bucketChecks, 'GetBucketLocation', (info, result) => ({ ...result,
      body: result.body.replace('></LocationConstraint>', '>eu-west-2</LocationConstraint>') }), /GetBucketLocation region/],
    ['ListBuckets', bucketChecks, 'ListBuckets', (info, result) => ({ ...result,
      body: result.body.slice(0, result.body.indexOf('<Buckets>') + 20) }), /./],
    ['CopyObject', objectChecks, 'CopyObject', (info, result) => ({ ...result,
      body: result.body.replace(/<ETag>.*<\/ETag>/, '') }), /CopyObject result ETag/],
  ];
  for (const [name, checks, operation, defect, pattern] of cases) {
    const { service, client } = await fixture(t);
    service.intercept = async (info, next) => {
      const result = await next();
      return info.operation === operation && result.status === 200 ? defect(info, { ...result, body: String(result.body) }) : result;
    };
    const failure = await outcome(client, check(checks, name));
    assert.match(failure ?? 'passed', pattern, `${name}: ${failure}`);
    assert.notEqual(failure, undefined, name);
    assert.deepEqual([...service.buckets.keys()], [], `${name} cleaned up`);
  }
});

test('an error embedded in a CopyObject 200 response is accepted as an error, never as a success', async t => {
  const { service, client } = await fixture(t);
  // S3 documents that CopyObject (like CompleteMultipartUpload) can report an
  // error in the body of a 200 response; the SDK rethrows it as a 503.
  service.intercept = (info, next) => (info.operation === 'CopyObject'
    ? { status: 200, body: errorXml('InternalError', 'copy failed') } : next());
  const Bucket = 'embedded-error';
  await client.send(new CreateBucketCommand({ Bucket }));
  await client.send(new PutObjectCommand({ Bucket, Key: 'source', Body: 'x' }));
  await assertS3Error(client, new CopyObjectCommand({ Bucket, Key: 'copy', CopySource: `${Bucket}/source` }), 500, 'InternalError', 'CopyObject');
  await assert.rejects(assertS3Error(client, new CopyObjectCommand({ Bucket, Key: 'copy', CopySource: `${Bucket}/source` }), 500, 'NoSuchKey', 'CopyObject'), /error code/);
  await assert.rejects(client.send(new HeadObjectCommand({ Bucket, Key: 'copy' })), error => error.$metadata.httpStatusCode === 404);

  // The CopyObject check fails on an embedded error rather than reading it as a copy.
  const failure = await outcome(client, check(objectChecks, 'CopyObject'));
  assert.match(failure ?? 'passed', /copy failed|InternalError/);
  // Only the manually created bucket is left.
  assert.deepEqual([...service.buckets.keys()], [Bucket]);
});

test('runner reports SDK-level failures from the fixture per check', async t => {
  const { service, client } = await fixture(t);
  service.intercept = (info, next) => (info.operation === 'GetBucketEncryption' ? { status: 501, body: errorXml('NotImplemented') } : next());
  const output = quiet();
  const { passed, failed } = await runTests([{ name: 'Encryption', tests: encryptionChecks }], { client }, output);
  assert.equal(passed, 0);
  assert.equal(failed, 2);
  assert.ok(output.lines.some(line => /FAIL GetBucketEncryption: NotImplemented/.test(line)), output.lines.join('\n'));
  assert.deepEqual([...service.buckets.keys()], []);
  await client.send(new ListBucketsCommand({}));
});
