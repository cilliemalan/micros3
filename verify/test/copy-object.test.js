import assert from 'node:assert/strict';
import test from 'node:test';
import { CopyObjectCommand, CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import checks from '../checks/object.js';

const run = checks.find(check => check.name === 'CopyObject').run;
const ok = (httpStatusCode, fields = {}) => ({ ...fields, $metadata: { httpStatusCode } });
const error = (name, httpStatusCode) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });

class FakeS3 {
  constructor(intercept) {
    this.config = { region: async () => 'us-east-1' };
    this.buckets = new Map();
    this.calls = [];
    this.intercept = intercept;
  }
  async send(command) {
    this.calls.push(command);
    const next = () => this.respond(command);
    return this.intercept ? this.intercept(command, this, next) : next();
  }
  async respond(command) {
    const { Bucket, Key } = command.input;
    if (command instanceof CreateBucketCommand) {
      this.buckets.set(Bucket, new Map());
      return ok(200);
    }
    const objects = this.buckets.get(Bucket);
    if (!objects) throw error('NoSuchBucket', 404);
    if (command instanceof DeleteBucketCommand) {
      if (objects.size) throw error('BucketNotEmpty', 409);
      this.buckets.delete(Bucket);
      return ok(204);
    }
    if (command instanceof DeleteObjectCommand) { objects.delete(Key); return ok(204); }
    if (command instanceof PutObjectCommand) {
      const { Body, ContentType, CacheControl, ContentDisposition, Metadata } = command.input;
      const ETag = `"${Buffer.from(Body).toString('hex')}"`;
      objects.set(Key, { Body: Buffer.from(Body), ContentType, CacheControl, ContentDisposition, Metadata, ETag });
      return ok(200, { ETag });
    }
    if (command instanceof GetObjectCommand) {
      const object = objects.get(Key);
      if (!object) throw error('NoSuchKey', 404);
      return ok(200, { ...object, Body: { transformToByteArray: async () => object.Body }, ContentLength: object.Body.length });
    }
    if (command instanceof CopyObjectCommand) {
      const { CopySource, CopySourceIfMatch, CopySourceIfNoneMatch, MetadataDirective } = command.input;
      const [bucket, ...parts] = CopySource.split('/');
      const sourceBucket = this.buckets.get(bucket);
      if (!sourceBucket) throw error('NoSuchBucket', 404);
      const source = sourceBucket.get(parts.map(decodeURIComponent).join('/'));
      if (!source) throw error('NoSuchKey', 404);
      if ((CopySourceIfMatch && CopySourceIfMatch !== source.ETag) || CopySourceIfNoneMatch === source.ETag) {
        throw error('PreconditionFailed', 412);
      }
      const object = { ...source, Body: Buffer.from(source.Body) };
      if (MetadataDirective === 'REPLACE') {
        const { ContentType, CacheControl, ContentDisposition, Metadata } = command.input;
        Object.assign(object, { ContentType, CacheControl, ContentDisposition, Metadata });
      }
      objects.set(Key, object);
      return ok(200, { CopyObjectResult: { ETag: object.ETag, LastModified: new Date('2024-01-02') } });
    }
    throw new Error(`Unexpected ${command.constructor.name}`);
  }
}

test('CopyObject runs independently, URL-encodes source keys and cleans isolated buckets', async () => {
  const client = new FakeS3();
  client.buckets.set('existing', new Map([['keep', 'untouched']]));
  await run({ client });
  await run({ client });
  assert.deepEqual([...client.buckets.keys()], ['existing']);
  assert.equal(client.buckets.get('existing').get('keep'), 'untouched');
  const created = client.calls.filter(c => c instanceof CreateBucketCommand).map(c => c.input.Bucket);
  assert.equal(created.length, 8);
  assert.equal(new Set(created).size, created.length);
  assert.ok(client.calls.some(c => c instanceof CopyObjectCommand && c.input.CopySource.endsWith('/nested/%E9%9B%AA%20%2B%26%25%3F%23.bin')));
});

