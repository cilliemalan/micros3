import assert from 'node:assert/strict';
import test from 'node:test';
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import checks from '../checks/object.js';

const run = name => checks.find(check => check.name === name).run;
const ok = (httpStatusCode, fields = {}) => ({ ...fields, $metadata: { httpStatusCode } });
function error(name, httpStatusCode) {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });
}
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
    if (command instanceof DeleteObjectCommand) {
      objects.delete(Key);
      return ok(204);
    }
    if (command instanceof PutObjectCommand) {
      const { Body, ContentType, CacheControl, ContentDisposition, Metadata } = command.input;
      const ETag = `"${Buffer.from(Body).toString('hex')}"`;
      objects.set(Key, { Body: Buffer.from(Body), ContentType, CacheControl, ContentDisposition, Metadata, ETag });
      return ok(200, { ETag });
    }
    if (command instanceof GetObjectCommand) {
      const object = objects.get(Key);
      if (!object) throw error('NoSuchKey', 404);
      const { Range, IfMatch, IfNoneMatch } = command.input;
      if (IfMatch && IfMatch !== object.ETag) throw error('PreconditionFailed', 412);
      if (IfNoneMatch === object.ETag) throw error('NotModified', 304);
      let body = object.Body;
      let ContentRange;
      if (Range) {
        const [, startText, endText] = /^bytes=(\d*)-(\d*)$/.exec(Range);
        const start = startText ? +startText : Math.max(0, body.length - +endText);
        const end = startText && endText ? Math.min(+endText, body.length - 1) : body.length - 1;
        if (start >= body.length) throw error('InvalidRange', 416);
        ContentRange = `bytes ${start}-${end}/${body.length}`;
        body = body.subarray(start, end + 1);
      }
      const { ETag, ContentType, CacheControl, ContentDisposition, Metadata } = object;
      return ok(Range ? 206 : 200, { Body: { transformToByteArray: async () => body }, ContentLength: body.length,
        ContentRange, ETag, ContentType, CacheControl, ContentDisposition, Metadata, LastModified: new Date('2024-01-02') });
    }
    throw new Error(`Unexpected ${command.constructor.name}`);
  }
}

test('PutObject and GetObject run independently with isolated resources and clean up', async () => {
  const client = new FakeS3();
  client.buckets.set('existing', new Map([['keep', 'untouched']]));
  for (const name of ['PutObject', 'GetObject', 'PutObject', 'GetObject']) await run(name)({ client });
  assert.deepEqual([...client.buckets.keys()], ['existing']);
  assert.equal(client.buckets.get('existing').get('keep'), 'untouched');
  const buckets = client.calls.filter(c => c instanceof CreateBucketCommand).map(c => c.input.Bucket);
  assert.equal(buckets.length, 8);
  assert.equal(new Set(buckets).size, buckets.length);
  assert.ok(buckets.every(b => /^micros3-verify-[0-9a-f-]{36}$/.test(b)));
});

test('both checks detect incorrect full object responses and cleanup', async () => {
  const faults = [
    ['status', r => { r.$metadata.httpStatusCode = 201; }],
    ['content', r => { r.Body = { transformToByteArray: async () => Buffer.from('wrong') }; }],
    ['ContentLength', r => { r.ContentLength++; }],
    ['ETag', r => { r.ETag = 'wrong'; }],
    ['ContentType', r => { r.ContentType = 'wrong'; }],
    ['CacheControl', r => { r.CacheControl = 'wrong'; }],
    ['ContentDisposition', r => { r.ContentDisposition = 'wrong'; }],
    ['metadata', r => { r.Metadata = {}; }],
  ];
  for (const name of ['PutObject', 'GetObject']) {
    for (const [label, mutate] of faults) {
      const client = new FakeS3(async (command, service, next) => {
        const result = await next();
        if (command instanceof GetObjectCommand && command.input.Key.startsWith('nested/')) mutate(result);
        return result;
      });
      await assert.rejects(run(name)({ client }), new RegExp(label, 'i'), `${name} ${label}`);
      assert.equal(client.buckets.size, 0, `${name} ${label}`);
    }
  }
});

