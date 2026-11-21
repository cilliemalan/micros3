// An in-memory S3 HTTP fixture for running the verifier's checks through the
// real AWS SDK: its request signing, serialization, XML parsing and error
// handling. Every request (other than an unauthenticated OPTIONS) must carry a
// valid AWS Signature Version 4 `Authorization` header, which is verified here
// independently of the SDK's signer, following
// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
//
// Only the operations needed by the integration tests are implemented: bucket
// creation, listing, existence, location, deletion and default encryption, and
// object upload, download, HEAD (with ranges and ETag conditions), deletion and
// multi-object deletion. It is a test double, not a reference implementation:
// it shares the verifier's assumptions about S3 behavior.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { S3Client } from '@aws-sdk/client-s3';

export const ACCESS_KEY_ID = 'fixture-key';
export const SECRET_ACCESS_KEY = 'fixture-secret';
export const REGION = 'us-east-1';

const XMLNS = 'http://s3.amazonaws.com/doc/2006-03-01/';
const sha256 = data => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

export const escapeXml = value => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const unescapeXml = value => value.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/gi, (_, hex, decimal, name) => {
  if (name) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name.toLowerCase()];
  return String.fromCodePoint(hex ? parseInt(hex, 16) : Number(decimal));
});

export class S3Error extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const errorXml = (code, message = code, resource = '') =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${escapeXml(code)}</Code><Message>${escapeXml(message)}</Message>` +
  `<Resource>${escapeXml(resource)}</Resource><RequestId>fixture-request</RequestId></Error>`;

// SigV4 encodes everything but the unreserved characters, with uppercase hex.
const sigv4Encode = value => Array.from(Buffer.from(value, 'utf8'))
  .map(byte => (/[A-Za-z0-9\-._~]/.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`))
  .join('');

function decodeComponent(value, what) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new S3Error(400, 'InvalidURI', `malformed ${what}`);
  }
}

// The canonical URI and query are rebuilt from the decoded request target, so
// a request whose target was encoded differently from what was signed fails.
function canonicalTarget(target) {
  const [rawPath, rawQuery = ''] = target.split(/\?(.*)/s);
  const path = rawPath.split('/').map(segment => sigv4Encode(decodeComponent(segment, 'path'))).join('/');
  const pairs = rawQuery ? rawQuery.split('&').map(pair => {
    const [name, value = ''] = pair.split(/=(.*)/s);
    return [sigv4Encode(decodeComponent(name, 'query')), sigv4Encode(decodeComponent(value, 'query'))];
  }) : [];
  pairs.sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  return { path, query: pairs.map(([name, value]) => `${name}=${value}`).join('&') };
}

// Returns a reason the request's signature is invalid, or undefined.
export function signatureProblem(request, body, { accessKeyId = ACCESS_KEY_ID, secretAccessKey = SECRET_ACCESS_KEY, region = REGION } = {}) {
  const authorization = request.headers.authorization;
  if (!authorization) return ['AccessDenied', 'missing Authorization header'];
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, ?SignedHeaders=([a-z0-9;-]+), ?Signature=([0-9a-f]{64})$/.exec(authorization);
  if (!match) return ['AuthorizationHeaderMalformed', `malformed Authorization header ${authorization}`];
  const [, keyId, date, credentialRegion, signedHeaderList, signature] = match;
  if (keyId !== accessKeyId) return ['InvalidAccessKeyId', `unknown access key ${keyId}`];
  if (credentialRegion !== region) return ['AuthorizationHeaderMalformed', `credential region ${credentialRegion}, expected ${region}`];
  const amzDate = request.headers['x-amz-date'];
  if (!/^\d{8}T\d{6}Z$/.test(amzDate ?? '') || !amzDate.startsWith(date)) return ['AccessDenied', `x-amz-date ${amzDate} does not match the credential date`];
  const signedHeaders = signedHeaderList.split(';');
  if (signedHeaders.join(';') !== [...signedHeaders].sort().join(';')) return ['SignatureDoesNotMatch', 'signed headers are not sorted'];
  for (const required of ['host', 'x-amz-content-sha256', 'x-amz-date']) {
    if (!signedHeaders.includes(required)) return ['AccessDenied', `${required} is not signed`];
  }
  const values = new Map();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i].toLowerCase();
    const value = request.rawHeaders[i + 1].trim().replace(/\s+/g, ' ');
    values.set(name, values.has(name) ? `${values.get(name)},${value}` : value);
  }
  for (const name of signedHeaders) {
    if (!values.has(name)) return ['SignatureDoesNotMatch', `signed header ${name} is missing`];
  }
  const payloadHash = request.headers['x-amz-content-sha256'];
  if (payloadHash !== 'UNSIGNED-PAYLOAD') {
    if (!/^[0-9a-f]{64}$/.test(payloadHash)) return ['NotImplemented', `unsupported x-amz-content-sha256 ${payloadHash}`];
    if (sha256(body) !== payloadHash) return ['XAmzContentSHA256Mismatch', 'x-amz-content-sha256 does not match the body'];
  }
  const { path, query } = canonicalTarget(request.url);
  const canonicalRequest = [
    request.method, path, query,
    ...signedHeaders.map(name => `${name}:${values.get(name)}`), '',
    signedHeaderList, payloadHash,
  ].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const key = ['s3', 'aws4_request'].reduce(hmac, hmac(hmac(`AWS4${secretAccessKey}`, date), region));
  const expected = hmac(key, stringToSign);
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return ['SignatureDoesNotMatch', 'signature does not match'];
  return undefined;
}

