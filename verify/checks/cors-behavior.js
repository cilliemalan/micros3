import assert from 'node:assert/strict';
import {
  DeleteBucketCorsCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutBucketCorsCommand, PutObjectCommand,
} from '@aws-sdk/client-s3';
import { boundedRequest } from '../timeouts.js';
import { assertStatus, cleanupDelete, message, withBucket, withCleanup } from './resources.js';

// Checks how a stored CORS configuration is applied to requests, as described
// in https://docs.aws.amazon.com/AmazonS3/latest/userguide/cors.html: the
// first rule whose origin, method and requested headers all match is used.
// Preflight OPTIONS requests are unauthenticated and sent directly over HTTP;
// actual requests are signed SDK requests with an added `Origin` header.
//
// Header names are sent as browsers send them (lowercase, comma-separated).
// Not exercised: the error code of a rejected preflight (only HTTP 403 and the
// absence of CORS headers are required), preflights missing `Origin` or
// `Access-Control-Request-Method`, `Access-Control-Allow-Credentials`, and
// buckets that do not exist.

const APP = 'https://app.example.com';
const UPLOADER = 'https://uploader.example.org';
const OTHER = 'https://other.example';

export const behaviorRules = [
  {
    ID: 'read-only',
    AllowedOrigins: [APP, 'https://*.example.net'],
    AllowedMethods: ['GET', 'HEAD'],
    AllowedHeaders: ['authorization', 'x-custom-*'],
    ExposeHeaders: ['ETag', 'x-amz-meta-owner'],
    MaxAgeSeconds: 100,
  },
  {
    ID: 'write',
    AllowedOrigins: [APP, UPLOADER],
    AllowedMethods: ['GET', 'PUT', 'DELETE'],
    AllowedHeaders: ['*'],
    ExposeHeaders: ['x-amz-request-id'],
    MaxAgeSeconds: 200,
  },
  {
    ID: 'public-read',
    AllowedOrigins: ['*'],
    AllowedMethods: ['GET'],
    MaxAgeSeconds: 300,
  },
];
const [readOnly, write, publicRead] = behaviorRules;
const replacementRules = [{ AllowedOrigins: ['https://new.example.com'], AllowedMethods: ['PUT'], MaxAgeSeconds: 50 }];

async function putCors(client, Bucket, CORSRules) {
  assertStatus(await client.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules } })), 200, 'PutBucketCors');
}

function withCors(client, Bucket, run) {
  return withCleanup(run, () => cleanupDelete(client, new DeleteBucketCorsCommand({ Bucket })),
    `CORS configuration in bucket ${Bucket}`);
}

function withObjects(client, Bucket, keys, run) {
  return withCleanup(run, async () => {
    const failures = [];
    for (const Key of keys) {
      try {
        await cleanupDelete(client, new DeleteObjectCommand({ Bucket, Key }), ['NoSuchBucket', 'NoSuchKey']);
      } catch (error) {
        failures.push(`${Bucket}/${Key}: ${message(error)}`);
      }
    }
    if (failures.length) throw new Error(failures.join('; '));
  }, `objects in bucket ${Bucket}`);
}

async function objectUrl(client, Bucket, Key) {
  const { protocol, hostname, port, path = '/' } = await client.config.endpoint();
  const base = `${protocol}//${hostname.includes(':') ? `[${hostname}]` : hostname}${port ? `:${port}` : ''}`;
  const keyPath = Key.split('/').map(encodeURIComponent).join('/');
  return `${base}${path.replace(/\/$/, '')}/${encodeURIComponent(Bucket)}/${keyPath}`;
}

// Sends an unauthenticated preflight request as a browser would.
export async function preflight(client, Bucket, Key, { origin, method, headers }) {
  const url = await objectUrl(client, Bucket, Key);
  return boundedRequest(client, 'CORS preflight', async signal => {
    const response = await fetch(url, {
      method: 'OPTIONS',
      signal,
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': method,
        ...(headers && { 'Access-Control-Request-Headers': headers.join(',') }),
      },
    });
    await response.arrayBuffer();
    return { status: response.status, headers: response.headers };
  });
}

