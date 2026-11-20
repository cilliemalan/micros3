import assert from 'node:assert/strict';
import test from 'node:test';
import { etagOf } from '../checks/integrity.js';
import {
  CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, HeadObjectCommand, PutObjectCommand,
} from '@aws-sdk/client-s3';
import checks from '../checks/object.js';

const run = checks.find(check => check.name === 'HeadObject').run;
const ok = (httpStatusCode, fields = {}) => ({ ...fields, $metadata: { httpStatusCode } });
function s3Error(name, httpStatusCode) {
  const error = new Error(name);
  error.name = name;
  error.$metadata = { httpStatusCode };
  return error;
}

class FakeS3 {
  constructor(intercept) {
    this.config = { region: async () => 'eu-west-1' };
    this.intercept = intercept;
    this.buckets = new Map();
    this.calls = [];
  }
  async send(command) {
    this.calls.push(command);
    const next = () => this.respond(command);
    return this.intercept ? this.intercept(command, this, next) : next();
  }
  async respond(command) {
    const { Bucket, Key } = command.input;
    if (command instanceof CreateBucketCommand) {
      if (this.buckets.has(Bucket)) throw s3Error('BucketAlreadyExists', 409);
      this.buckets.set(Bucket, new Map());
      return ok(200);
    }
    const objects = this.buckets.get(Bucket);
    if (!objects) throw s3Error(command instanceof HeadObjectCommand ? 'NotFound' : 'NoSuchBucket', 404);
    if (command instanceof DeleteBucketCommand) {
      if (objects.size) throw s3Error('BucketNotEmpty', 409);
      this.buckets.delete(Bucket);
      return ok(204);
    }
    if (command instanceof PutObjectCommand) {
      const { Body, ContentType, CacheControl, ContentDisposition, Metadata } = command.input;
      const ETag = etagOf(Buffer.from(Body));
      objects.set(Key, { Body: Buffer.from(Body), ContentType, CacheControl, ContentDisposition, Metadata, ETag });
      return ok(200, { ETag });
    }
    if (command instanceof DeleteObjectCommand) {
      objects.delete(Key);
      return ok(204);
    }
    if (command instanceof HeadObjectCommand) {
      const object = objects.get(Key);
      if (!object) throw s3Error('NotFound', 404);
      const { IfMatch, IfNoneMatch, Range } = command.input;
      if (IfMatch && IfMatch !== object.ETag) throw s3Error('PreconditionFailed', 412);
      if (IfNoneMatch === object.ETag) throw s3Error('NotModified', 304);
      let ContentLength = object.Body.length;
      let ContentRange;
      if (Range) {
        const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(Range);
        if (+start >= ContentLength) throw s3Error('InvalidRange', 416);
        ContentRange = `bytes ${start}-${end}/${ContentLength}`;
        ContentLength = +end - +start + 1;
      }
      const { ETag, ContentType, CacheControl, ContentDisposition, Metadata } = object;
      return ok(Range ? 206 : 200, { ContentLength, ContentRange, ETag, ContentType, CacheControl,
        ContentDisposition, Metadata, LastModified: new Date('2024-01-02T03:04:05Z') });
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  }
}

test('HeadObject verifies isolated resources and cleans up on repeated runs', async () => {
  const client = new FakeS3();
  client.buckets.set('existing', new Map([['keep', { Body: Buffer.from('keep') }]]));
  await run({ client });
  await run({ client });
  assert.deepEqual([...client.buckets.keys()], ['existing']);
  assert.equal(client.buckets.get('existing').get('keep').Body.toString(), 'keep');
  const creates = client.calls.filter(c => c instanceof CreateBucketCommand);
  assert.equal(creates.length, 4);
  assert.equal(new Set(creates.map(c => c.input.Bucket)).size, 4);
  for (const { input } of creates) {
    assert.match(input.Bucket, /^micros3-verify-[0-9a-f-]{36}$/);
    assert.deepEqual(input.CreateBucketConfiguration, { LocationConstraint: 'eu-west-1' });
  }
  assert.ok(!client.calls.some(c => c instanceof DeleteBucketCommand && c.input.Bucket === 'existing'));
});

test('HeadObject accepts a successful range response without ContentRange', async () => {
  const client = new FakeS3(async (command, service, next) => {
    const result = await next();
    if (command instanceof HeadObjectCommand && command.input.Range === 'bytes=1-3') {
      result.$metadata.httpStatusCode = 200;
      delete result.ContentRange;
    }
    return result;
  });
  await run({ client });
  assert.equal(client.buckets.size, 0);
});

test('HeadObject detects wrong response status, headers, metadata and body', async () => {
  const faults = [
    ['status', r => { r.$metadata.httpStatusCode = 201; }],
    ['ContentLength', r => { r.ContentLength++; }],
    ['ETag', r => { r.ETag = 'wrong'; }],
    ['ContentType', r => { r.ContentType = 'wrong'; }],
    ['metadata', r => { r.Metadata = { revision: 'one' }; }],
    ['LastModified', r => { r.LastModified = new Date('invalid'); }],
    ['body', r => { r.Body = Buffer.from('bad'); }],
    ['CacheControl', r => { r.CacheControl = undefined; }],
    ['ContentDisposition', r => { r.ContentDisposition = undefined; }],
  ];
  for (const [label, mutate] of faults) {
    const client = new FakeS3(async (command, service, next) => {
      const result = await next();
      if (command instanceof HeadObjectCommand && command.input.Key.startsWith('nested/')) mutate(result);
      return result;
    });
    await assert.rejects(run({ client }), new RegExp(label, 'i'));
    assert.equal(client.buckets.size, 0, label);
  }
});

test('HeadObject detects wrong empty and overwritten object metadata and isolation', async () => {
  for (const mode of ['empty', 'overwrite', 'stale headers', 'other key']) {
    const client = new FakeS3(async (command, service, next) => {
      const result = await next();
      if (command instanceof HeadObjectCommand) {
        const puts = service.calls.filter(c => c instanceof PutObjectCommand).length;
        if (mode === 'empty' && command.input.Key === 'empty') result.ContentLength = 1;
        if (mode === 'overwrite' && puts === 3 && command.input.Key.startsWith('nested/')) result.Metadata = { revision: 'one' };
        if (mode === 'stale headers' && puts === 3 && command.input.Key.startsWith('nested/')) result.CacheControl = 'max-age=123';
        if (mode === 'other key' && puts === 3 && command.input.Key === 'empty') result.ETag = 'wrong';
      }
      return result;
    });
    await assert.rejects(run({ client }), undefined, mode);
    assert.equal(client.buckets.size, 0, mode);
  }
});

test('HeadObject checks missing keys and buckets, ranges and conditional requests', async () => {
  for (const mode of ['missing key success', 'missing key status', 'missing bucket success', 'missing bucket status',
    'range status', 'range length', 'range header', 'range etag', 'range body', 'invalid range',
    'IfMatch failure', 'IfMatch wrong status', 'IfMatch success', 'IfNoneMatch failure', 'IfNoneMatch wrong status', 'IfNoneMatch success']) {
    const client = new FakeS3(async (command, service, next) => {
      if (!(command instanceof HeadObjectCommand)) return next();
      const { Bucket, Key, Range, IfMatch, IfNoneMatch } = command.input;
      if (Key === 'absent' && mode === 'missing key success') return ok(200);
      if (Key === 'absent' && mode === 'missing key status') throw s3Error('AccessDenied', 403);
      if (!service.buckets.has(Bucket) && mode === 'missing bucket success') return ok(200);
      if (!service.buckets.has(Bucket) && mode === 'missing bucket status') throw s3Error('AccessDenied', 403);
      if (Range === 'bytes=100-200' && mode === 'invalid range') return ok(200);
      if (IfMatch === '"not-the-etag"' && mode === 'IfMatch failure') return ok(200);
      if (IfMatch === '"not-the-etag"' && mode === 'IfMatch wrong status') throw s3Error('NotFound', 404);
      if (IfMatch && IfMatch !== '"not-the-etag"' && mode === 'IfMatch success') throw s3Error('PreconditionFailed', 412);
      if (IfNoneMatch && IfNoneMatch !== '"not-the-etag"' && mode === 'IfNoneMatch failure') return ok(200);
      if (IfNoneMatch && IfNoneMatch !== '"not-the-etag"' && mode === 'IfNoneMatch wrong status') throw s3Error('NotFound', 404);
      if (IfNoneMatch === '"not-the-etag"' && mode === 'IfNoneMatch success') throw s3Error('NotModified', 304);
      const result = await next();
      if (Range === 'bytes=1-3') {
        if (mode === 'range status') result.$metadata.httpStatusCode = 201;
        if (mode === 'range length') result.ContentLength = 7;
        if (mode === 'range header') result.ContentRange = 'bytes 0-2/7';
        if (mode === 'range etag') result.ETag = 'wrong';
        if (mode === 'range body') result.Body = Buffer.from('bad');
      }
      return result;
    });
    await assert.rejects(run({ client }), undefined, mode);
    assert.equal(client.buckets.size, 0, mode);
  }
});

test('HeadObject cleans attempted uploads after an ambiguous failure and reports cleanup failures', async () => {
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof PutObjectCommand) {
      await next();
      throw new Error('upload response lost');
    }
    return next();
  });
  await assert.rejects(run({ client }), /upload response lost/);
  assert.equal(client.buckets.size, 0);
  assert.ok(client.calls.some(c => c instanceof DeleteObjectCommand && c.input.Key.startsWith('nested/')));

  const failing = new FakeS3((command, service, next) => {
    if (command instanceof PutObjectCommand) throw new Error('upload failed');
    if (command instanceof DeleteObjectCommand) throw new Error('object cleanup failed');
    return next();
  });
  await assert.rejects(run({ client: failing }), error => {
    assert.match(error.message, /upload failed/);
    assert.match(error.message, /cleanup failed.*object cleanup failed/i);
    return true;
  });
  assert.equal(failing.calls.filter(c => c instanceof DeleteObjectCommand).length, 3);
  assert.equal(failing.buckets.size, 0);
});

