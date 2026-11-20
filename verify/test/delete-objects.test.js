import assert from 'node:assert/strict';
import test from 'node:test';
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import checks from '../checks/object.js';

const run = checks.find(check => check.name === 'DeleteObjects').run;
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
      if (this.buckets.has(Bucket)) throw error('BucketAlreadyExists', 409);
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
    if (command instanceof PutObjectCommand) {
      objects.set(Key, { body: Buffer.from(command.input.Body), metadata: command.input.Metadata });
      return ok(200);
    }
    if (command instanceof GetObjectCommand) {
      const object = objects.get(Key);
      if (!object) throw error('NoSuchKey', 404);
      return ok(200, { Body: { transformToByteArray: async () => object.body }, Metadata: object.metadata });
    }
    if (command instanceof DeleteObjectCommand) {
      objects.delete(Key);
      return ok(204);
    }
    if (command instanceof DeleteObjectsCommand) {
      const { Objects, Quiet } = command.input.Delete;
      if (Objects.length > 1000) throw error('MalformedXML', 400);
      for (const object of Objects) objects.delete(object.Key);
      return ok(200, Quiet ? {} : { Deleted: Objects.map(({ Key }) => ({ Key })).reverse() });
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  }
}

test('DeleteObjects exercises verbose, quiet, limits and missing bucket with isolated cleanup', async () => {
  const client = new FakeS3();
  client.buckets.set('existing', new Map([['keep', { body: Buffer.from('keep') }]]));
  await run({ client });
  await run({ client });
  assert.deepEqual([...client.buckets.keys()], ['existing']);
  assert.equal(client.buckets.get('existing').get('keep').body.toString(), 'keep');
  const creates = client.calls.filter(c => c instanceof CreateBucketCommand);
  assert.equal(creates.length, 6);
  assert.equal(new Set(creates.map(c => c.input.Bucket)).size, 6);
  assert.ok(creates.every(c => /^micros3-verify-[0-9a-f-]{36}$/.test(c.input.Bucket)));
  const requests = client.calls.filter(c => c instanceof DeleteObjectsCommand);
  for (const size of [3, 1000, 1001, 1]) assert.ok(requests.some(c => c.input.Delete.Objects.length === size));
  assert.ok(requests.some(c => c.input.Delete.Quiet === true));
  assert.ok(requests.some(c => c.input.Delete.Quiet === false));
  assert.ok(requests.some(c => c.input.Delete.Quiet === undefined));
});

test('DeleteObjects detects incorrect result lists, status, quiet behavior, and deletion effects', async () => {
  for (const mode of ['status', 'errors', 'missing result', 'extra result', 'duplicate result', 'quiet result',
    'no deletion', 'empty survives', 'prefix deletion', 'cross-bucket deletion', 'repeated rejects', 'repeated recreates', 'quiet no deletion']) {
    let smallRequests = 0;
    const client = new FakeS3(async (command, service, next) => {
      if (!(command instanceof DeleteObjectsCommand) || !service.buckets.has(command.input.Bucket)) return next();
      const { Objects, Quiet } = command.input.Delete;
      if (Objects.length !== 3) return next();
      smallRequests++;
      if (mode === 'repeated rejects' && smallRequests === 2) throw error('NoSuchKey', 404);
      if (mode === 'no deletion' || (mode === 'quiet no deletion' && Quiet)) {
        return ok(200, Quiet ? {} : { Deleted: Objects });
      }
      const bucket = service.buckets.get(command.input.Bucket);
      const empty = bucket.get('empty');
      const result = await next();
      if (mode === 'empty survives' && empty) bucket.set('empty', empty);
      if (mode === 'repeated recreates' && smallRequests === 2) bucket.set(Objects[0].Key, { body: Buffer.from('bad') });
      if (mode === 'prefix deletion') bucket.delete(`${Objects[0].Key}/child`);
      if (mode === 'cross-bucket deletion') {
        for (const [name, objects] of service.buckets) if (name !== command.input.Bucket) objects.delete(Objects[0].Key);
      }
      if (mode === 'status') result.$metadata.httpStatusCode = 204;
      if (mode === 'errors') result.Errors = [{ Key: Objects[0].Key, Code: 'AccessDenied' }];
      if (mode === 'missing result' && !Quiet) result.Deleted.pop();
      if (mode === 'extra result' && !Quiet) result.Deleted.push({ Key: 'unrequested' });
      if (mode === 'duplicate result' && !Quiet) result.Deleted[0] = result.Deleted[1];
      if (mode === 'quiet result' && Quiet) result.Deleted = Objects;
      return result;
    });
    await assert.rejects(run({ client }), undefined, mode);
    assert.equal(client.buckets.size, 0, mode);
  }
});