// Sends a signed SDK request with an `Origin` header and returns the response
// with its raw HTTP headers, which the SDK does not otherwise expose.
export async function withOrigin(client, command, origin) {
  let headers;
  command.middlewareStack.add(next => async args => {
    if (origin !== undefined) args.request.headers.origin = origin;
    return next(args);
  }, { step: 'build', name: 'micros3VerifyOrigin', override: true });
  command.middlewareStack.addRelativeTo(next => async args => {
    const result = await next(args);
    headers = new Headers(Object.entries(result.response?.headers ?? {}).map(([name, value]) => [name, String(value)]));
    return result;
  }, { relation: 'after', toMiddleware: 'deserializerMiddleware', name: 'micros3VerifyResponseHeaders', override: true });
  const response = await client.send(command);
  if (response.Body) await response.Body.transformToByteArray();
  return { response, headers };
}

const list = value => (value ?? '').split(',').map(item => item.trim()).filter(Boolean);
const describe = ({ origin, method, headers }) =>
  `${method} from ${origin}${headers ? ` with ${headers.join(',')}` : ''}`;

function assertAllowOrigin(headers, origin, rule, label) {
  const allowOrigin = headers.get('access-control-allow-origin');
  // A rule whose only origin is `*` may answer with `*` instead of the origin.
  const accepted = rule.AllowedOrigins.includes('*') ? [origin, '*'] : [origin];
  assert.ok(accepted.includes(allowOrigin),
    `${label}: Access-Control-Allow-Origin should be ${accepted.join(' or ')}, got ${JSON.stringify(allowOrigin)}`);
  return allowOrigin;
}

function assertAllowOriginVaries(headers, origin, rule, label) {
  if (assertAllowOrigin(headers, origin, rule, label) !== '*') {
    // A response that depends on Origin must say so, or HTTP caches may reuse
    // it for another origin. (Browsers key preflight caches by origin.)
    assert.ok(list(headers.get('vary')).some(name => name.toLowerCase() === 'origin'),
      `${label}: Vary should include Origin, got ${JSON.stringify(headers.get('vary'))}`);
  }
}

// A successful preflight must be answered by the expected (first matching) rule.
export function assertPreflightAllowed(result, request, rule) {
  const label = `Preflight ${describe(request)}`;
  assert.equal(result.status, 200, `${label} HTTP status`);
  assertAllowOrigin(result.headers, request.origin, rule, label);
  const methods = list(result.headers.get('access-control-allow-methods')).map(method => method.toUpperCase());
  assert.ok(methods.includes(request.method), `${label}: Access-Control-Allow-Methods should include ${request.method}, got ${JSON.stringify(methods)}`);
  for (const method of methods) {
    assert.ok(rule.AllowedMethods.includes(method), `${label}: Access-Control-Allow-Methods lists ${method}, which rule ${rule.ID ?? 'without ID'} does not allow`);
  }
  // Browsers treat only a literal `*` specially; a pattern such as `x-custom-*`
  // in the response does not allow `x-custom-trace`.
  const allowHeaders = list(result.headers.get('access-control-allow-headers')).map(name => name.toLowerCase());
  for (const name of request.headers ?? []) {
    assert.ok(allowHeaders.includes(name) || allowHeaders.includes('*'),
      `${label}: Access-Control-Allow-Headers should list ${name}, got ${JSON.stringify(allowHeaders)}`);
  }
  if (rule.MaxAgeSeconds !== undefined) {
    assert.equal(result.headers.get('access-control-max-age'), String(rule.MaxAgeSeconds),
      `${label}: Access-Control-Max-Age should come from rule ${rule.ID ?? 'without ID'}`);
  }
}