test('HeadObject does not delete a bucket after a rejected creation', async () => {
  const client = new FakeS3((command, service, next) => {
    if (command instanceof CreateBucketCommand) throw s3Error('BucketAlreadyExists', 409);
    return next();
  });
  await assert.rejects(run({ client }), /BucketAlreadyExists/);
  assert.ok(!client.calls.some(c => c instanceof DeleteBucketCommand || c instanceof DeleteObjectCommand));
});

test('HeadObject cleanup reports a wrong 404 rather than hiding it', async () => {
  const client = new FakeS3((command, service, next) => {
    if (command instanceof DeleteObjectCommand) throw s3Error('AccessDenied', 404);
    return next();
  });
  await assert.rejects(run({ client }), /cleanup failed.*AccessDenied/i);
  assert.equal(client.calls.filter(c => c instanceof DeleteObjectCommand).length, 3);
});

test('HeadObject cleanup stays armed if the missing-bucket request recreates its bucket', async () => {
  const client = new FakeS3((command, service, next) => {
    if (command instanceof HeadObjectCommand && !service.buckets.has(command.input.Bucket)) {
      service.buckets.set(command.input.Bucket, new Map());
      return ok(200);
    }
    return next();
  });
  await assert.rejects(run({ client }), /missing bucket/);
  assert.equal(client.buckets.size, 0);
});
