import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateBucketCommand, CreateMultipartUploadCommand,
  DeleteBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, ListMultipartUploadsCommand,
  ListPartsCommand, PutObjectCommand, UploadPartCommand,
} from '@aws-sdk/client-s3';
import checks from '../checks/multipart.js';
import { PrerequisiteError, runTests } from '../test-runner.js';
import { runVerification } from '../verification.js';

const check = name => checks.find(c => c.name === name).run;
const run = check('ListParts');
const ok = (httpStatusCode, fields = {}) => ({ ...fields, $metadata: { httpStatusCode } });
const error = (name, httpStatusCode = 404) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });

// A minimal S3 model with ListParts pagination, shared by the multipart checks.
class FakeS3 {
  constructor(intercept) {
    this.config = { region: async () => 'us-east-1' };
    this.buckets = new Map(); this.calls = []; this.nextId = 0; this.intercept = intercept;
  }
  async send(command) {
    this.calls.push(command);
    const next = () => this.respond(command);
    return this.intercept ? this.intercept(command, this, next) : next();
  }
  async respond(command) {
    const { Bucket, Key, UploadId, PartNumber } = command.input;
    if (command instanceof CreateBucketCommand) {
      this.buckets.set(Bucket, { objects: new Map(), uploads: new Map() }); return ok(200);
    }
    const bucket = this.buckets.get(Bucket);
    if (!bucket) throw error('NoSuchBucket');
    if (command instanceof HeadBucketCommand) return ok(200);
    if (command instanceof DeleteBucketCommand) {
      if (bucket.objects.size || bucket.uploads.size) throw error('BucketNotEmpty', 409);
      this.buckets.delete(Bucket); return ok(204);
    }
    if (command instanceof PutObjectCommand) {
      bucket.objects.set(Key, { body: Buffer.from(command.input.Body), ContentType: command.input.ContentType }); return ok(200);
    }
    if (command instanceof DeleteObjectCommand) { bucket.objects.delete(Key); return ok(204); }
    if (command instanceof GetObjectCommand) {
      const object = bucket.objects.get(Key);
      if (!object) throw error('NoSuchKey');
      return ok(200, { ...object.headers, ContentType: object.ContentType, Metadata: object.Metadata, ETag: object.ETag,
        ContentLength: object.body.length, Body: { transformToByteArray: async () => object.body } });
    }
    if (command instanceof CreateMultipartUploadCommand) {
      const id = `upload-${++this.nextId}`;
      const { ContentType, CacheControl, Metadata } = command.input;
      bucket.uploads.set(id, { Key, UploadId: id, parts: new Map(), ContentType, CacheControl, Metadata });
      return ok(200, { Bucket, Key, UploadId: id });
    }
    if (command instanceof ListMultipartUploadsCommand) return ok(200, { IsTruncated: false, Uploads: [...bucket.uploads.values()] });
    const upload = bucket.uploads.get(UploadId);
    if (!upload || upload.Key !== Key) throw error('NoSuchUpload');
    if (command instanceof AbortMultipartUploadCommand) { bucket.uploads.delete(UploadId); return ok(204); }
    if (command instanceof UploadPartCommand) {
      if (PartNumber < 1 || PartNumber > 10000) throw error('InvalidArgument', 400);
      const body = Buffer.from(command.input.Body);
      const ETag = `"${createHash('md5').update(body).digest('hex')}"`;
      upload.parts.set(PartNumber, { PartNumber, ETag, Size: body.length, LastModified: new Date(), body });
      return ok(200, { ETag });
    }
    if (command instanceof ListPartsCommand) {
      const MaxParts = command.input.MaxParts ?? 1000;
      const marker = Number(command.input.PartNumberMarker ?? 0);
      const after = [...upload.parts.values()].sort((a, b) => a.PartNumber - b.PartNumber).filter(p => p.PartNumber > marker);
      const Parts = after.slice(0, MaxParts).map(({ body, ...part }) => part);
      const IsTruncated = after.length > MaxParts;
      return ok(200, { Bucket, Key, UploadId, StorageClass: 'STANDARD', MaxParts, IsTruncated, Parts,
        PartNumberMarker: String(marker), NextPartNumberMarker: Parts.length ? String(Parts.at(-1).PartNumber) : undefined });
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      const selected = command.input.MultipartUpload.Parts;
      const parts = selected.map(part => {
        const stored = upload.parts.get(part.PartNumber);
        if (!stored || stored.ETag !== part.ETag) throw error('InvalidPart', 400);
        return stored;
      });
      for (let i = 1; i < selected.length; i++) {
        if (selected[i].PartNumber <= selected[i - 1].PartNumber) throw error('InvalidPartOrder', 400);
      }
      if (parts.slice(0, -1).some(part => part.Size < 5 * 1024 * 1024)) throw error('EntityTooSmall', 400);
      const ETag = `"${createHash('md5').update(Buffer.concat(parts.map(p => Buffer.from(p.ETag.slice(1, -1), 'hex')))).digest('hex')}-${parts.length}"`;
      bucket.objects.set(Key, { body: Buffer.concat(parts.map(p => p.body)), ContentType: upload.ContentType ?? 'binary/octet-stream',
        Metadata: upload.Metadata ?? {}, headers: { CacheControl: upload.CacheControl }, ETag });
      bucket.uploads.delete(UploadId);
      return ok(200, { Bucket, Key, ETag });
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  }
}

test('ListParts verifies parts, pagination and missing uploads, cleaning repeated runs', async () => {
  const client = new FakeS3();
  client.buckets.set('existing', { objects: new Map([['keep', { body: Buffer.from('keep') }]]), uploads: new Map() });
  await run({ client }); await run({ client });
  const buckets = client.calls.filter(c => c instanceof CreateBucketCommand).map(c => c.input.Bucket);
  assert.equal(new Set(buckets).size, 6);
  assert.deepEqual([...client.buckets.keys()], ['existing']);
  const paged = client.calls.filter(c => c instanceof ListPartsCommand && c.input.MaxParts === 1);
  assert.deepEqual(paged.map(c => c.input.PartNumberMarker), [undefined, '1', '2', '3', undefined, '1', '2', '3']);
});

test('ListParts accepts NoSuchUpload for an upload in a missing bucket', async () => {
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof ListPartsCommand && !service.buckets.has(command.input.Bucket)) throw error('NoSuchUpload');
    return next();
  });
  await run({ client });
  assert.equal(client.buckets.size, 0);
});