export function assertPreflightDenied(result, request) {
  const label = `Preflight ${describe(request)}`;
  assert.equal(result.status, 403, `${label} should be rejected with HTTP 403`);
  assert.equal(result.headers.get('access-control-allow-origin'), null, `${label} should not allow the origin`);
}

function assertActualAllowed({ headers }, origin, rule, label) {
  assertAllowOriginVaries(headers, origin, rule, label);
  const exposed = list(headers.get('access-control-expose-headers')).map(name => name.toLowerCase());
  for (const name of rule.ExposeHeaders ?? []) {
    assert.ok(exposed.includes(name.toLowerCase()), `${label}: Access-Control-Expose-Headers should list ${name}, got ${JSON.stringify(exposed)}`);
  }
}

function assertActualDenied({ headers }, label) {
  assert.equal(headers.get('access-control-allow-origin'), null, `${label} should not include Access-Control-Allow-Origin`);
  assert.equal(headers.get('access-control-expose-headers'), null, `${label} should not include Access-Control-Expose-Headers`);
}

async function expectPreflight(client, Bucket, Key, request, rule) {
  const result = await preflight(client, Bucket, Key, request);
  if (rule) assertPreflightAllowed(result, request, rule);
  else assertPreflightDenied(result, request);
}

const key = 'cors/object.txt';

