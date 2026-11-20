import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import checks from '../checks/cors-behavior.js';
import corsChecks from '../checks/cors.js';

const checkName = 'CORS headers on actual requests';
const run = checks.find(check => check.name === checkName).run;

const errorXml = code => `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>failed</Message></Error>`;
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wildcard = pattern => new RegExp(`^${pattern.split('*').map(escape).join('.*')}$`);

function parseRules(xml) {
  return [...xml.matchAll(/<CORSRule>([\s\S]*?)<\/CORSRule>/g)].map(([, body]) => {
    const all = tag => [...body.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map(match => match[1]);
    const maxAge = all('MaxAgeSeconds')[0];
    return {
      origins: all('AllowedOrigin'), methods: all('AllowedMethod'), headers: all('AllowedHeader'),
      expose: all('ExposeHeader'), maxAge: maxAge === undefined ? undefined : Number(maxAge),
    };
  });
}

// A path-style S3 service over HTTP that applies CORS rules as S3 documents.
// Options break individual behaviors:
// - noVary, noExpose: omit those headers from actual responses
// - corsWhenUnmatched: adds CORS headers to unmatched actual requests
async function s3Fixture(t, options = {}) {
  const service = { buckets: new Map(), requests: [] };
  const originMatches = (rule, origin) => rule.origins.some(pattern => wildcard(pattern).test(origin));
  const matching = (bucket, origin, method) => (bucket.rules ?? []).find(rule => originMatches(rule, origin) && rule.methods.includes(method));
  const allowOrigin = (rule, origin) => (rule.origins.includes('*') ? '*' : origin);

  function actualHeaders(bucket, origin, method) {
    if (origin === undefined) return {};
    const rule = matching(bucket, origin, method);
    if (!rule) return options.corsWhenUnmatched ? { 'access-control-allow-origin': origin } : {};
    return {
      'access-control-allow-origin': allowOrigin(rule, origin),
      ...(!options.noVary && { vary: 'Origin' }),
      ...(rule.expose.length && !options.noExpose && { 'access-control-expose-headers': rule.expose.join(', ') }),
    };
  }

  function handle(request, body) {
    const url = new URL(request.url, 'http://fixture');
    const [, name, ...rest] = url.pathname.split('/');
    const key = rest.length ? rest.map(decodeURIComponent).join('/') : '';
    const bucket = service.buckets.get(name);
    const { method, headers } = request;
    if (method === 'PUT' && !key && !url.searchParams.has('cors')) {
      service.buckets.set(name, { objects: new Map(), rules: undefined });
      return { statusCode: 200 };
    }
    if (!bucket) return { statusCode: 404, headers: { 'content-type': 'application/xml' }, body: errorXml('NoSuchBucket') };
    if (url.searchParams.has('cors')) {
      if (method === 'PUT') {
        bucket.rules = parseRules(body.toString());
        return { statusCode: 200 };
      }
      if (method === 'DELETE') {
        bucket.rules = undefined;
        return { statusCode: 204 };
      }
    }
    if (!key) {
      if (method === 'HEAD') return { statusCode: 200 };
      if (method === 'DELETE') {
        if (bucket.objects.size) return { statusCode: 409, body: errorXml('BucketNotEmpty') };
        service.buckets.delete(name);
        return { statusCode: 204 };
      }
    }
    const cors = actualHeaders(bucket, headers.origin, method);
    if (method === 'PUT') {
      bucket.objects.set(key, body);
      return { statusCode: 200, headers: { etag: '"etag"', ...cors } };
    }
    if (method === 'DELETE') {
      bucket.objects.delete(key);
      return { statusCode: 204 };
    }
    const object = bucket.objects.get(key);
    if (!object) return { statusCode: 404, headers: { 'content-type': 'application/xml' }, body: errorXml('NoSuchKey') };
    return { statusCode: 200, headers: { etag: '"etag"', 'content-length': object.length, 'last-modified': new Date(0).toUTCString(), ...cors }, body: object };
  }

  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      service.requests.push({ method: request.method, url: request.url, headers: request.headers });
      const reply = { headers: {}, ...handle(request, Buffer.concat(chunks)) };
      response.writeHead(reply.statusCode, { 'x-amz-request-id': 'request', ...reply.headers });
      response.end(request.method === 'HEAD' ? undefined : reply.body);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${server.address().port}`, region: 'us-east-1', forcePathStyle: true, maxAttempts: 1,
    credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
  });
  t.after(() => client.destroy());
  return { client, service };
}

test('CORS header checks are part of the CORS suite module set', () => {
  assert.deepEqual(checks.map(check => check.name), [checkName]);
  assert.ok(!corsChecks.some(check => check.name === checkName));
});

test('CORS header checks pass against a conforming service over HTTP and clean up', async t => {
  const { client, service } = await s3Fixture(t);
  await run({ client });
  assert.equal(service.buckets.size, 0);
  const signed = service.requests.filter(request => request.headers.origin);
  assert.ok(signed.length >= 5, 'actual requests with Origin sent');
  for (const request of signed) assert.match(request.headers.authorization, /SignedHeaders=[^,]*origin/, 'Origin is signed');
});

const defects = [
  ['Vary omitted on actual responses', { noVary: true }, /Vary should include Origin/],
  ['expose headers omitted on actual responses', { noExpose: true }, /Expose-Headers should list ETag/],
  ['CORS headers on unmatched actual requests', { corsWhenUnmatched: true }, /should not include Access-Control-Allow-Origin/],
];

for (const [description, options, pattern] of defects) {
  test(`${checkName} detects ${description} and cleans up`, async t => {
    const { client, service } = await s3Fixture(t, options);
    await assert.rejects(() => run({ client }), pattern);
    assert.equal(service.buckets.size, 0, 'buckets removed');
  });
}
