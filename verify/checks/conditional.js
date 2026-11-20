import assert from 'node:assert/strict';
import { connect as connectTcp } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { boundedRequest } from '../timeouts.js';
import { assertMissing, assertStatus, cleanupDelete, message, status, withBucket, withCleanup } from './resources.js';

// Conditional requests as documented for GetObject, HeadObject and CopyObject:
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html
// and RFC 9110 section 13. Dates are HTTP-dates with one-second precision and
// are compared with the object's Last-Modified value, so a condition naming
// exactly that value must be treated as "not modified since".
//
// Only dates at or before Last-Modified are sent. A date in the future, or one
// that cannot be parsed, is ignored by RFC 9110, but S3 does not document its
// handling, so neither is exercised. The two documented combinations of ETag
// and date conditions are checked, together with the RFC 9110 rule that a
// failed If-Match is not overridden by a passing If-Unmodified-Since.

const DAY_MS = 24 * 60 * 60 * 1000;
const NOT_THE_ETAG = '"not-the-etag"';

// CopySource is a URL-encoded path, not an ordinary object key.
const copySource = (bucket, key) => `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

async function cleanObjects(client, Bucket, keys) {
  const failures = [];
  for (const Key of keys) {
    try {
      await cleanupDelete(client, new DeleteObjectCommand({ Bucket, Key }), ['NoSuchBucket', 'NoSuchKey']);
    } catch (error) {
      failures.push(new Error(`${Bucket}/${Key}: ${message(error)}`, { cause: error }));
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map(message).join('; '));
}

const withObjects = (client, Bucket, keys, run) =>
  withCleanup(run, () => cleanObjects(client, Bucket, keys), `objects in bucket ${Bucket}`);

// Report an unexpected rejection of a request that should succeed with its conditions.
async function expectSuccess(send, label) {
  try {
    return await send();
  } catch (error) {
    if (status(error) === undefined) throw error;
    throw new Error(`${label} should succeed, got HTTP ${status(error)} ${error.name}`, { cause: error });
  }
}

async function putObject(client, Bucket, Key, Body, label = 'PutObject setup') {
  const response = await client.send(new PutObjectCommand({ Bucket, Key, Body, ContentType: 'application/octet-stream' }));
  assertStatus(response, 200, label);
  assert.ok(response.ETag, `${label} ETag`);
  return response.ETag;
}

// Last-Modified as reported by HeadObject, which conditions are compared with.
async function lastModified(client, Bucket, Key, ETag) {
  const head = await client.send(new HeadObjectCommand({ Bucket, Key }));
  assertStatus(head, 200, 'HeadObject setup');
  assert.equal(head.ETag, ETag, 'HeadObject setup ETag');
  assert.ok(head.LastModified instanceof Date && !Number.isNaN(head.LastModified.getTime()), 'HeadObject setup LastModified');
  return head.LastModified;
}

function describe(conditions) {
  return Object.entries(conditions).map(([name, value]) => {
    if (value instanceof Date) return `${name}=${value.toUTCString()}`;
    return `${name}=${value}`;
  }).join(', ');
}

// Request conditions for GetObject and HeadObject. `at` is Last-Modified and
// `before` is a day earlier; `etag` is the current ETag.
export function readConditionCases({ etag, at, before }) {
  return [
    [{ IfModifiedSince: before }, 200],
    [{ IfModifiedSince: at }, 304],
    [{ IfUnmodifiedSince: at }, 200],
    [{ IfUnmodifiedSince: before }, 412],
    // Documented: If-Match true and If-Unmodified-Since false returns 200.
    [{ IfMatch: etag, IfUnmodifiedSince: before }, 200],
    // A failed If-Match is not overridden by a passing If-Unmodified-Since.
    [{ IfMatch: NOT_THE_ETAG, IfUnmodifiedSince: at }, 412],
    // Documented: If-None-Match false and If-Modified-Since true returns 304.
    [{ IfNoneMatch: etag, IfModifiedSince: before }, 304],
    [{ IfMatch: etag, IfModifiedSince: before }, 200],
    [{ IfNoneMatch: NOT_THE_ETAG, IfUnmodifiedSince: at }, 200],
  ];
}

// Source conditions for CopyObject. A failed condition is always 412.
export function copyConditionCases({ etag, at, before }) {
  return [
    [{ CopySourceIfModifiedSince: before }, 200],
    [{ CopySourceIfModifiedSince: at }, 412],
    [{ CopySourceIfUnmodifiedSince: at }, 200],
    [{ CopySourceIfUnmodifiedSince: before }, 412],
    // Documented: if-match true and if-unmodified-since false copies the object.
    [{ CopySourceIfMatch: etag, CopySourceIfUnmodifiedSince: before }, 200],
    [{ CopySourceIfMatch: NOT_THE_ETAG, CopySourceIfUnmodifiedSince: at }, 412],
    // Documented: if-none-match false and if-modified-since true returns 412.
    [{ CopySourceIfNoneMatch: etag, CopySourceIfModifiedSince: before }, 412],
  ];
}

async function verifyReadConditions(client) {
  await withBucket(client, async ({ Bucket }) => {
    const Key = 'conditional/雪 +&%.bin';
    await withObjects(client, Bucket, [Key], async () => {
      const body = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
      const etag = await putObject(client, Bucket, Key, body);
      const at = await lastModified(client, Bucket, Key, etag);
      const before = new Date(at.getTime() - DAY_MS);
      for (const [conditions, expected] of readConditionCases({ etag, at, before })) {
        for (const [operation, send] of [
          ['GetObject', () => client.send(new GetObjectCommand({ Bucket, Key, ...conditions }))],
          ['HeadObject', () => client.send(new HeadObjectCommand({ Bucket, Key, ...conditions }))],
        ]) {
          const label = `${operation} with ${describe(conditions)}`;
          if (expected === 200) {
            const response = await expectSuccess(send, label);
            assertStatus(response, 200, label);
            assert.equal(response.ETag, etag, `${label} ETag`);
            if (operation === 'GetObject') {
              assert.deepEqual(Buffer.from(await response.Body.transformToByteArray()), body, `${label} content`);
            }
          } else {
            await assert.rejects(send, error => {
              assert.equal(status(error), expected, `${label} should return HTTP ${expected}`);
              return true;
            }, `${label} should return HTTP ${expected}`);
          }
        }
      }
      // Conditions on a missing key do not hide that it is missing.
      await assertMissing(() => client.send(new GetObjectCommand({ Bucket, Key: 'absent', IfModifiedSince: before })),
        'GetObject missing key with IfModifiedSince', 'NoSuchKey');
    });
  });
}

async function verifyCopyConditions(client) {
  await withBucket(client, async ({ Bucket }) => {
    const source = 'source/雪 +&%.bin';
    const destination = 'destination';
    await withObjects(client, Bucket, [source, destination], async () => {
      const body = Buffer.from('conditional copy source');
      const etag = await putObject(client, Bucket, source, body);
      const at = await lastModified(client, Bucket, source, etag);
      const before = new Date(at.getTime() - DAY_MS);
      const sentinel = Buffer.from('destination before conditional copy');
      const destinationContent = async (expected, label) => {
        const response = await client.send(new GetObjectCommand({ Bucket, Key: destination }));
        assertStatus(response, 200, `GetObject ${label}`);
        assert.deepEqual(Buffer.from(await response.Body.transformToByteArray()), expected, `GetObject ${label} content`);
      };
      for (const [conditions, expected] of copyConditionCases({ etag, at, before })) {
        const label = `CopyObject with ${describe(conditions)}`;
        // Reset the destination so that each outcome is observable.
        await putObject(client, Bucket, destination, sentinel);
        const copy = () => client.send(new CopyObjectCommand({ Bucket, Key: destination, CopySource: copySource(Bucket, source), ...conditions }));
        if (expected === 200) {
          const response = await expectSuccess(copy, label);
          assertStatus(response, 200, label);
          assert.equal(response.CopyObjectResult?.ETag, etag, `${label} result ETag`);
          await destinationContent(body, `after ${label}`);
        } else {
          await assert.rejects(copy, error => {
            assert.equal(status(error), 412, `${label} should return HTTP 412`);
            assert.equal(error.name, 'PreconditionFailed', `${label} error code`);
            return true;
          }, `${label} should be rejected`);
          await destinationContent(sentinel, `after rejected ${label}`);
        }
      }
    });
  });
}

// Captures a fully signed SDK request without sending it, so that it can be
// sent over a raw connection whose bytes are visible.
class CapturedRequest extends Error {
  constructor(request) {
    super('request captured');
    this.request = request;
  }
}

export async function signedRequest(client, command) {
  command.middlewareStack.add(() => async args => {
    throw new CapturedRequest(args.request);
  }, { step: 'deserialize', priority: 'low', name: 'micros3VerifyCaptureRequest', override: true });
  try {
    await client.send(command);
  } catch (error) {
    if (error instanceof CapturedRequest) return error.request;
    throw error;
  }
  throw new Error('request was not captured');
}

const encodeQuery = value => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function queryString(query = {}) {
  const parts = [];
  for (const [name, value] of Object.entries(query).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    for (const item of [value].flat()) {
      parts.push(item === null || item === undefined ? encodeQuery(name) : `${encodeQuery(name)}=${encodeQuery(item)}`);
    }
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

// How long to keep reading after the header block when the server does not
// close the connection, so that improperly sent body bytes arrive.
export const TRAILING_BYTES_WAIT_MS = 500;

// Sends a signed request over a fresh connection with `Connection: close` and
// returns the status, headers and every byte following the header block. For a
// HEAD or 304 response those bytes are an improperly sent body.
export async function rawExchange(client, request, operation) {
  return boundedRequest(client, operation, signal => new Promise((resolve, reject) => {
    const secure = request.protocol === 'https:';
    const port = request.port || (secure ? 443 : 80);
    const socket = secure
      ? connectTls({ host: request.hostname, port, servername: request.hostname })
      : connectTcp({ host: request.hostname, port });
    const chunks = [];
    let idle;
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) return reject(error);
      const data = Buffer.concat(chunks);
      const end = data.indexOf('\r\n\r\n');
      if (end < 0) return reject(new Error(`${operation}: incomplete HTTP response header`));
      const [statusLine, ...lines] = data.subarray(0, end).toString('latin1').split('\r\n');
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);
      if (!match) return reject(new Error(`${operation}: malformed HTTP status line ${JSON.stringify(statusLine)}`));
      const headers = new Headers();
      for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
      }
      resolve({ status: Number(match[1]), headers, trailing: data.subarray(end + 4) });
    };
    const abort = () => finish(signal.reason ?? new Error(`${operation} aborted`));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('error', finish);
    socket.on('end', () => finish());
    socket.on('close', () => finish());
    socket.on('data', chunk => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).includes('\r\n\r\n')) {
        clearTimeout(idle);
        idle = setTimeout(() => finish(), TRAILING_BYTES_WAIT_MS);
      }
    });
    const headers = Object.entries(request.headers)
      .filter(([name]) => !['connection', 'transfer-encoding'].includes(name.toLowerCase()))
      .map(([name, value]) => `${name}: ${value}\r\n`).join('');
    socket.write(`${request.method} ${request.path}${queryString(request.query)} HTTP/1.1\r\n${headers}connection: close\r\n\r\n`);
  }));
}

async function verifyBodilessResponses(client) {
  await withBucket(client, async ({ Bucket }) => {
    const Key = 'wire/雪 +&%.bin';
    await withObjects(client, Bucket, [Key, 'absent'], async () => {
      const body = Buffer.from('content that must not follow a HEAD or 304 response');
      const etag = await putObject(client, Bucket, Key, body);
      const exchange = async (command, label) => rawExchange(client, await signedRequest(client, command), label);
      const noBody = (result, label) => assert.equal(result.trailing.length, 0,
        `${label} must not send a body, got ${result.trailing.length} bytes: ${JSON.stringify(result.trailing.subarray(0, 64).toString('latin1'))}`);

      const head = await exchange(new HeadObjectCommand({ Bucket, Key }), 'HeadObject');
      assert.equal(head.status, 200, 'HeadObject HTTP status');
      assert.equal(head.headers.get('etag'), etag, 'HeadObject ETag');
      assert.equal(head.headers.get('content-length'), String(body.length), 'HeadObject Content-Length must be the object size');
      noBody(head, 'HeadObject');

      const ranged = await exchange(new HeadObjectCommand({ Bucket, Key, Range: 'bytes=0-4' }), 'HeadObject range');
      assert.ok([200, 206].includes(ranged.status), 'HeadObject range HTTP status');
      noBody(ranged, 'HeadObject range');

      for (const [command, expected, label] of [
        [new HeadObjectCommand({ Bucket, Key: 'absent' }), 404, 'HeadObject missing key'],
        [new HeadObjectCommand({ Bucket, Key, IfMatch: NOT_THE_ETAG }), 412, 'HeadObject failed IfMatch'],
        [new HeadObjectCommand({ Bucket, Key, IfNoneMatch: etag }), 304, 'HeadObject matching IfNoneMatch'],
        [new GetObjectCommand({ Bucket, Key, IfNoneMatch: etag }), 304, 'GetObject matching IfNoneMatch'],
      ]) {
        const result = await exchange(command, label);
        assert.equal(result.status, expected, `${label} HTTP status`);
        noBody(result, label);
      }

      // A raw GET must return the body, confirming the connection is read correctly.
      const get = await exchange(new GetObjectCommand({ Bucket, Key }), 'GetObject');
      assert.equal(get.status, 200, 'GetObject HTTP status');
      assert.ok(get.trailing.includes(body), 'GetObject over a raw connection must return the content');
    });
  });
}

export default [
  { name: 'GetObject and HeadObject date conditions', run: ({ client }) => verifyReadConditions(client) },
  { name: 'CopyObject date conditions', run: ({ client }) => verifyCopyConditions(client) },
  { name: 'HEAD and 304 responses have no body on the wire', run: ({ client }) => verifyBodilessResponses(client) },
];
