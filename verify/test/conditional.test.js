import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import test from 'node:test';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import checks, { copyConditionCases, rawExchange, readConditionCases, signedRequest } from '../checks/conditional.js';
import objectChecks from '../checks/object.js';
import { applyTimeouts } from '../timeouts.js';

const names = ['GetObject and HeadObject date conditions', 'CopyObject date conditions', 'HEAD and 304 responses have no body on the wire'];
const run = name => checks.find(check => check.name === name).run;

const errorXml = code => `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>failed</Message><RequestId>request</RequestId></Error>`;
const etagOf = body => `"${createHash('md5').update(body).digest('hex')}"`;
const seconds = date => Math.floor(date.getTime() / 1000);

// RFC 9110 section 13.2.2 evaluation order, as S3 documents it. Returns the
// failing status or undefined. `prefix` selects the copy-source headers.
function evaluate(headers, object, { prefix = '', failed = 304, options = {} }) {
  const get = name => headers[`${prefix}${name}`];
  const compare = options.compareMs ? date => date.getTime() : seconds;
  const modified = compare(object.modified);
  const ifMatch = get('if-match');
  const ifUnmodified = get('if-unmodified-since');
  const ifNoneMatch = get('if-none-match');
  const ifModified = get('if-modified-since');
  if (ifMatch !== undefined) {
    if (ifMatch !== object.etag) return 412;
  } else if (ifUnmodified !== undefined && !options.ignoreUnmodified && modified > compare(new Date(ifUnmodified))) {
    return 412;
  }
  if (options.unmodifiedOverridesMatch && ifMatch !== undefined && ifUnmodified !== undefined && modified > compare(new Date(ifUnmodified))) return 412;
  if (ifNoneMatch !== undefined) {
    if (ifNoneMatch === object.etag) return failed;
    if (options.modifiedOverridesNoneMatch && ifModified !== undefined && modified <= compare(new Date(ifModified))) return failed;
  } else if (ifModified !== undefined && !options.ignoreModified && modified <= compare(new Date(ifModified))) {
    return failed;
  }
  return undefined;
}

