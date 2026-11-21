// Checks how a stored CORS configuration is applied to signed requests, as described in
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/cors.html: the first rule whose
// origin, method and requested headers all match is used. Requests are signed SDK requests
// with an added `Origin` header, and the raw HTTP response headers are inspected.
//
// Not exercised: preflight OPTIONS requests, the error code of a rejected request,
// `Access-Control-Allow-Credentials`, and buckets that do not exist.

import assert from 'node:assert/strict';
import {
  DeleteBucketCorsCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutBucketCorsCommand, PutObjectCommand,
} from '@aws-sdk/client-s3';
import { assertStatus, cleanupDelete, message, withBucket, withCleanup } from './resources.js';
import { scenario } from '../test-runner.js';

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
    // it for another origin.
    assert.ok(list(headers.get('vary')).some(name => name.toLowerCase() === 'origin'),
      `${label}: Vary should include Origin, got ${JSON.stringify(headers.get('vary'))}`);
  }
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

const key = 'cors/object.txt';

export default [
  { name: 'CORS headers on actual requests', async run({ client }) {
    await withBucket(client, async ({ Bucket }) => {
      const uploads = ['cors/upload-allowed.txt', 'cors/upload-other.txt'];
      await withObjects(client, Bucket, [key, ...uploads], () => withCors(client, Bucket, async () => {
        const Body = Buffer.from('cors content');
        await scenario('setup', async () => {
          assertStatus(await client.send(new PutObjectCommand({ Bucket, Key: key, Body, Metadata: { owner: 'verifier' } })), 200, 'PutObject setup');
          await putCors(client, Bucket, behaviorRules);
        });
        const get = origin => withOrigin(client, new GetObjectCommand({ Bucket, Key: key }), origin);
        const head = origin => withOrigin(client, new HeadObjectCommand({ Bucket, Key: key }), origin);
        const put = (Key, origin) => withOrigin(client, new PutObjectCommand({ Bucket, Key, Body }), origin);

        // A matching origin and method get CORS headers from the first matching rule.
        await scenario('GET from an exact origin', async () =>
          assertActualAllowed(await get(APP), APP, readOnly, `GetObject from ${APP}`));
        await scenario('HEAD from a wildcard origin', async () =>
          assertActualAllowed(await head('https://images.example.net'), 'https://images.example.net', readOnly, 'HeadObject from https://images.example.net'));
        await scenario('GET matching a later * rule', async () =>
          assertActualAllowed(await get(OTHER), OTHER, publicRead, `GetObject from ${OTHER}`));
        await scenario('PUT matching the write rule', async () => {
          const allowedPut = await put(uploads[0], UPLOADER);
          assertStatus(allowedPut.response, 200, `PutObject from ${UPLOADER}`);
          assertActualAllowed(allowedPut, UPLOADER, write, `PutObject from ${UPLOADER}`);
        });

        // CORS does not authorize requests: unmatched requests still succeed, without CORS headers.
        await scenario('PUT from an unmatched origin', async () => {
          const otherPut = await put(uploads[1], OTHER);
          assertStatus(otherPut.response, 200, `PutObject from ${OTHER}`);
          assertActualDenied(otherPut, `PutObject from ${OTHER}`);
        });
        await scenario('HEAD from an unmatched scheme', async () => {
          const unmatched = await head('http://images.example.net');
          assertStatus(unmatched.response, 200, 'HeadObject from http://images.example.net');
          assertActualDenied(unmatched, 'HeadObject from http://images.example.net');
        });
        await scenario('GET without Origin', async () => {
          const plain = await get(undefined);
          assertStatus(plain.response, 200, 'GetObject without Origin');
          assertActualDenied(plain, 'GetObject without Origin');
        });
      }));
    });
  } },
];
