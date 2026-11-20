import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import checks, { controlKeys, expectedEntries, textKeys } from '../checks/listing-encoding.js';
import { assertUrlEncoded, assertXmlDocument, compareKeys, decodeUrlValue } from '../checks/encoding.js';

const names = ['ListObjects URL encoding and special keys', 'ListObjectsV2 URL encoding and special keys'];
const run = name => checks.find(check => check.name === name).run;

// S3-style form encoding: `/` is left alone and a space becomes `+`.
const awsEncode = value => encodeURIComponent(value).replace(/%20/g, '+').replace(/%2F/g, '/');
const escapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const xmlEscape = value => value.replace(/[&<>"'\r\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,
  c => escapes[c] ?? `&#${c.charCodeAt(0)};`);
const errorXml = code => `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>failed</Message></Error>`;

// A path-style S3 listing service over HTTP, so requests and responses pass
// through the SDK's serialization and XML parsing. Options replace individual
// behaviors: `order` compares keys, `encode` URL-encodes values, `token`
// and `untoken` create and read V2 continuation tokens, `escape` escapes XML text, `ignoreEncoding`
// disregards `encoding-type`, and `hook(result, { v2, query })` may alter a
// listing (with already-encoded values) before it is rendered.
async function listingFixture(t, options = {}) {
  const service = { buckets: new Map(), requests: [] };
  const order = options.order ?? compareKeys;
  const encode = options.encode ?? awsEncode;
  const token = options.token ?? (key => `opaque-${Buffer.from(key).toString('base64url')}`);
  const untoken = options.untoken ?? (value => Buffer.from(value.replace(/^opaque-/, ''), 'base64url').toString());
  const escape = options.escape ?? xmlEscape;
  const fail = (statusCode, code) => ({ statusCode, body: errorXml(code) });

  function list(objects, bucket, query) {
    const v2 = query.get('list-type') === '2';
    const prefix = query.get('prefix') ?? '';
    const delimiter = query.get('delimiter') || undefined;
    const maxKeys = Number(query.get('max-keys') ?? 1000);
    const encoded = query.get('encoding-type') === 'url' && !options.ignoreEncoding;
    const after = v2
      ? (query.has('continuation-token') ? untoken(query.get('continuation-token')) : query.get('start-after') ?? '')
      : query.get('marker') ?? '';
    const entries = [];
    for (const key of [...objects.keys()].sort(order)) {
      if (!key.startsWith(prefix)) continue;
      const at = delimiter ? key.indexOf(delimiter, prefix.length) : -1;
      const name = at === -1 ? key : key.slice(0, at + delimiter.length);
      if (order(name, after) <= 0 || entries.at(-1)?.name === name) continue;
      entries.push({ name, object: at === -1 ? objects.get(key) : undefined });
    }
    const page = entries.slice(0, maxKeys);
    const truncated = entries.length > page.length;
    const last = page.at(-1)?.name;
    const e = value => value === undefined || !encoded ? value : encode(value);
    const result = {
      Name: bucket, Prefix: e(prefix), Delimiter: e(delimiter), MaxKeys: maxKeys, IsTruncated: truncated,
      EncodingType: encoded ? 'url' : undefined,
      Contents: page.filter(entry => entry.object).map(({ name, object }) => ({ Key: e(name), Size: object.body.length, ETag: object.etag })),
      CommonPrefixes: page.filter(entry => !entry.object).map(({ name }) => e(name)),
      ...(v2
        ? { KeyCount: page.length, StartAfter: e(query.get('start-after') ?? undefined),
          ContinuationToken: query.get('continuation-token') ?? undefined,
          NextContinuationToken: truncated ? token(last) : undefined }
        : { Marker: e(query.get('marker') ?? ''), NextMarker: truncated && delimiter ? e(last) : undefined }),
    };
    options.hook?.(result, { v2, query });
    const element = (tag, value) => value === undefined ? '' : `<${tag}>${escape(String(value))}</${tag}>`;
    const scalars = ['Name', 'Prefix', 'Marker', 'StartAfter', 'ContinuationToken', 'NextMarker', 'NextContinuationToken',
      'KeyCount', 'MaxKeys', 'Delimiter', 'IsTruncated', 'EncodingType'];
    return {
      statusCode: 200,
      body: `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${
        scalars.map(tag => element(tag, result[tag])).join('')}${
        result.Contents.map(item => `<Contents>${element('Key', item.Key)}<LastModified>2024-01-02T03:04:05.000Z</LastModified>${
          element('ETag', item.ETag)}${element('Size', item.Size)}<StorageClass>STANDARD</StorageClass></Contents>`).join('')}${
        result.CommonPrefixes.map(prefix => `<CommonPrefixes>${element('Prefix', prefix)}</CommonPrefixes>`).join('')}</ListBucketResult>`,
    };
  }

  function handle(request, body) {
    const url = new URL(request.url, 'http://fixture');
    const [, bucket, ...rest] = url.pathname.split('/');
    const key = rest.join('/') ? decodeURIComponent(rest.join('/')) : undefined;
    const objects = service.buckets.get(bucket);
    if (key === undefined) {
      if (request.method === 'PUT') {
        service.buckets.set(bucket, new Map());
        return { statusCode: 200 };
      }
      if (!objects) return fail(404, 'NoSuchBucket');
      if (request.method === 'DELETE') {
        if (objects.size) return fail(409, 'BucketNotEmpty');
        service.buckets.delete(bucket);
        return { statusCode: 204 };
      }
      if (request.method === 'GET') return list(objects, bucket, url.searchParams);
    }
    if (!objects) return fail(404, 'NoSuchBucket');
    if (request.method === 'PUT') {
      const etag = `"${createHash('md5').update(body).digest('hex')}"`;
      objects.set(key, { body, etag });
      return { statusCode: 200, headers: { etag } };
    }
    if (request.method === 'DELETE') {
      objects.delete(key);
      return { statusCode: 204 };
    }
    throw new Error(`Unexpected ${request.method} ${request.url}`);
  }

  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      service.requests.push({ method: request.method, url: request.url });
      let reply;
      try {
        reply = handle(request, Buffer.concat(chunks));
      } catch (error) {
        reply = { statusCode: 500, body: errorXml('InternalError') };
        service.error = error;
      }
      response.writeHead(reply.statusCode, { 'x-amz-request-id': 'request', 'content-type': 'application/xml', ...reply.headers });
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

test('keys are compared in UTF-8 byte order, unlike UTF-16 string order', () => {
  assert.ok('enc/\u{1f600}' < 'enc/Ａ', 'UTF-16 order puts the emoji first');
  assert.ok(compareKeys('enc/Ａ', 'enc/\u{1f600}') < 0);
  assert.deepEqual(expectedEntries(textKeys, { Prefix: 'enc/', Delimiter: ' ' }), [
    { prefix: 'enc/a ' }, { key: 'enc/plain.txt' }, { prefix: 'enc/sub ' }, { prefix: 'enc/trailing ' },
    { prefix: 'enc/xml ' }, { key: 'enc/日本語/ü.txt' }, { key: 'enc/Ａ.txt' }, { key: 'enc/\u{1f600}.txt' },
  ]);
  assert.deepEqual(expectedEntries(controlKeys, { Prefix: 'ctl/', after: 'ctl/del\u007fhere.txt' }).map(e => e.key),
    ['ctl/nl\nhere.txt', 'ctl/soh\u0001here.txt', 'ctl/tab\there.txt']);
  assert.deepEqual(expectedEntries([...textKeys, ...controlKeys], { Delimiter: '\n' }).slice(0, 4),
    [{ key: 'ctl/cr\rhere.txt' }, { key: 'ctl/del\u007fhere.txt' }, { prefix: 'ctl/nl\n' }, { key: 'ctl/soh\u0001here.txt' }]);
});

test('URL-encoded values decode with form semantics and must be printable ASCII', () => {
  assertUrlEncoded('a+b%2Bc%2F%E6%97%A5%01', 'a b+c/日\u0001', 'field');
  assertUrlEncoded('a%20b/c', 'a b/c', 'field');
  assert.throws(() => assertUrlEncoded('a+b', 'a+b', 'field'), /decode to/);
  for (const [value, pattern] of [['a b', /printable ASCII/], ['日', /printable ASCII/], ['a\u0001', /printable ASCII/],
    ['a\tb', /printable ASCII/], ['100%', /malformed percent/], ['%zz', /malformed percent/], ['%FF', /UTF-8/], [undefined, /string/]]) {
    assert.throws(() => decodeUrlValue(value, 'field'), pattern, JSON.stringify(value));
  }
});

test('raw XML must be UTF-8 without characters XML 1.0 forbids', () => {
  const xml = text => Buffer.from(`<a>${text}</a>`);
  for (const text of ['plain', '&#13;&#x9;&#10;', '日 \u{1f600} \u007f', '&amp;&lt;']) assertXmlDocument(xml(text), 'listing');
  for (const [text, pattern] of [['\u0001', /forbids/], ['&#x1;', /forbids/], ['&#0;', /forbids/], ['&#xFFFE;', /forbids/], ['\u000c', /forbids/]]) {
    assert.throws(() => assertXmlDocument(xml(text), 'listing'), pattern, JSON.stringify(text));
  }
  assert.throws(() => assertXmlDocument(Buffer.from([0x3c, 0x61, 0x3e, 0xff, 0x3c]), 'listing'), /UTF-8/);
  assert.throws(() => assertXmlDocument(undefined, 'listing'), /not captured/);
});

for (const [index, name] of names.entries()) {
  const v2 = index === 1;

  test(`${name} passes against a conforming service over HTTP with either encoding style`, async t => {
    for (const encode of [awsEncode, encodeURIComponent]) {
      const { client, service } = await listingFixture(t, { encode });
      await run(name)({ client });
      assert.equal(service.error, undefined);
      assert.equal(service.buckets.size, 0);
      const lists = service.requests.filter(r => r.method === 'GET').map(r => new URL(r.url, 'http://fixture').searchParams);
      assert.ok(lists.some(q => q.get('encoding-type') === 'url'), 'encoded listings requested');
      assert.ok(lists.some(q => !q.has('encoding-type')), 'unencoded listings requested');
      // Markers are sent decoded; the SDK encodes them for the query string.
      const marker = v2 ? 'start-after' : 'marker';
      assert.ok(lists.some(q => q.get(marker) === 'ctl/nl\nhere.txt'), 'decoded control-character marker');
      if (!v2) assert.ok(lists.some(q => q.get('marker') === 'enc/a '), 'decoded NextMarker for a common prefix');
    }
  });

  const faults = [
    ['UTF-16 key order', { order: (a, b) => a < b ? -1 : a > b ? 1 : 0 }, /object keys|common prefixes/],
    ['ignored encoding type', { ignoreEncoding: true }, /forbids|EncodingType|printable ASCII/],
    ['literal plus', { encode: value => awsEncode(value).replace(/%2B/g, '+') }, /object keys|decode/],
    ['unencoded multibyte characters', { encode: value => Array.from(value, c => c > '\u007f' ? c : awsEncode(c)).join('') }, /printable ASCII/],
    ['unencoded control characters', { encode: value => Array.from(value, c => c < ' ' ? c : awsEncode(c)).join('') }, /forbids|printable ASCII/],
    ['missing EncodingType', { hook: result => { result.EncodingType = undefined; } }, /EncodingType/],
    ['unencoded Prefix', { hook: (result, { query }) => {
      if (result.EncodingType) result.Prefix = query.get('prefix') ?? '';
    } }, /Prefix/],
    ['unencoded Delimiter', { hook: (result, { query }) => {
      if (result.EncodingType && result.Delimiter) result.Delimiter = query.get('delimiter');
    } }, /Delimiter/],
    ['unencoded common prefixes', { hook: (result, { query }) => {
      if (result.EncodingType) result.CommonPrefixes = result.CommonPrefixes.map(p => decodeURIComponent(p.replace(/\+/g, ' ')));
    } }, /CommonPrefixes Prefix|common prefixes|forbids/],
    ['unescaped XML', { escape: value => value }, /./],
    ['trimmed keys', { hook: result => { for (const item of result.Contents) item.Key = item.Key.trim(); } }, /object keys/],
    ...(v2 ? [
      ['raw key as continuation token', { token: key => key, untoken: value => value }, /forbids/],
      ['unencoded StartAfter', { hook: (result, { query }) => {
        if (result.EncodingType && result.StartAfter) result.StartAfter = query.get('start-after');
      } }, /StartAfter/],
    ] : [
      ['unencoded NextMarker', { hook: (result, { query }) => {
        if (result.EncodingType && result.NextMarker) result.NextMarker = decodeURIComponent(result.NextMarker.replace(/\+/g, ' '));
      } }, /NextMarker|forbids/],
      ['NextMarker before the last entry', { hook: result => {
        if (result.NextMarker && result.Contents.length > 1) result.NextMarker = result.Contents[0].Key;
      } }, /NextMarker/],
      ['unencoded Marker', { hook: (result, { query }) => {
        if (result.EncodingType && query.get('marker')) result.Marker = query.get('marker');
      } }, /Marker/],
    ]),
  ];

  test(`${name} detects incorrect encoding, ordering and escaping and cleans up`, async t => {
    for (const [label, options, pattern] of faults) {
      const { client, service } = await listingFixture(t, options);
      await assert.rejects(run(name)({ client }), pattern, label);
      assert.equal(service.error, undefined, label);
      assert.equal(service.buckets.size, 0, `cleanup after ${label}`);
    }
  });
}