test('DeleteObjects detects limit and missing-bucket failures', async () => {
  for (const mode of ['over limit accepted', 'over limit wrong status', 'over limit partially applied',
    'limit rejects', 'limit missing result', 'limit no deletion', 'missing bucket accepted', 'missing bucket wrong code', 'missing bucket wrong status']) {
    const client = new FakeS3(async (command, service, next) => {
      if (!(command instanceof DeleteObjectsCommand)) return next();
      const { Bucket, Delete: { Objects } } = command.input;
      if (!service.buckets.has(Bucket)) {
        if (mode === 'missing bucket accepted') return ok(200);
        if (mode === 'missing bucket wrong code') throw error('NoSuchKey', 404);
        if (mode === 'missing bucket wrong status') throw error('NoSuchBucket', 403);
      }
      if (Objects.length === 1001) {
        if (mode === 'over limit accepted') return ok(200);
        if (mode === 'over limit wrong status') throw error('MalformedXML', 403);
        if (mode === 'over limit partially applied') {
          service.buckets.get(Bucket).delete('limit-existing');
          throw error('MalformedXML', 400);
        }
      }
      if (Objects.length === 1000) {
        if (mode === 'limit rejects') throw error('MalformedXML', 400);
        if (mode === 'limit no deletion') return ok(200, { Deleted: Objects });
        const result = await next();
        if (mode === 'limit missing result') result.Deleted.pop();
        return result;
      }
      return next();
    });
    await assert.rejects(run({ client }), undefined, mode);
    assert.equal(client.buckets.size, 0, mode);
  }
});

test('DeleteObjects checks setup and observation responses', async () => {
  for (const mode of ['put status', 'get status', 'get content', 'get metadata', 'missing success', 'missing wrong code']) {
    const client = new FakeS3(async (command, service, next) => {
      if (command instanceof PutObjectCommand && mode === 'put status') { await next(); return ok(201); }
      if (!(command instanceof GetObjectCommand)) return next();
      if (command.input.Key === 'absent') {
        if (mode === 'missing success') return ok(200);
        if (mode === 'missing wrong code') throw error('NoSuchBucket', 404);
      }
      const result = await next();
      if (mode === 'get status') result.$metadata.httpStatusCode = 201;
      if (mode === 'get content') result.Body = { transformToByteArray: async () => Buffer.from('wrong') };
      if (mode === 'get metadata') result.Metadata = { wrong: 'value' };
      return result;
    });
    await assert.rejects(run({ client }), undefined, mode);
    assert.equal(client.buckets.size, 0, mode);
  }
});

test('DeleteObjects cleans up ambiguous operations and reports all cleanup failures', async () => {
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof PutObjectCommand) { await next(); throw new Error('upload response lost'); }
    return next();
  });
  await assert.rejects(run({ client }), /upload response lost/);
  assert.equal(client.buckets.size, 0);
  assert.equal(client.calls.filter(c => c instanceof DeleteObjectCommand).length, 6);

  const lostDelete = new FakeS3(async (command, service, next) => {
    if (command instanceof DeleteObjectsCommand) { await next(); throw new Error('delete response lost'); }
    return next();
  });
  await assert.rejects(run({ client: lostDelete }), /delete response lost/);
  assert.equal(lostDelete.buckets.size, 0);
  assert.equal(lostDelete.calls.filter(c => c instanceof DeleteObjectCommand).length, 6);

  const failing = new FakeS3((command, service, next) => {
    if (command instanceof PutObjectCommand) throw new Error('upload failed');
    if (command instanceof DeleteObjectCommand) throw new Error(`cleanup failed for ${command.input.Key}`);
    return next();
  });
  await assert.rejects(run({ client: failing }), err => {
    assert.match(err.message, /upload failed/);
    assert.match(err.message, /cleanup failed.*nested\/.*empty.*absent.*limit-existing/i);
    return true;
  });
  assert.equal(failing.calls.filter(c => c instanceof DeleteObjectCommand).length, 6);
  assert.equal(failing.buckets.size, 0);
});

test('DeleteObjects does not clean rejected bucket creations and cleans a recreated missing bucket', async () => {
  const rejected = new FakeS3((command, service, next) => {
    if (command instanceof CreateBucketCommand) throw error('BucketAlreadyExists', 409);
    return next();
  });
  await assert.rejects(run({ client: rejected }), /BucketAlreadyExists/);
  assert.ok(!rejected.calls.some(c => c instanceof DeleteBucketCommand || c instanceof DeleteObjectCommand));

  const recreated = new FakeS3((command, service, next) => {
    if (command instanceof DeleteObjectsCommand && !service.buckets.has(command.input.Bucket)) {
      service.buckets.set(command.input.Bucket, new Map([['missing-bucket-key', { body: Buffer.from('bad') }]]));
      return ok(200);
    }
    return next();
  });
  await assert.rejects(run({ client: recreated }), /missing bucket/);
  assert.equal(recreated.buckets.size, 0);
});