test('ListParts detects incorrect listings, pagination and errors', async () => {
  const modes = {
    'status': (c, r) => { r.$metadata.httpStatusCode = 201; },
    'bucket': (c, r) => { r.Bucket = 'other'; },
    'key': (c, r) => { r.Key = 'other'; },
    'upload id': (c, r) => { r.UploadId = 'other'; },
    'storage class': (c, r) => { delete r.StorageClass; },
    'truncation flag': (c, r) => { delete r.IsTruncated; },
    'leftover parts': (c, r) => { if (!r.Parts.length) r.Parts = [{ PartNumber: 1, ETag: '"x"', Size: 1, LastModified: new Date() }]; },
    'order': (c, r) => { r.Parts.reverse(); },
    'replacement': (c, r) => { const p = r.Parts.find(p => p.PartNumber === 1); if (p) p.Size = 14; },
    'etag': (c, r) => { if (r.Parts[0]) r.Parts[0].ETag = '"wrong"'; },
    'size': (c, r) => { if (r.Parts[0]) r.Parts[0].Size += 1; },
    'last modified': (c, r) => { if (r.Parts[0]) delete r.Parts[0].LastModified; },
    'max parts echo': (c, r) => { if (c.input.MaxParts) r.MaxParts = 1000; },
    'marker echo': (c, r) => { if (c.input.PartNumberMarker) r.PartNumberMarker = '0'; },
    'ignores max parts': (c, r, s) => { if (c.input.MaxParts) { r.IsTruncated = false; } },
    'next marker': (c, r) => { if (r.IsTruncated) r.NextPartNumberMarker = String(Number(r.NextPartNumberMarker) + 1); },
    'missing next marker': (c, r) => { delete r.NextPartNumberMarker; },
    'ignores marker': (c, r) => { if (c.input.PartNumberMarker === '7') r.Parts = [{ PartNumber: 7, ETag: '"x"', Size: 0, LastModified: new Date() }]; },
    'same key': (c, r) => { if (c.input.UploadId === 'upload-2') r.Parts = []; },
  };
  for (const [mode, mutate] of Object.entries(modes)) {
    const client = new FakeS3(async (command, service, next) => {
      const result = await next();
      if (command instanceof ListPartsCommand) mutate(command, result, service);
      return result;
    });
    await assert.rejects(run({ client }), undefined, mode);
    assert.equal(client.buckets.size, 0, mode);
  }
  const missing = {
    'wrong key': c => c.input.Key.endsWith('/child') && c.input.UploadId === 'upload-1',
    'missing upload': c => c.input.UploadId === 'nonexistent-upload-id',
    'wrong bucket': (c, s) => c.input.UploadId === 'upload-1' && !s.buckets.get(c.input.Bucket)?.uploads.has('upload-1'),
    'aborted upload': (c, s) => c.input.UploadId === 'upload-3' && s.calls.some(x => x instanceof AbortMultipartUploadCommand),
    'completed upload': (c, s) => c.input.UploadId === 'upload-2' && s.calls.some(x => x instanceof CompleteMultipartUploadCommand),
    'missing bucket': (c, s) => !s.buckets.has(c.input.Bucket),
  };
  for (const [mode, matches] of Object.entries(missing)) {
    const client = new FakeS3(async (command, service, next) => {
      if (command instanceof ListPartsCommand && matches(command, service)) return ok(200, { IsTruncated: false, Parts: [] });
      return next();
    });
    await assert.rejects(run({ client }), new RegExp(`ListParts ${mode}`), mode);
    assert.equal(client.buckets.size, 0, mode);
  }
});

