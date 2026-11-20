import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import checks, { assertPreflightAllowed, assertPreflightDenied, behaviorRules } from '../checks/cors-behavior.js';
import corsChecks from '../checks/cors.js';
import { applyTimeouts, VerifierTimeoutError } from '../timeouts.js';

const names = [
  'CORS preflight matches origins, methods and headers',
  'CORS preflight uses the first matching rule',
  'CORS headers on actual requests',
  'CORS behavior follows configuration changes',
];
const run = name => checks.find(check => check.name === name).run;

const errorXml = code => `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>failed</Message></Error>`;
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wildcard = (pattern, flags) => new RegExp(`^${pattern.split('*').map(escape).join('.*')}$`, flags);

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
// - wildcardHeaders: false matches AllowedHeader entries literally
// - echoPatterns: answers preflights with the configured header patterns
// - lastMatch: uses the last matching rule instead of the first
// - originPrefix: matches origins without a wildcard by prefix
// - allMethods: lists every method of every rule allowing the origin
// - noVary, noExpose: omit those headers from actual responses
// - corsWhenUnmatched: adds CORS headers to unmatched actual requests
// - keepCorsOnDelete: DeleteBucketCors leaves the rules in effect
// - shareCors: one configuration applies to every bucket
// - hangOptions: never answers preflight requests
async function s3Fixture(t, options = {}) {
  const service = { buckets: new Map(), requests: [], shared: undefined };
  const rulesOf = bucket => (options.shareCors ? service.shared : bucket.rules) ?? [];
  const originMatches = (rule, origin) => rule.origins.some(pattern =>
    options.originPrefix && !pattern.includes('*') ? origin.startsWith(pattern) : wildcard(pattern).test(origin));
  const headerMatches = (rule, name) => rule.headers.some(pattern =>
    options.wildcardHeaders === false ? pattern.toLowerCase() === name : wildcard(pattern, 'i').test(name));
  function matching(bucket, origin, method, headers = []) {
    const candidates = rulesOf(bucket).filter(rule => originMatches(rule, origin) && rule.methods.includes(method)
      && headers.every(name => headerMatches(rule, name)));
    return options.lastMatch ? candidates.at(-1) : candidates[0];
  }
  const allowOrigin = (rule, origin) => (rule.origins.includes('*') ? '*' : origin);

  function preflight(bucket, headers) {
    const origin = headers.origin;
    const method = headers['access-control-request-method'];
    const requested = (headers['access-control-request-headers'] ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
    const rule = matching(bucket, origin, method, requested);
    if (!rule) return { statusCode: 403, headers: { 'content-type': 'application/xml' }, body: errorXml('AccessForbidden') };
    const methods = options.allMethods
      ? [...new Set(rulesOf(bucket).filter(r => originMatches(r, origin)).flatMap(r => r.methods))]
      : rule.methods;
    return { statusCode: 200, headers: {
      'access-control-allow-origin': allowOrigin(rule, origin),
      'access-control-allow-methods': methods.join(', '),
      ...(requested.length && { 'access-control-allow-headers': (options.echoPatterns ? rule.headers : requested).join(', ') }),
      ...(rule.maxAge !== undefined && { 'access-control-max-age': String(rule.maxAge) }),
      vary: 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method',
    } };
  }

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
    if (method === 'OPTIONS') return preflight(bucket, headers);
    if (url.searchParams.has('cors')) {
      if (method === 'PUT') {
        bucket.rules = parseRules(body.toString());
        if (options.shareCors) service.shared = bucket.rules;
        return { statusCode: 200 };
      }
      if (method === 'DELETE') {
        if (!options.keepCorsOnDelete) {
          bucket.rules = undefined;
          if (options.shareCors) service.shared = undefined;
        }
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
      if (request.method === 'OPTIONS' && options.hangOptions) return;
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

test('CORS behavior checks are part of the CORS suite module set', () => {
  assert.deepEqual(checks.map(check => check.name), names);
  for (const name of names) assert.ok(!corsChecks.some(check => check.name === name), name);
});

test('CORS behavior checks pass against a conforming service over HTTP and clean up', async t => {
  const { client, service } = await s3Fixture(t);
  for (const name of names) await run(name)({ client });
  assert.equal(service.buckets.size, 0);
  const preflights = service.requests.filter(request => request.method === 'OPTIONS');
  assert.ok(preflights.length > 20, 'preflights sent');
  for (const request of preflights) {
    assert.equal(request.headers.authorization, undefined, 'preflights are unauthenticated');
    assert.ok(request.headers.origin && request.headers['access-control-request-method'], 'preflight headers sent');
  }
  assert.ok(preflights.some(request => request.headers['access-control-request-headers'] === 'authorization,x-custom-trace'));
  const signed = service.requests.filter(request => request.method !== 'OPTIONS' && request.headers.origin);
  assert.ok(signed.length >= 5, 'actual requests with Origin sent');
  for (const request of signed) assert.match(request.headers.authorization, /SignedHeaders=[^,]*origin/, 'Origin is signed');
});

const defects = [
  ['wildcard AllowedHeaders matched literally', { wildcardHeaders: false }, names[0], /authorization,x-custom-trace HTTP status/],
  ['header patterns echoed instead of requested headers', { echoPatterns: true }, names[0], /Access-Control-Allow-Headers should list x-custom-trace/],
  ['origins matched by prefix', { originPrefix: true }, names[0], /evil\.example should be rejected/],
  ['the last matching rule used', { lastMatch: true }, names[1], /Allow-Origin should be https:\/\/app\.example\.com, got "\*"/],
  ['methods of other rules listed', { allMethods: true }, names[1], /lists (PUT|DELETE), which rule read-only does not allow/],
  ['Vary omitted on actual responses', { noVary: true }, names[2], /Vary should include Origin/],
  ['expose headers omitted on actual responses', { noExpose: true }, names[2], /Expose-Headers should list ETag/],
  ['CORS headers on unmatched actual requests', { corsWhenUnmatched: true }, names[2], /should not include Access-Control-Allow-Origin/],
  ['rules kept after DeleteBucketCors', { keepCorsOnDelete: true }, names[3], /after deletion|should be rejected/],
  ['configuration shared between buckets', { shareCors: true }, names[3], /should be rejected with HTTP 403/],
];

for (const [description, options, name, pattern] of defects) {
  test(`${name} detects ${description} and cleans up`, async t => {
    const { client, service } = await s3Fixture(t, options);
    await assert.rejects(() => run(name)({ client }), pattern);
    assert.equal(service.buckets.size, 0, 'buckets removed');
  });
}

test('preflight assertions accept a wildcard origin answer only for wildcard rules', () => {
  const response = headers => ({ status: 200, headers: new Headers(headers) });
  const request = { origin: 'https://other.example', method: 'GET' };
  assertPreflightAllowed(response({ 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET', 'access-control-max-age': '300' }), request, behaviorRules[2]);
  assertPreflightAllowed(response({ 'access-control-allow-origin': request.origin, 'access-control-allow-methods': 'GET', 'access-control-max-age': '300' }), request, behaviorRules[2]);
  assert.throws(() => assertPreflightAllowed(response({ 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET', 'access-control-max-age': '100' }),
    { origin: 'https://app.example.com', method: 'GET' }, behaviorRules[0]), /Allow-Origin/);
  assert.throws(() => assertPreflightDenied({ status: 200, headers: new Headers() }, request), /HTTP 403/);
  assert.throws(() => assertPreflightDenied({ status: 403, headers: new Headers({ 'access-control-allow-origin': '*' }) }, request), /should not allow/);
});

test('preflight requests are bounded by the request timeout and cleanup still runs', async t => {
  const { client, service } = await s3Fixture(t, { hangOptions: true });
  applyTimeouts(client, { requestTimeout: 200 });
  await assert.rejects(() => run(names[0])({ client }), error => {
    assert.ok(error instanceof VerifierTimeoutError, error.message);
    assert.match(error.message, /CORS preflight timed out after 200 ms/);
    return true;
  });
  assert.equal(service.buckets.size, 0);
});