test('PutObject detects invalid responses, empty objects, overwrite and key isolation', async () => {
  for (const mode of ['put status', 'put etag', 'empty', 'overwrite', 'stale header', 'neighbor']) {
    const client = new FakeS3(async (command, service, next) => {
      const result = await next();
      const puts = service.calls.filter(c => c instanceof PutObjectCommand).length;
      if (command instanceof PutObjectCommand && mode === 'put status') result.$metadata.httpStatusCode = 201;
      if (command instanceof PutObjectCommand && mode === 'put etag') delete result.ETag;
      if (command instanceof GetObjectCommand) {
        if (mode === 'empty' && command.input.Key === 'empty') result.ContentLength = 1;
        if (mode === 'overwrite' && puts === 4 && command.input.Key.startsWith('nested/')) result.Metadata = { revision: 'one' };
        if (mode === 'stale header' && puts === 4 && command.input.Key.startsWith('nested/')) result.CacheControl = 'max-age=123';
        if (mode === 'neighbor' && puts === 4 && command.input.Key.endsWith('/child')) result.ETag = 'wrong';
      }
      return result;
    });
    await assert.rejects(run('PutObject')({ client }), undefined, mode);
    assert.equal(client.buckets.size, 0, mode);
  }
});

test('GetObject detects invalid timestamps, range and conditional responses', async () => {
  for (const mode of ['LastModified', 'range status', 'range content', 'range length', 'range header', 'range etag',
    'open range', 'suffix range', 'invalid range', 'IfMatch failure', 'IfMatch status', 'IfMatch success', 'IfNoneMatch failure', 'IfNoneMatch status', 'IfNoneMatch success']) {
    const client = new FakeS3(async (command, service, next) => {
      if (!(command instanceof GetObjectCommand)) return next();
      const { Range, IfMatch, IfNoneMatch, Key } = command.input;
      if (Range === 'bytes=100-200' && mode === 'invalid range') return ok(200);
      if (IfMatch === '"not-the-etag"' && mode === 'IfMatch failure') return ok(200);
      if (IfMatch === '"not-the-etag"' && mode === 'IfMatch status') throw error('Wrong', 404);
      if (IfMatch && IfMatch !== '"not-the-etag"' && mode === 'IfMatch success') throw error('Wrong', 412);
      if (IfNoneMatch && IfNoneMatch !== '"not-the-etag"' && mode === 'IfNoneMatch failure') return ok(200);
      if (IfNoneMatch && IfNoneMatch !== '"not-the-etag"' && mode === 'IfNoneMatch status') throw error('Wrong', 404);
      if (IfNoneMatch === '"not-the-etag"' && mode === 'IfNoneMatch success') throw error('Wrong', 304);
      const result = await next();
      if (Key.startsWith('nested/') && !Range && mode === 'LastModified') result.LastModified = new Date('invalid');
      if ((Range === 'bytes=4-' && mode === 'open range') || (Range === 'bytes=-2' && mode === 'suffix range')) {
        result.ContentRange = 'wrong';
      }
      if (Range === 'bytes=1-3') {
        if (mode === 'range status') result.$metadata.httpStatusCode = 200;
        if (mode === 'range content') result.Body = { transformToByteArray: async () => Buffer.from('bad') };
        if (mode === 'range length') result.ContentLength = 7;
        if (mode === 'range header') result.ContentRange = 'wrong';
        if (mode === 'range etag') result.ETag = 'wrong';
      }
      return result;
    });
    await assert.rejects(run('GetObject')({ client }), undefined, mode);
    assert.equal(client.buckets.size, 0, mode);
  }
});