// A minimal path-style S3 service over HTTP, so requests pass through the real
// SDK. Objects are stored with millisecond modification times; Last-Modified
// is reported at one-second precision. `options` inject defects; `options.raw`
// replaces the response with raw bytes written to the socket.
async function s3Fixture(t, options = {}) {
  const service = { buckets: new Map(), requests: [] };
  const fail = (statusCode, code) => ({ statusCode, headers: { 'content-type': 'application/xml' }, body: errorXml(code) });
  function handle(request, body) {
    const url = new URL(request.url, 'http://fixture');
    const [, bucket, ...rest] = url.pathname.split('/');
    const key = rest.join('/') ? rest.map(decodeURIComponent).join('/') : undefined;
    const { headers } = request;
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
      const objectHeaders = { etag: object.etag, 'last-modified': object.modified.toUTCString(), 'content-type': 'application/octet-stream' };
      const failed = options.ignoreConditions ? undefined : evaluate(headers, object, { options });
      if (failed === 304) return { statusCode: 304, headers: objectHeaders };
      if (failed) return fail(failed, 'PreconditionFailed');
      const range = /^bytes=(\d+)-(\d+)$/.exec(headers.range ?? '');
      const content = range ? object.body.subarray(Number(range[1]), Number(range[2]) + 1) : object.body;
      return { statusCode: range ? 206 : 200, headers: { ...objectHeaders, 'content-length': content.length,
        ...(range && { 'content-range': `bytes ${range[1]}-${range[2]}/${object.body.length}` }) }, body: content };
    }
    if (request.method === 'PUT' && headers['x-amz-copy-source']) {
      const [sourceBucket, ...sourceKey] = headers['x-amz-copy-source'].replace(/^\//, '').split('/');
      const source = service.buckets.get(sourceBucket)?.get(sourceKey.map(decodeURIComponent).join('/'));
      if (!source) return fail(404, 'NoSuchKey');
      const failed = options.ignoreCopyConditions ? undefined
        : evaluate(headers, source, { prefix: 'x-amz-copy-source-', failed: 412, options });
      if (failed) return fail(412, options.copyCode ?? 'PreconditionFailed');
      const object = { ...source, modified: new Date() };
      objects.set(key, object);
      return { statusCode: 200, headers: { 'content-type': 'application/xml' },
        body: `<?xml version="1.0" encoding="UTF-8"?>\n<CopyObjectResult><ETag>${object.etag}</ETag><LastModified>${object.modified.toISOString()}</LastModified></CopyObjectResult>` };
    }
    if (request.method === 'PUT') {
      // Store a time with a fractional second, as a real service would.
      const now = new Date();
      const modified = new Date(Math.floor(now.getTime() / 1000) * 1000 + 500);
      objects.set(key, { body, etag: etagOf(body), modified });
      return { statusCode: 200, headers: { etag: etagOf(body) } };
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
      const raw = options.raw?.(request, reply);
      if (raw) {
        request.socket.end(raw);
        return;
      }
      response.writeHead(reply.statusCode, { 'x-amz-request-id': 'request', ...reply.headers });
      response.end(request.method === 'HEAD' || reply.statusCode === 304 ? undefined : reply.body);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  t.after(() => server.closeAllConnections());
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${server.address().port}`, region: 'us-east-1', forcePathStyle: true, maxAttempts: 1,
    credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
  });
  t.after(() => client.destroy());
  return { client, service };
}

// Raw HTTP/1.1 response bytes, optionally with bytes after the header block.
const rawResponse = (statusCode, headers, trailing = '') =>
  `HTTP/1.1 ${statusCode} X\r\n${Object.entries({ 'x-amz-request-id': 'request', connection: 'close', ...headers })
    .map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n${trailing}`;

test('conditional checks are part of the object suite', () => {
  assert.deepEqual(checks.map(check => check.name), names);
  for (const name of names) assert.ok(objectChecks.some(check => check.name === name), name);
});

test('the reference evaluation agrees with the expected outcomes', () => {
  const object = { etag: '"tag"', modified: new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 500)) };
  const at = new Date(Date.UTC(2024, 0, 2, 3, 4, 5));
  const before = new Date(at.getTime() - 86_400_000);
  const toHeaders = (conditions, prefix) => Object.fromEntries(Object.entries(conditions).map(([name, value]) => [
    prefix + name.replace(/^CopySource/, '').replace(/[A-Z]/g, (c, i) => (i ? '-' : '') + c.toLowerCase()),
    value instanceof Date ? value.toUTCString() : value]));
  for (const [conditions, expected] of readConditionCases({ etag: object.etag, at, before })) {
    assert.equal(evaluate(toHeaders(conditions, ''), object, {}) ?? 200, expected, JSON.stringify(conditions));
  }
  for (const [conditions, expected] of copyConditionCases({ etag: object.etag, at, before })) {
    assert.equal(evaluate(toHeaders(conditions, 'x-amz-copy-source-'), object, { prefix: 'x-amz-copy-source-', failed: 412 }) ?? 200,
      expected, JSON.stringify(conditions));
  }
});

test('conditional checks pass against a conforming service over HTTP and clean up', async t => {
  const { client, service } = await s3Fixture(t);
  applyTimeouts(client, { requestTimeout: 5000 });
  for (const name of names) await run(name)({ client });
  assert.equal(service.buckets.size, 0);
  // The date conditions must reach the wire as HTTP-dates.
  const sent = service.requests.flatMap(r => Object.entries(r.headers)).filter(([name]) => name.endsWith('modified-since'));
  for (const name of ['if-modified-since', 'if-unmodified-since', 'x-amz-copy-source-if-modified-since', 'x-amz-copy-source-if-unmodified-since']) {
    assert.ok(sent.some(([header]) => header === name), `${name} sent`);
  }
  for (const [, value] of sent) assert.match(value, /^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
});

test('read condition check detects incorrect evaluation and cleans up', async t => {
  const cases = [
    ['ignored conditions', { ignoreConditions: true }, /not modified since Last-Modified: .*should return HTTP 304/],
    ['millisecond comparison', { compareMs: true }, /IfModifiedSince=.*should return HTTP 304/],
    ['ignored If-Unmodified-Since', { ignoreUnmodified: true }, /modified after If-Unmodified-Since: .*IfUnmodifiedSince=.*should return HTTP 412/],
    ['ignored If-Modified-Since', { ignoreModified: true }, /IfModifiedSince=.*should return HTTP 304/],
    ['If-Unmodified-Since overrides If-Match', { unmodifiedOverridesMatch: true }, /IfMatch=.*IfUnmodifiedSince=.*should succeed, got HTTP 412/],
    ['wrong failure status', { raw: (request, reply) => reply.statusCode === 412 && rawResponse(400, { 'content-length': 0 }) }, /HTTP 412/],
  ];
  for (const [label, options, pattern] of cases) {
    const { client, service } = await s3Fixture(t, options);
    await assert.rejects(run(names[0])({ client }), pattern, label);
    assert.equal(service.buckets.size, 0, label);
  }
});

test('copy condition check detects incorrect evaluation and cleans up', async t => {
  const cases = [
    ['ignored conditions', { ignoreCopyConditions: true }, /source not modified since Last-Modified: .*should be rejected/],
    ['millisecond comparison', { compareMs: true }, /CopySourceIfModifiedSince=.*should be rejected/],
    ['If-Unmodified-Since overrides If-Match', { unmodifiedOverridesMatch: true }, /CopySourceIfMatch=.*should succeed, got HTTP 412/],
    ['wrong error code', { copyCode: 'NotModified' }, /error code/],
  ];
  for (const [label, options, pattern] of cases) {
    const { client, service } = await s3Fixture(t, options);
    await assert.rejects(run(names[1])({ client }), pattern, label);
    assert.equal(service.buckets.size, 0, label);
  }
});

test('wire check detects bodies after HEAD and 304 responses and cleans up', async t => {
  const leak = 'leaked body';
  const cases = [
    ['HEAD body', (request, reply) => request.method === 'HEAD' && reply.statusCode === 200 && !request.headers.range
      && rawResponse(200, { etag: reply.headers.etag, 'content-length': reply.headers['content-length'] }, leak), /HeadObject must not send a body/],
    ['HEAD error body', (request, reply) => request.method === 'HEAD' && reply.statusCode === 404 && request.url.includes('absent')
      && rawResponse(404, { 'content-type': 'application/xml' }, errorXml('NoSuchKey')), /HeadObject missing key must not send a body/],
    ['GET 304 body', (request, reply) => request.method === 'GET' && reply.statusCode === 304
      && rawResponse(304, { etag: reply.headers.etag }, leak), /GET 304: GetObject matching IfNoneMatch must not send a body/],
    ['chunked HEAD', (request, reply) => request.method === 'HEAD' && reply.statusCode === 304
      && rawResponse(304, { 'transfer-encoding': 'chunked' }, '0\r\n\r\n'), /HeadObject matching IfNoneMatch must not send a body/],
    ['wrong HEAD length', (request, reply) => request.method === 'HEAD' && reply.statusCode === 200 && !request.headers.range
      && rawResponse(200, { etag: reply.headers.etag, 'content-length': 0 }), /Content-Length/],
  ];
  for (const [label, raw, pattern] of cases) {
    const { client, service } = await s3Fixture(t, { raw });
    applyTimeouts(client, { requestTimeout: 5000 });
    await assert.rejects(run(names[2])({ client }), pattern, label);
    assert.equal(service.buckets.size, 0, label);
  }
});

test('raw exchange captures a signed request without sending it and reports incomplete or hung responses', async t => {
  const { client, service } = await s3Fixture(t, { raw: () => 'HTTP/1.1 200 OK\r\n' });
  const request = await signedRequest(client, new HeadObjectCommand({ Bucket: 'bucket', Key: 'a b/ü' }));
  assert.match(request.headers.authorization, /AWS4-HMAC-SHA256 /);
  assert.equal(service.requests.length, 0, 'capturing must not send the request');
  await assert.rejects(rawExchange(client, request, 'HeadObject'), /incomplete HTTP response header/);

  // A server that accepts the connection but never answers must time out.
  const sockets = new Set();
  const hung = createNetServer(socket => { sockets.add(socket); socket.on('error', () => {}); });
  await new Promise(resolve => hung.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => hung.close(resolve)); });
  applyTimeouts(client, { requestTimeout: 200 });
  await assert.rejects(rawExchange(client, { ...request, port: hung.address().port }, 'HeadObject'), /HeadObject timed out after 200 ms/);
});
