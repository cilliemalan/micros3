import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import { S3Client } from '@aws-sdk/client-s3';
import checks, { crc32Base64, etagOf } from '../checks/integrity.js';
import objectChecks from '../checks/object.js';

const names = ['Object ETags are MD5 digests', 'PutObject validates Content-MD5', 'PutObject validates checksums'];
const run = name => checks.find(check => check.name === name).run;

const errorXml = code => `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>failed</Message><RequestId>request</RequestId></Error>`;
const digest = (algorithm, body) => createHash(algorithm).update(body).digest('base64');

// A minimal path-style S3 service over HTTP, so requests pass through the real
// SDK's serialization, signing and checksum middleware. `options.hook(request,
// reply, service)` may alter a reply before it is sent; other options disable
// individual validations or change how ETags are calculated.
async function s3Fixture(t, options = {}) {
  const service = { buckets: new Map(), requests: [] };
  const etag = options.etag ?? etagOf;
  const fail = (statusCode, code) => ({ statusCode, headers: { 'content-type': 'application/xml' }, body: errorXml(code) });
  function objectHeaders(object) {
    return {
      etag: object.etag, 'content-type': object.type ?? 'binary/octet-stream', 'last-modified': new Date(0).toUTCString(),
      ...(object.sse && { 'x-amz-server-side-encryption': object.sse }),
      ...object.checksums,
    };
  }
  function handle(request, body) {
    const url = new URL(request.url, 'http://fixture');
    const [, bucket, ...rest] = url.pathname.split('/');
    const key = rest.join('/') ? rest.map(decodeURIComponent).join('/') : undefined;
    const headers = request.headers;
    const objects = service.buckets.get(bucket);
    if (key === undefined) {
      if (request.method === 'PUT') {
        service.buckets.set(bucket, new Map());
        return { statusCode: 200 };
      }
      if (!objects) return fail(404, 'NoSuchBucket');
      if (request.method === 'HEAD') return { statusCode: 200 };
      if (request.method === 'DELETE') {
        if (objects.size) return fail(409, 'BucketNotEmpty');
        service.buckets.delete(bucket);
        return { statusCode: 204 };
      }
    }
    if (!objects) return fail(404, 'NoSuchBucket');
    if (request.method === 'DELETE') {
      objects.delete(key);
      return { statusCode: 204 };
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      const object = objects.get(key);
      if (!object) return fail(404, 'NoSuchKey');
      return { statusCode: 200, headers: { ...objectHeaders(object), 'content-length': object.body.length }, body: object.body };
    }
    if (request.method === 'PUT' && headers['x-amz-copy-source']) {
      const [sourceBucket, ...sourceKey] = headers['x-amz-copy-source'].replace(/^\//, '').split('/');
      const source = service.buckets.get(sourceBucket)?.get(sourceKey.map(decodeURIComponent).join('/'));
      if (!source) return fail(404, 'NoSuchKey');
      const sse = headers['x-amz-server-side-encryption'];
      const type = headers['x-amz-metadata-directive'] === 'REPLACE' ? headers['content-type'] : source.type;
      const object = { ...source, type, etag: (options.copyEtag ?? etag)(source.body), sse };
      objects.set(key, object);
      return { statusCode: 200, headers: { 'content-type': 'application/xml', ...(sse && { 'x-amz-server-side-encryption': sse }) },
        body: `<?xml version="1.0" encoding="UTF-8"?>\n<CopyObjectResult><ETag>${object.etag}</ETag><LastModified>2024-01-02T00:00:00.000Z</LastModified></CopyObjectResult>` };
    }
    if (request.method === 'PUT') {
      const md5 = headers['content-md5'];
      if (md5 !== undefined && !options.ignoreMd5) {
        if (Buffer.from(md5, 'base64').length !== 16) return fail(400, 'InvalidDigest');
        if (md5 !== digest('md5', body)) return fail(400, options.md5Code ?? 'BadDigest');
      }
      const checksums = {};
      for (const [name, calculate] of [['crc32', crc32Base64], ['sha256', b => digest('sha256', b)]]) {
        const value = headers[`x-amz-checksum-${name}`];
        if (value === undefined) continue;
        if (value !== calculate(body) && !options.ignoreChecksums) return fail(400, 'BadDigest');
        checksums[`x-amz-checksum-${name}`] = value;
      }
      const object = { body, type: headers['content-type'], etag: etag(body), sse: headers['x-amz-server-side-encryption'], checksums };
      objects.set(key, object);
      return { statusCode: 200, headers: { etag: object.etag, ...(object.sse && { 'x-amz-server-side-encryption': object.sse }), ...checksums } };
    }
    throw new Error(`Unexpected ${request.method} ${request.url}`);
  }
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      service.requests.push({ method: request.method, url: request.url, headers: request.headers });
      const reply = { headers: {}, ...handle(request, body) };
      options.hook?.(request, reply, service);
      response.writeHead(reply.statusCode, { 'x-amz-request-id': 'request', ...reply.headers });
      response.end(request.method === 'HEAD' ? undefined : reply.body);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${server.address().port}`, region: 'us-east-1', forcePathStyle: true, maxAttempts: 1,
    credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
  });
  t.after(() => client.destroy());
  return { client, service };
}

test('CRC-32 matches an independent implementation', () => {
  for (const body of [Buffer.alloc(0), Buffer.from('hello'), Buffer.from([0, 255, 128, 1])]) {
    const expected = Buffer.alloc(4);
    expected.writeUInt32BE(crc32(body));
    assert.equal(crc32Base64(body), expected.toString('base64'));
  }
  assert.equal(etagOf(Buffer.alloc(0)), '"d41d8cd98f00b204e9800998ecf8427e"');
});

test('integrity checks are part of the object suite', () => {
  assert.deepEqual(checks.map(check => check.name), names);
  for (const name of names) assert.ok(objectChecks.some(check => check.name === name), name);
});

test('integrity checks pass against a conforming service over HTTP and clean up', async t => {
  const { client, service } = await s3Fixture(t);
  for (const name of names) await run(name)({ client });
  assert.equal(service.buckets.size, 0);
  const puts = service.requests.filter(r => r.method === 'PUT');
  // The mismatched values must reach the wire unchanged rather than be recalculated by the SDK.
  assert.ok(puts.some(r => r.headers['content-md5'] === digest('md5', Buffer.from('different content'))), 'mismatched Content-MD5 sent');
  assert.ok(puts.some(r => r.headers['x-amz-checksum-crc32'] === crc32Base64(Buffer.from('different content'))), 'mismatched CRC32 sent');
  assert.ok(puts.some(r => r.headers['x-amz-checksum-sha256'] === digest('sha256', Buffer.from('different content'))), 'mismatched SHA256 sent');
  assert.ok(puts.some(r => r.headers['x-amz-server-side-encryption'] === 'AES256'), 'SSE-S3 requested');
});

test('ETag check rejects self-consistent but incorrect ETags and cleans up', async t => {
  const hex = body => `"${body.toString('hex')}"`;
  const cases = [
    ['hex ETags', { etag: hex }, /MD5/],
    ['unquoted ETags', { etag: body => etagOf(body).slice(1, -1) }, /MD5/],
    ['copy ETags', { copyEtag: () => '"0123456789abcdef0123456789abcdef"' }, /CopyObject.*MD5/],
    ['GET ETag', { hook: (request, reply) => { if (request.method === 'GET' && reply.headers.etag) reply.headers.etag = '"wrong"'; } }, /GetObject.*ETag/],
    ['HEAD ETag', { hook: (request, reply) => { if (request.method === 'HEAD' && reply.headers.etag) reply.headers.etag = '"wrong"'; } }, /HeadObject.*ETag/],
    ['empty ETag', { etag: body => body.length ? etagOf(body) : '"empty"' }, /empty ETag/],
    ['stale overwrite ETag', { hook: (request, reply, service) => {
      const stale = '"' + createHash('md5').update(Buffer.from([0, 1, 2, 127, 128, 200, 254, 255])).digest('hex') + '"';
      if (request.method === 'HEAD' && request.url.includes('plain') && service.requests.filter(r => r.method === 'PUT').length > 5) reply.headers.etag = stale;
    } }, /after overwrite ETag/],
    ['missing SSE response header', { hook: (request, reply) => { delete reply.headers['x-amz-server-side-encryption']; } }, /ServerSideEncryption/],
  ];
  for (const [label, options, pattern] of cases) {
    const { client, service } = await s3Fixture(t, options);
    await assert.rejects(run(names[0])({ client }), pattern, label);
    assert.equal(service.buckets.size, 0, label);
  }
});

test('Content-MD5 check detects missing or incorrect validation and cleans up', async t => {
  const cases = [
    ['ignored Content-MD5', { ignoreMd5: true }, /should reject with BadDigest/],
    ['wrong error code', { md5Code: 'InvalidDigest' }, /error code/],
    ['wrong status', { hook: (request, reply) => { if (reply.statusCode === 400) reply.statusCode = 403; } }, /HTTP 400/],
    ['rejected but stored', { hook: (request, reply, service) => {
      if (reply.statusCode === 400 && request.url.includes('/mismatched')) {
        const [bucket] = [...service.buckets.keys()];
        service.buckets.get(bucket).set('mismatched', { body: Buffer.from('x'), etag: etagOf(Buffer.from('x')), checksums: {} });
      }
    } }, /after mismatched Content-MD5/],
    ['rejected overwrite applied', { hook: (request, reply, service) => {
      if (reply.statusCode === 400 && request.url.includes('/existing')) {
        const [bucket] = [...service.buckets.keys()];
        const body = Buffer.from('content protected by Content-MD5');
        service.buckets.get(bucket).set('existing', { body, etag: etagOf(body), checksums: {} });
      }
    } }, /after rejected overwrite content/],
  ];
  for (const [label, options, pattern] of cases) {
    const { client, service } = await s3Fixture(t, options);
    await assert.rejects(run(names[1])({ client }), pattern, label);
    assert.equal(service.buckets.size, 0, label);
  }
});

test('checksum check detects missing validation, unreported checksums and cleans up', async t => {
  const cases = [
    ['ignored checksums', { ignoreChecksums: true }, /should reject with BadDigest/],
    ['unreported CRC32', { hook: (request, reply) => { if (request.method === 'PUT') delete reply.headers['x-amz-checksum-crc32']; } }, /ChecksumCRC32/],
    ['wrong SHA256', { hook: (request, reply) => { if (request.method === 'PUT' && reply.headers['x-amz-checksum-sha256']) reply.headers['x-amz-checksum-sha256'] = digest('sha256', Buffer.from('x')); } }, /ChecksumSHA256/],
    ['wrong status', { hook: (request, reply) => { if (reply.statusCode === 400) reply.statusCode = 422; } }, /HTTP 400/],
  ];
  for (const [label, options, pattern] of cases) {
    const { client, service } = await s3Fixture(t, options);
    await assert.rejects(run(names[2])({ client }), pattern, label);
    assert.equal(service.buckets.size, 0, label);
  }
});