test('detects malformed copy responses and corrupted copied objects', async () => {
  for (const mode of ['status', 'result', 'etag', 'timestamp', 'content', 'length', 'type', 'cache', 'disposition', 'metadata', 'get etag', 'source', 'neighbor', 'empty', 'replacement', 'stale header', 'self', 'source overwrite']) {
    const client = new FakeS3(async (command, service, next) => {
      const result = await next();
      const copies = service.calls.filter(c => c instanceof CopyObjectCommand).length;
      if (command instanceof CopyObjectCommand && copies === 1) {
        if (mode === 'status') result.$metadata.httpStatusCode = 201;
        if (mode === 'result') delete result.CopyObjectResult;
        if (mode === 'etag') delete result.CopyObjectResult.ETag;
        if (mode === 'timestamp') result.CopyObjectResult.LastModified = new Date('invalid');
      }
      if (command instanceof GetObjectCommand) {
        const key = command.input.Key;
        if (copies === 1 && key.startsWith('copy/') && !key.endsWith('/child')) {
          if (mode === 'content') result.Body = { transformToByteArray: async () => Buffer.from('wrong') };
          if (mode === 'length') result.ContentLength++;
          if (mode === 'type') result.ContentType = 'wrong';
          if (mode === 'cache') result.CacheControl = 'wrong';
          if (mode === 'disposition') result.ContentDisposition = 'wrong';
          if (mode === 'metadata') result.Metadata = {};
          if (mode === 'get etag') result.ETag = 'wrong';
        }
        if (copies === 1 && key.startsWith('nested/') && mode === 'source') result.ETag = 'wrong';
        if (copies === 1 && key.endsWith('/child') && mode === 'neighbor') result.ETag = 'wrong';
        if (copies === 2 && key === 'empty-copy' && mode === 'empty') result.ContentLength = 1;
        if (copies === 3 && key.startsWith('copy/') && mode === 'replacement') result.Metadata = {};
        if (copies === 3 && key.startsWith('copy/') && mode === 'stale header') result.CacheControl = 'old';
        if (copies === 4 && key.startsWith('copy/') && mode === 'self') result.Metadata = {};
        if (copies > 4 && service.calls.filter(c => c instanceof PutObjectCommand).length === 5 && key.startsWith('copy/') && mode === 'source overwrite') result.Metadata = {};
      }
      return result;
    });
    await assert.rejects(run({ client }), undefined, mode);
    assert.equal(client.buckets.size, 0, mode);
  }
});

test('detects incorrect conditional and missing-resource responses', async () => {
  for (const mode of ['match success', 'match failure', 'match status', 'match writes', 'none success', 'none failure', 'none status', 'missing key success', 'missing key code', 'missing source bucket', 'missing destination bucket']) {
    const client = new FakeS3((command, service, next) => {
      if (command instanceof CopyObjectCommand) {
        const { CopySource, CopySourceIfMatch, CopySourceIfNoneMatch, Bucket } = command.input;
        if (CopySourceIfMatch === '"not-the-etag"') {
          if (mode === 'match failure') return ok(200);
          if (mode === 'match status') throw error('Wrong', 404);
          if (mode === 'match writes') {
            const [bucket, ...parts] = CopySource.split('/');
            const source = service.buckets.get(bucket).get(parts.map(decodeURIComponent).join('/'));
            service.buckets.get(Bucket).set(command.input.Key, { ...source });
            throw error('PreconditionFailed', 412);
          }
        } else if (CopySourceIfMatch && mode === 'match success') throw error('Wrong', 412);
        if (CopySourceIfNoneMatch === '"not-the-etag"' && mode === 'none success') throw error('Wrong', 412);
        if (CopySourceIfNoneMatch && CopySourceIfNoneMatch !== '"not-the-etag"') {
          if (mode === 'none failure') return ok(200);
          if (mode === 'none status') throw error('Wrong', 404);
        }
        if (CopySource.endsWith('/absent')) {
          if (mode === 'missing key success') return ok(200);
          if (mode === 'missing key code') throw error('NoSuchBucket', 404);
        }
        const sourceBucket = CopySource.split('/')[0];
        if (!service.buckets.has(sourceBucket) && mode === 'missing source bucket') return ok(200);
        if (!service.buckets.has(Bucket) && mode === 'missing destination bucket') return ok(200);
      }
      return next();
    });
    await assert.rejects(run({ client }), undefined, mode);
    assert.equal(client.buckets.size, 0, mode);
  }
});

test('cleans ambiguous writes and reports cleanup failures without masking the original failure', async () => {
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof CopyObjectCommand) { await next(); throw new Error('response lost'); }
    return next();
  });
  await assert.rejects(run({ client }), /response lost/);
  assert.equal(client.buckets.size, 0);
  const failing = new FakeS3((command, service, next) => {
    if (command instanceof CopyObjectCommand) throw new Error('copy failed');
    if (command instanceof DeleteObjectCommand) throw new Error('delete failed');
    return next();
  });
  await assert.rejects(run({ client: failing }), /copy failed; cleanup failed.*delete failed/i);
  assert.equal(failing.calls.filter(c => c instanceof DeleteObjectCommand).length, 6);
});

test('cleans a missing destination bucket if a broken copy recreates it', async () => {
  const client = new FakeS3((command, service, next) => {
    if (command instanceof CopyObjectCommand && !service.buckets.has(command.input.Bucket)) {
      service.buckets.set(command.input.Bucket, new Map([[command.input.Key, {}]]));
      return ok(200);
    }
    return next();
  });
  await assert.rejects(run({ client }), /missing destination bucket/);
  assert.equal(client.buckets.size, 0);
});

test('does not delete a bucket when creation was rejected', async () => {
  const client = new FakeS3(command => {
    if (command instanceof CreateBucketCommand) throw error('BucketAlreadyExists', 409);
    throw new Error('unexpected cleanup');
  });
  await assert.rejects(run({ client }), /BucketAlreadyExists/);
  assert.equal(client.calls.length, 1);
});