const BUCKET_NAME = /^(?!\d+\.\d+\.\d+\.\d+$)(?!xn--)(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const md5Tag = body => `"${createHash('md5').update(body).digest('hex')}"`;
const xmlValues = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map(([, value]) => unescapeXml(value));

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (match[1] === '' && match[2] === '')) return undefined; // Ignored, as HTTP permits.
  let start; let end;
  if (match[1] === '') {
    start = Math.max(0, size - Number(match[2])); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) throw new S3Error(416, 'InvalidRange', 'The requested range is not satisfiable');
  return { start, end };
}

const tagMatches = (header, etag) => header.split(',').map(item => item.trim()).some(item => item === '*' || item === etag);

// RFC 9110 section 13.2.2 order: a date condition is ignored when the
// corresponding ETag condition is present. Returns 'ok', 'not modified' or 'failed'.
function evaluateConditions(object, { ifMatch, ifUnmodifiedSince, ifNoneMatch, ifModifiedSince }) {
  const date = value => { const time = Date.parse(value); return Number.isNaN(time) ? undefined : time; };
  if (ifMatch !== undefined) {
    if (!tagMatches(ifMatch, object.etag)) return 'failed';
  } else if (ifUnmodifiedSince !== undefined && date(ifUnmodifiedSince) !== undefined && object.modified.getTime() > date(ifUnmodifiedSince)) {
    return 'failed';
  }
  if (ifNoneMatch !== undefined) {
    if (tagMatches(ifNoneMatch, object.etag)) return 'not modified';
  } else if (ifModifiedSince !== undefined && date(ifModifiedSince) !== undefined && object.modified.getTime() <= date(ifModifiedSince)) {
    return 'not modified';
  }
  return 'ok';
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32Base64(body) {
  let crc = 0xffffffff;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const out = Buffer.alloc(4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return out.toString('base64');
}
const checksums = {
  'x-amz-checksum-crc32': crc32Base64,
  'x-amz-checksum-sha256': body => createHash('sha256').update(body).digest('base64'),
};

export class S3Fixture {
  constructor() {
    this.buckets = new Map();
    this.requests = [];
    // Called as intercept(info, next) for every authenticated request; may
    // return a replacement { status, headers, body } to inject a defect.
    this.intercept = undefined;
    // When set, a request with a wrong signature is served anyway (but still
    // recorded with its problem), to inject a defect in signature checking.
    this.ignoreSignatures = false;
  }

  async start(t) {
    this.server = createServer((request, response) => this.handle(request, response));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.endpoint = `http://127.0.0.1:${this.server.address().port}`;
    t?.after(() => this.stop());
    return this;
  }

  stop() {
    return new Promise(resolve => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  client(overrides = {}) {
    return new S3Client({
      endpoint: this.endpoint, region: REGION, forcePathStyle: true, maxAttempts: 1,
      credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
      ...overrides,
    });
  }

  handle(request, response) {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', async () => {
      const body = Buffer.concat(chunks);
      let result;
      const record = { method: request.method, url: request.url, headers: request.headers, body };
      this.requests.push(record);
      try {
        const problem = signatureProblem(request, body);
        record.signature = problem ? problem[1] : 'valid';
        if (problem && !this.ignoreSignatures) throw new S3Error(problem[0] === 'NotImplemented' ? 501 : problem[0] === 'XAmzContentSHA256Mismatch' ? 400 : 403, ...problem);
        const info = this.describe(request, body);
        info.signatureProblem = problem?.[1];
        record.operation = info.operation;
        const next = async () => this.dispatch(info);
        result = this.intercept ? await this.intercept(info, next) : await next();
      } catch (error) {
        if (!(error instanceof S3Error)) throw error;
        result = { status: error.status, body: errorXml(error.code, error.message, request.url) };
      }
      record.status = result.status;
      const headers = { 'x-amz-request-id': 'fixture-request', ...result.headers };
      let payload = result.body ?? '';
      if (payload && !headers['content-type'] && !headers['Content-Type']) headers['content-type'] = 'application/xml';
      if (request.method === 'HEAD' || result.status === 304 || result.status === 204) {
        if (request.method !== 'HEAD' || result.status >= 300) headers['content-type'] = undefined;
        payload = '';
      }
      for (const [name, value] of Object.entries(headers)) if (value === undefined) delete headers[name];
      if (!('content-length' in headers)) headers['content-length'] = Buffer.byteLength(payload);
      response.writeHead(result.status, headers);
      response.end(payload);
    });
  }

  describe(request, body) {
    const url = new URL(request.url, 'http://fixture');
    const [, rawBucket = '', ...rawKey] = url.pathname.split('/');
    const bucket = decodeComponent(rawBucket, 'path');
    const key = decodeComponent(rawKey.join('/'), 'path');
    const query = url.searchParams;
    const method = request.method;
    let operation;
    if (!bucket) operation = method === 'GET' ? 'ListBuckets' : undefined;
    else if (!rawKey.length || (rawKey.length === 1 && !key)) {
      operation = {
        PUT: 'CreateBucket', HEAD: 'HeadBucket', DELETE: 'DeleteBucket',
        GET: query.has('location') ? 'GetBucketLocation' : query.has('encryption') ? 'GetBucketEncryption' : 'ListObjects',
        POST: query.has('delete') ? 'DeleteObjects' : undefined,
      }[method];
    } else {
      operation = { PUT: request.headers['x-amz-copy-source'] === undefined ? 'PutObject' : 'CopyObject', GET: 'GetObject', HEAD: 'HeadObject', DELETE: 'DeleteObject' }[method];
    }
    return { operation, bucket, key, query, headers: request.headers, body, method };
  }

  bucket(name) {
    const bucket = this.buckets.get(name);
    if (!bucket) throw new S3Error(404, 'NoSuchBucket', 'The specified bucket does not exist');
    return bucket;
  }

  dispatch(info) {
    const { operation } = info;
    if (!operation || !this[operation]) throw new S3Error(501, 'NotImplemented', `${info.method} is not implemented by the fixture`);
    return this[operation](info);
  }

  ListBuckets() {
    const buckets = [...this.buckets].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, { created }]) =>
      `<Bucket><Name>${escapeXml(name)}</Name><CreationDate>${created.toISOString()}</CreationDate></Bucket>`).join('');
    return { status: 200, body: `<?xml version="1.0" encoding="UTF-8"?>\n<ListAllMyBucketsResult xmlns="${XMLNS}">` +
      `<Owner><ID>fixture-owner</ID></Owner><Buckets>${buckets}</Buckets></ListAllMyBucketsResult>` };
  }

  CreateBucket({ bucket, body }) {
    if (!BUCKET_NAME.test(bucket)) throw new S3Error(400, 'InvalidBucketName', 'The specified bucket is not valid');
    const constraint = xmlValues(body.toString(), 'LocationConstraint')[0];
    if (body.length && !/<CreateBucketConfiguration[\s>]/.test(body.toString())) throw new S3Error(400, 'MalformedXML');
    if ((constraint ?? REGION) !== REGION && constraint !== '') throw new S3Error(400, 'IllegalLocationConstraintException');
    // us-east-1 keeps the legacy response to a repeat creation by the owner.
    if (!this.buckets.has(bucket)) this.buckets.set(bucket, { created: new Date(), objects: new Map() });
    return { status: 200, headers: { location: `/${bucket}` } };
  }

  HeadBucket({ bucket }) {
    this.bucket(bucket);
    return { status: 200, headers: { 'x-amz-bucket-region': REGION } };
  }

  GetBucketLocation({ bucket }) {
    this.bucket(bucket);
    return { status: 200, body: `<?xml version="1.0" encoding="UTF-8"?>\n<LocationConstraint xmlns="${XMLNS}"></LocationConstraint>` };
  }

  GetBucketEncryption({ bucket }) {
    this.bucket(bucket);
    return { status: 200, body: `<?xml version="1.0" encoding="UTF-8"?>\n<ServerSideEncryptionConfiguration xmlns="${XMLNS}"><Rule>` +
      '<ApplyServerSideEncryptionByDefault><SSEAlgorithm>AES256</SSEAlgorithm></ApplyServerSideEncryptionByDefault>' +
      '<BucketKeyEnabled>false</BucketKeyEnabled></Rule></ServerSideEncryptionConfiguration>' };
  }

  DeleteBucket({ bucket }) {
    if (this.bucket(bucket).objects.size) throw new S3Error(409, 'BucketNotEmpty', 'The bucket you tried to delete is not empty');
    this.buckets.delete(bucket);
    return { status: 204 };
  }

  PutObject({ bucket, key, headers, body }) {
    const target = this.bucket(bucket);
    if (headers['content-encoding']?.includes('aws-chunked')) throw new S3Error(501, 'NotImplemented', 'aws-chunked uploads are not implemented by the fixture');
    const md5 = headers['content-md5'];
    if (md5 !== undefined) {
      const digest = Buffer.from(md5, 'base64');
      if (digest.length !== 16 || digest.toString('base64') !== md5) throw new S3Error(400, 'InvalidDigest', 'The Content-MD5 you specified was invalid');
      if (!digest.equals(createHash('md5').update(body).digest())) throw new S3Error(400, 'BadDigest', 'The Content-MD5 you specified did not match what we received');
    }
    const echoed = {};
    for (const [name, calculate] of Object.entries(checksums)) {
      if (headers[name] === undefined) continue;
      if (headers[name] !== calculate(body)) throw new S3Error(400, 'BadDigest', `The ${name.slice(15).toUpperCase()} you specified did not match the calculated checksum`);
      echoed[name] = headers[name];
    }
    const metadata = Object.fromEntries(Object.entries(headers).filter(([name]) => name.startsWith('x-amz-meta-')));
    const etag = md5Tag(body);
    target.objects.set(key, this.object(body, metadata, headers));
    return { status: 200, headers: { etag, 'x-amz-server-side-encryption': 'AES256', ...echoed } };
  }

  object(body, metadata, headers) {
    return {
      body, etag: md5Tag(body), metadata, modified: new Date(Math.floor(Date.now() / 1000) * 1000),
      type: headers['content-type'] ?? 'binary/octet-stream',
      cacheControl: headers['cache-control'], disposition: headers['content-disposition'],
    };
  }

  CopyObject({ bucket, key, headers }) {
    const destination = this.bucket(bucket);
    const [rawSource] = headers['x-amz-copy-source'].replace(/^\//, '').split('?');
    const slash = rawSource.indexOf('/');
    if (slash <= 0) throw new S3Error(400, 'InvalidArgument', 'Invalid copy source');
    const sourceKey = decodeComponent(rawSource.slice(slash + 1), 'copy source');
    const object = this.bucket(decodeComponent(rawSource.slice(0, slash), 'copy source')).objects.get(sourceKey);
    if (!object) throw new S3Error(404, 'NoSuchKey', 'The specified key does not exist');
    const outcome = evaluateConditions(object, {
      ifMatch: headers['x-amz-copy-source-if-match'], ifUnmodifiedSince: headers['x-amz-copy-source-if-unmodified-since'],
      ifNoneMatch: headers['x-amz-copy-source-if-none-match'], ifModifiedSince: headers['x-amz-copy-source-if-modified-since'],
    });
    if (outcome !== 'ok') throw new S3Error(412, 'PreconditionFailed', 'At least one of the preconditions you specified did not hold');
    const replace = headers['x-amz-metadata-directive'] === 'REPLACE';
    if (!replace && destination === this.buckets.get(decodeComponent(rawSource.slice(0, slash), 'copy source')) && sourceKey === key) {
      throw new S3Error(400, 'InvalidRequest', 'This copy request is illegal because it is trying to copy an object to itself without changing anything');
    }
    const copy = replace
      ? this.object(object.body, Object.fromEntries(Object.entries(headers).filter(([name]) => name.startsWith('x-amz-meta-'))), headers)
      : { ...object, modified: new Date(Math.floor(Date.now() / 1000) * 1000) };
    destination.objects.set(key, copy);
    return { status: 200, headers: { 'x-amz-server-side-encryption': 'AES256' }, body: `<?xml version="1.0" encoding="UTF-8"?>\n<CopyObjectResult xmlns="${XMLNS}">` +
      `<LastModified>${copy.modified.toISOString()}</LastModified><ETag>${escapeXml(copy.etag)}</ETag></CopyObjectResult>` };
  }

  GetObject({ bucket, key, headers, method }) {
    const object = this.bucket(bucket).objects.get(key);
    if (!object) throw new S3Error(404, 'NoSuchKey', 'The specified key does not exist');
    const outcome = evaluateConditions(object, {
      ifMatch: headers['if-match'], ifUnmodifiedSince: headers['if-unmodified-since'],
      ifNoneMatch: headers['if-none-match'], ifModifiedSince: headers['if-modified-since'],
    });
    if (outcome === 'failed') throw new S3Error(412, 'PreconditionFailed', 'At least one of the preconditions you specified did not hold');
    const common = { etag: object.etag, 'last-modified': object.modified.toUTCString() };
    if (outcome === 'not modified') return { status: 304, headers: common };
    const range = headers.range === undefined ? undefined : parseRange(headers.range, object.body.length);
    const body = range ? object.body.subarray(range.start, range.end + 1) : object.body;
    const result = {
      status: range ? 206 : 200,
      headers: {
        ...common, ...object.metadata, 'content-type': object.type, 'content-length': body.length, 'accept-ranges': 'bytes',
        'cache-control': object.cacheControl, 'content-disposition': object.disposition, 'x-amz-server-side-encryption': 'AES256',
        'content-range': range ? `bytes ${range.start}-${range.end}/${object.body.length}` : undefined,
      },
      body: method === 'HEAD' ? '' : body,
    };
    return result;
  }

  HeadObject(info) {
    return this.GetObject(info);
  }

  DeleteObject({ bucket, key }) {
    this.bucket(bucket).objects.delete(key);
    return { status: 204 };
  }

  DeleteObjects({ bucket, body }) {
    const target = this.bucket(bucket);
    const xml = body.toString();
    if (!/^(<\?xml[^>]*\?>)?\s*<Delete[\s>]/.test(xml)) throw new S3Error(400, 'MalformedXML');
    const keys = [...xml.matchAll(/<Object>([\s\S]*?)<\/Object>/g)].map(([, object]) => xmlValues(object, 'Key')[0]);
    if (!keys.length || keys.length > 1000 || keys.includes(undefined)) throw new S3Error(400, 'MalformedXML', 'The XML you provided was not well-formed');
    const quiet = xmlValues(xml, 'Quiet')[0] === 'true';
    for (const key of keys) target.objects.delete(key);
    const deleted = quiet ? '' : keys.map(key => `<Deleted><Key>${escapeXml(key)}</Key></Deleted>`).join('');
    return { status: 200, body: `<?xml version="1.0" encoding="UTF-8"?>\n<DeleteResult xmlns="${XMLNS}">${deleted}</DeleteResult>` };
  }
}