export default [
  { name: 'CORS preflight matches origins, methods and headers', async run({ client }) {
    await withBucket(client, async ({ Bucket }) => withCors(client, Bucket, async () => {
      await putCors(client, Bucket, behaviorRules);
      const cases = [
        [{ origin: APP, method: 'HEAD' }, readOnly],
        [{ origin: 'https://images.example.net', method: 'HEAD' }, readOnly],
        [{ origin: APP, method: 'HEAD', headers: ['authorization'] }, readOnly],
        // AllowedHeaders may contain a wildcard; each requested header must match some entry.
        [{ origin: APP, method: 'HEAD', headers: ['authorization', 'x-custom-trace'] }, readOnly],
        [{ origin: UPLOADER, method: 'DELETE', headers: ['content-type', 'x-amz-date'] }, write],
        // The preflight does not depend on the object existing.
        [{ origin: OTHER, method: 'GET' }, publicRead],
        // Wildcards match within an origin pattern only; schemes and suffixes must match.
        [{ origin: 'http://images.example.net', method: 'HEAD' }],
        [{ origin: 'https://example.net', method: 'HEAD' }],
        [{ origin: 'https://app.example.com.evil.example', method: 'HEAD' }],
        [{ origin: 'https://app.example.com:8443', method: 'HEAD' }],
        // Unlisted methods and headers.
        [{ origin: UPLOADER, method: 'POST' }],
        [{ origin: OTHER, method: 'PUT' }],
        [{ origin: APP, method: 'HEAD', headers: ['x-other'] }],
        [{ origin: OTHER, method: 'GET', headers: ['authorization'] }],
      ];
      for (const [request, rule] of cases) await expectPreflight(client, Bucket, key, request, rule);
    }));
  } },
  { name: 'CORS preflight uses the first matching rule', async run({ client }) {
    await withBucket(client, async ({ Bucket }) => withCors(client, Bucket, async () => {
      await putCors(client, Bucket, behaviorRules);
      const cases = [
        // All three rules allow GET from APP; the first one answers.
        [{ origin: APP, method: 'GET' }, readOnly],
        [{ origin: APP, method: 'GET', headers: ['x-custom-trace'] }, readOnly],
        // A header the first rule does not allow falls through to the second.
        [{ origin: APP, method: 'GET', headers: ['x-other'] }, write],
        [{ origin: APP, method: 'PUT' }, write],
        // The first rule rejects the header and no later rule allows it for this origin.
        [{ origin: 'https://images.example.net', method: 'GET', headers: ['x-other'] }],
        [{ origin: 'https://images.example.net', method: 'GET' }, readOnly],
        [{ origin: UPLOADER, method: 'GET' }, write],
      ];
      for (const [request, rule] of cases) await expectPreflight(client, Bucket, key, request, rule);
    }));
  } },
  { name: 'CORS headers on actual requests', async run({ client }) {
    await withBucket(client, async ({ Bucket }) => {
      const uploads = ['cors/upload-allowed.txt', 'cors/upload-other.txt'];
      await withObjects(client, Bucket, [key, ...uploads], () => withCors(client, Bucket, async () => {
        const Body = Buffer.from('cors content');
        assertStatus(await client.send(new PutObjectCommand({ Bucket, Key: key, Body, Metadata: { owner: 'verifier' } })), 200, 'PutObject setup');
        await putCors(client, Bucket, behaviorRules);
        const get = origin => withOrigin(client, new GetObjectCommand({ Bucket, Key: key }), origin);
        const head = origin => withOrigin(client, new HeadObjectCommand({ Bucket, Key: key }), origin);
        const put = (Key, origin) => withOrigin(client, new PutObjectCommand({ Bucket, Key, Body }), origin);

        // A matching origin and method get CORS headers from the first matching rule.
        assertActualAllowed(await get(APP), APP, readOnly, `GetObject from ${APP}`);
        assertActualAllowed(await head('https://images.example.net'), 'https://images.example.net', readOnly, 'HeadObject from https://images.example.net');
        assertActualAllowed(await get(OTHER), OTHER, publicRead, `GetObject from ${OTHER}`);
        const allowedPut = await put(uploads[0], UPLOADER);
        assertStatus(allowedPut.response, 200, `PutObject from ${UPLOADER}`);
        assertActualAllowed(allowedPut, UPLOADER, write, `PutObject from ${UPLOADER}`);

        // CORS does not authorize requests: unmatched requests still succeed, without CORS headers.
        const otherPut = await put(uploads[1], OTHER);
        assertStatus(otherPut.response, 200, `PutObject from ${OTHER}`);
        assertActualDenied(otherPut, `PutObject from ${OTHER}`);
        const unmatched = await head('http://images.example.net');
        assertStatus(unmatched.response, 200, 'HeadObject from http://images.example.net');
        assertActualDenied(unmatched, 'HeadObject from http://images.example.net');
        const plain = await get(undefined);
        assertStatus(plain.response, 200, 'GetObject without Origin');
        assertActualDenied(plain, 'GetObject without Origin');
      }));
    });
  } },
  { name: 'CORS behavior follows configuration changes', async run({ client }) {
    await withBucket(client, async ({ Bucket }) => withBucket(client, async ({ Bucket: other }) => {
      await withObjects(client, Bucket, [key], () => withCors(client, Bucket, () => withCors(client, other, async () => {
        assertStatus(await client.send(new PutObjectCommand({ Bucket, Key: key, Body: 'content' })), 200, 'PutObject setup');
        const appGet = { origin: APP, method: 'GET' };
        const newPut = { origin: 'https://new.example.com', method: 'PUT' };
        const actual = async label => assertActualDenied(
          await withOrigin(client, new GetObjectCommand({ Bucket, Key: key }), APP), `GetObject from ${APP} ${label}`);

        await expectPreflight(client, Bucket, key, appGet);
        await actual('without a CORS configuration');

        await putCors(client, Bucket, behaviorRules);
        await expectPreflight(client, Bucket, key, appGet, readOnly);
        // Another bucket's configuration does not apply.
        await expectPreflight(client, other, key, appGet);

        await putCors(client, Bucket, replacementRules);
        await expectPreflight(client, Bucket, key, appGet);
        await expectPreflight(client, Bucket, key, newPut, replacementRules[0]);
        await actual('after replacement');

        assertStatus(await client.send(new DeleteBucketCorsCommand({ Bucket })), 204, 'DeleteBucketCors');
        await expectPreflight(client, Bucket, key, newPut);
        await actual('after deletion');

        await putCors(client, Bucket, behaviorRules);
        await expectPreflight(client, Bucket, key, appGet, readOnly);
      })));
    }));
  } },
];