test('ListParts cleans uploads it created when a request fails', async () => {
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof ListPartsCommand) throw error('NotImplemented', 501);
    return next();
  });
  await assert.rejects(run({ client }), /NotImplemented/);
  assert.equal(client.buckets.size, 0);
  assert.equal(client.calls.filter(c => c instanceof AbortMultipartUploadCommand).length, 3);
});

const unsupported = () => new FakeS3(async (command, service, next) => {
  if (command instanceof ListPartsCommand) throw error('NotImplemented', 501);
  return next();
});

for (const name of ['UploadPart', 'CompleteMultipartUpload', 'AbortMultipartUpload']) {
  test(`${name} reports an unsupported ListParts as a missing prerequisite`, async () => {
    const client = unsupported();
    await assert.rejects(check(name)({ client }), err => {
      assert.ok(err instanceof PrerequisiteError, err.message);
      assert.equal(err.operation, 'ListParts');
      assert.match(err.message, /^prerequisite ListParts failed: NotImplemented/);
      return true;
    });
    assert.equal(client.buckets.size, 0);
  });
}

test('a ListParts listing showing a finished upload is the tested operation failing', async () => {
  for (const [name, finished] of [['AbortMultipartUpload', AbortMultipartUploadCommand], ['CompleteMultipartUpload', CompleteMultipartUploadCommand]]) {
    const done = new Set();
    const client = new FakeS3(async (command, service, next) => {
      if (command instanceof finished && !(command instanceof AbortMultipartUploadCommand && command.input.UploadId === 'missing')) {
        const result = await next();
        done.add(command.input.UploadId);
        return result;
      }
      if (command instanceof ListPartsCommand && done.has(command.input.UploadId)) return ok(200, { IsTruncated: false, Parts: [] });
      return next();
    });
    await assert.rejects(check(name)({ client }), err => {
      assert.ok(!(err instanceof PrerequisiteError), `${name}: ${err.message}`);
      assert.match(err.message, /ListParts still lists the upload/);
      return true;
    }, name);
  }
});

test('a ListParts error other than NoSuchUpload for a finished upload is a missing prerequisite', async () => {
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof ListPartsCommand && service.calls.some(c => c instanceof AbortMultipartUploadCommand)) throw error('InternalError', 500);
    return next();
  });
  await assert.rejects(check('AbortMultipartUpload')({ client }), PrerequisiteError);
});

test('the runner reports blocked checks separately, including after cleanup failures', async () => {
  const lines = [];
  const blocked = new PrerequisiteError('ListParts', new Error('NotImplemented'));
  const suites = [{ name: 'Multipart', tests: [
    { name: 'blocked', run() { throw blocked; } },
    { name: 'blocked with cleanup failure', run() { throw new AggregateError([blocked, new Error('cleanup')], `${blocked.message}; cleanup failed`); } },
    { name: 'failed', run() { throw new Error('broken'); } },
    { name: 'passed', run() {} },
  ] }];
  assert.deepEqual(await runTests(suites, {}, { log: line => lines.push(line) }), { passed: 1, failed: 1, blocked: 2, notRun: 0 });
  assert.deepEqual(lines, [
    '\nMultipart:',
    '  BLOCKED blocked: prerequisite ListParts failed: NotImplemented',
    '  BLOCKED blocked with cleanup failure: prerequisite ListParts failed: NotImplemented; cleanup failed',
    '  FAIL failed: broken',
    '  PASS passed',
    '\nResults: 1 passed, 1 failed, 2 blocked',
  ]);
});

test('verification fails when a check is blocked by a missing prerequisite', async () => {
  const client = { async send() {}, destroy() {} };
  const suites = [{ name: 'Multipart', tests: [{ name: 'blocked', run() {
    throw new PrerequisiteError('ListParts', new Error('NotImplemented'));
  } }] }];
  assert.equal(await runVerification(client, suites, { log() {}, error() {} }), false);
});