test('GetObject detects incorrect overwrite and empty-object responses', async () => {
  for (const mode of ['empty content', 'empty etag', 'empty type', 'empty metadata', 'overwrite content', 'overwrite etag',
    'overwrite type', 'overwrite metadata', 'overwrite stale cache', 'overwrite stale disposition', 'other key']) {
    const client = new FakeS3(async (command, service, next) => {
      const result = await next();
      if (command instanceof GetObjectCommand) {
        const puts = service.calls.filter(c => c instanceof PutObjectCommand).length;
        if (command.input.Key === 'empty' && puts === 2) {
          if (mode === 'empty content') result.Body = { transformToByteArray: async () => Buffer.from('bad') };
          if (mode === 'empty etag') result.ETag = 'wrong';
          if (mode === 'empty type') result.ContentType = 'wrong';
          if (mode === 'empty metadata') result.Metadata = { extra: 'bad' };
        }
        if (puts === 3 && command.input.Key.startsWith('nested/')) {
          if (mode === 'overwrite content') result.Body = { transformToByteArray: async () => Buffer.from('bad') };
          if (mode === 'overwrite etag') result.ETag = 'wrong';
          if (mode === 'overwrite type') result.ContentType = 'wrong';
          if (mode === 'overwrite metadata') result.Metadata = {};
          if (mode === 'overwrite stale cache') result.CacheControl = 'old';
          if (mode === 'overwrite stale disposition') result.ContentDisposition = 'old';
        }
        if (puts === 3 && command.input.Key === 'empty' && mode === 'other key') result.ETag = 'wrong';
      }
      return result;
    });
    await assert.rejects(run('GetObject')({ client }), undefined, mode);
    assert.equal(client.buckets.size, 0, mode);
  }
});

test('missing keys and buckets require the correct errors', async () => {
  for (const name of ['PutObject', 'GetObject']) {
    for (const mode of ['bucket success', 'bucket status', 'bucket code', ...(name === 'GetObject' ? ['key success', 'key status', 'key code'] : [])]) {
      const client = new FakeS3((command, service, next) => {
        const isOperation = name === 'PutObject' ? command instanceof PutObjectCommand : command instanceof GetObjectCommand;
        if (isOperation && !service.buckets.has(command.input.Bucket)) {
          if (mode === 'bucket success') return ok(200);
          if (mode === 'bucket status') throw error('NoSuchBucket', 403);
          if (mode === 'bucket code') throw error('NoSuchKey', 404);
        }
        if (command instanceof GetObjectCommand && command.input.Key === 'absent') {
          if (mode === 'key success') return ok(200);
          if (mode === 'key status') throw error('NoSuchKey', 403);
          if (mode === 'key code') throw error('NoSuchBucket', 404);
        }
        return next();
      });
      await assert.rejects(run(name)({ client }), undefined, `${name} ${mode}`);
      assert.equal(client.buckets.size, 0, `${name} ${mode}`);
    }
  }
});

test('checks do not delete rejected bucket creations and clean up a recreated missing bucket', async () => {
  for (const name of ['PutObject', 'GetObject']) {
    const collision = new FakeS3((command, service, next) => {
      if (command instanceof CreateBucketCommand) throw error('BucketAlreadyExists', 409);
      return next();
    });
    await assert.rejects(run(name)({ client: collision }), /BucketAlreadyExists/);
    assert.ok(!collision.calls.some(c => c instanceof DeleteBucketCommand || c instanceof DeleteObjectCommand));
    const recreated = new FakeS3((command, service, next) => {
      if ((command instanceof PutObjectCommand || command instanceof GetObjectCommand) && !service.buckets.has(command.input.Bucket)) {
        service.buckets.set(command.input.Bucket, new Map([[command.input.Key, {}]]));
        return ok(200);
      }
      return next();
    });
    await assert.rejects(run(name)({ client: recreated }), /missing bucket/);
    assert.equal(recreated.buckets.size, 0);
  }
});

test('ambiguous writes and cleanup failures are handled without losing the original error', async () => {
  for (const name of ['PutObject', 'GetObject']) {
    const client = new FakeS3(async (command, service, next) => {
      if (command instanceof PutObjectCommand) { await next(); throw new Error('response lost'); }
      return next();
    });
    await assert.rejects(run(name)({ client }), /response lost/);
    assert.equal(client.buckets.size, 0);
    assert.ok(client.calls.some(c => c instanceof DeleteObjectCommand && c.input.Key.startsWith('nested/')));
    const failing = new FakeS3((command, service, next) => {
      if (command instanceof PutObjectCommand) throw new Error('upload failed');
      if (command instanceof DeleteObjectCommand) throw new Error('cleanup failed');
      return next();
    });
    await assert.rejects(run(name)({ client: failing }), /upload failed; cleanup failed.*cleanup failed/i);
    assert.equal(failing.calls.filter(c => c instanceof DeleteObjectCommand).length, 3);
    assert.equal(failing.buckets.size, 0);
  }
});
