import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand,
} from '@aws-sdk/client-s3';
import checks from '../checks/object.js';

const run = checks.find(check => check.name === 'DeleteObject').run;
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
    if (command instanceof DeleteObjectCommand) {
      objects.delete(Key);
      return ok(204);
    }
    if (command instanceof GetObjectCommand) {
      const object = objects.get(Key);
      if (!object) throw error('NoSuchKey', 404);
      return ok(200, { Body: { transformToByteArray: async () => object.body }, Metadata: object.metadata });
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  }
}

test('DeleteObject verifies idempotence, exact keys, empty objects and missing buckets in isolated buckets', async () => {
  const client = new FakeS3();
  client.buckets.set('existing', new Map([['keep', { body: Buffer.from('keep') }]]));
  await run({ client });
  await run({ client });
  const creates = client.calls.filter(c => c instanceof CreateBucketCommand);
  assert.equal(creates.length, 4);
  assert.equal(new Set(creates.map(c => c.input.Bucket)).size, 4);
  assert.ok(creates.every(c => /^micros3-verify-[0-9a-f-]{36}$/.test(c.input.Bucket)));
  assert.deepEqual([...client.buckets.keys()], ['existing']);
  assert.equal(client.buckets.get('existing').get('keep').body.toString(), 'keep');
});

test('DeleteObject detects incorrect deletion, status, idempotence and collateral damage', async () => {
  for (const mode of ['no deletion', 'wrong status', 'missing key rejects', 'repeat rejects', 'prefix deletion', 'recreated key survives', 'empty survives', 'missing bucket success', 'missing bucket wrong code', 'missing bucket wrong status']) {
    let targetDeletes = 0;
    const client = new FakeS3(async (command, service, next) => {
      if (!(command instanceof DeleteObjectCommand)) return next();
      const { Bucket, Key } = command.input;
      if (!service.buckets.has(Bucket)) {
        if (mode === 'missing bucket success') return ok(204);
        if (mode === 'missing bucket wrong code') throw error('NoSuchKey', 404);
        if (mode === 'missing bucket wrong status') throw error('NoSuchBucket', 403);
        return next();
      }
      if (Key === 'absent' && mode === 'missing key rejects') throw error('NoSuchKey', 404);
      if (Key.startsWith('nested/') && !Key.endsWith('/child')) {
        targetDeletes++;
        if (mode === 'no deletion') return ok(204);
        if (mode === 'wrong status') { await next(); return ok(200); }
        if (mode === 'repeat rejects' && targetDeletes === 2) throw error('NoSuchKey', 404);
        if (mode === 'recreated key survives' && targetDeletes === 3) return ok(204);
        if (mode === 'prefix deletion') service.buckets.get(Bucket).delete(`${Key}/child`);
      }
      if (mode === 'empty survives' && Key === 'empty') return ok(204);
      return next();
    });
    await assert.rejects(run({ client }), undefined, mode);
    // Faults that also sabotage cleanup can leave resources; every cleanup is still attempted.
    assert.ok(client.calls.some(c => c instanceof DeleteObjectCommand && c.input.Key === 'absent'), mode);
    assert.ok(client.calls.some(c => c instanceof DeleteBucketCommand), mode);
  }
});

test('DeleteObject detects bad GetObject observations and setup responses', async () => {
  for (const mode of ['setup status', 'get status', 'wrong content', 'wrong metadata', 'missing success', 'missing wrong code']) {
    const client = new FakeS3(async (command, service, next) => {
      if (command instanceof PutObjectCommand && mode === 'setup status') { await next(); return ok(201); }
      if (!(command instanceof GetObjectCommand)) return next();
      if (command.input.Key === 'absent') {
        if (mode === 'missing success') return ok(200);
        if (mode === 'missing wrong code') throw error('NoSuchBucket', 404);
      }
      const result = await next();
      if (mode === 'get status') result.$metadata.httpStatusCode = 201;
      if (mode === 'wrong content') result.Body = { transformToByteArray: async () => Buffer.from('wrong') };
      if (mode === 'wrong metadata') result.Metadata = {};
      return result;
    });
    await assert.rejects(run({ client }), undefined, mode);
    assert.equal(client.buckets.size, 0, mode);
  }
});

test('DeleteObject cleans up after an ambiguous upload and reports all cleanup failures', async () => {
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof PutObjectCommand) { await next(); throw new Error('upload response lost'); }
    return next();
  });
  await assert.rejects(run({ client }), /upload response lost/);
  assert.equal(client.buckets.size, 0);
  assert.equal(client.calls.filter(c => c instanceof DeleteObjectCommand).length, 4);

  const failing = new FakeS3((command, service, next) => {
    if (command instanceof PutObjectCommand) throw new Error('upload failed');
    if (command instanceof DeleteObjectCommand) throw new Error(`cleanup failed for ${command.input.Key}`);
    return next();
  });
  await assert.rejects(run({ client: failing }), err => {
    assert.match(err.message, /upload failed/);
    assert.match(err.message, /cleanup failed.*nested\/.*cleanup failed.*empty.*cleanup failed.*absent/i);
    return true;
  });
  assert.equal(failing.calls.filter(c => c instanceof DeleteObjectCommand).length, 4);
  assert.equal(failing.buckets.size, 0);
});

test('DeleteObject never cleans a rejected bucket creation and retains missing-bucket cleanup', async () => {
  const rejected = new FakeS3((command, service, next) => {
    if (command instanceof CreateBucketCommand) throw error('BucketAlreadyExists', 409);
    return next();
  });
  await assert.rejects(run({ client: rejected }), /BucketAlreadyExists/);
  assert.equal(rejected.calls.filter(c => c instanceof DeleteBucketCommand || c instanceof DeleteObjectCommand).length, 0);

  const recreated = new FakeS3((command, service, next) => {
    if (command instanceof DeleteObjectCommand && !service.buckets.has(command.input.Bucket)) {
      service.buckets.set(command.input.Bucket, new Map([[command.input.Key, { body: Buffer.from('bad') }]]));
      return ok(204);
    }
    return next();
  });
  await assert.rejects(run({ client: recreated }), /missing bucket/);
  assert.equal(recreated.buckets.size, 0);
});
