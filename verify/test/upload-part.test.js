import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateBucketCommand, CreateMultipartUploadCommand,
  DeleteBucketCommand, DeleteObjectCommand, GetObjectCommand, ListMultipartUploadsCommand, ListPartsCommand,
  PutObjectCommand, UploadPartCommand,
} from '@aws-sdk/client-s3';
import checks from '../checks/multipart.js';

const run = checks.find(check => check.name === 'UploadPart').run;
const ok = (httpStatusCode, fields = {}) => ({ ...fields, $metadata: { httpStatusCode } });
const error = (name, httpStatusCode = 404) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });

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
    if (command instanceof DeleteBucketCommand) {
      if (bucket.objects.size || bucket.uploads.size) throw error('BucketNotEmpty', 409);
      this.buckets.delete(Bucket); return ok(204);
    }
    if (command instanceof PutObjectCommand) { bucket.objects.set(Key, Buffer.from(command.input.Body)); return ok(200); }
    if (command instanceof DeleteObjectCommand) { bucket.objects.delete(Key); return ok(204); }
    if (command instanceof GetObjectCommand) {
      const body = bucket.objects.get(Key);
      if (!body) throw error('NoSuchKey');
      return ok(200, { ContentLength: body.length, Body: { transformToByteArray: async () => body } });
    }
    if (command instanceof CreateMultipartUploadCommand) {
      const id = `upload-${++this.nextId}`;
      bucket.uploads.set(id, { Key, UploadId: id, parts: new Map() }); return ok(200, { Bucket, Key, UploadId: id });
    }
    if (command instanceof ListMultipartUploadsCommand) return ok(200, { IsTruncated: false, Uploads: [...bucket.uploads.values()] });
    if (command instanceof UploadPartCommand || command instanceof ListPartsCommand || command instanceof AbortMultipartUploadCommand || command instanceof CompleteMultipartUploadCommand) {
      const upload = bucket.uploads.get(UploadId);
      if (!upload || upload.Key !== Key) throw error('NoSuchUpload');
      if (command instanceof AbortMultipartUploadCommand) { bucket.uploads.delete(UploadId); return ok(204); }
      if (command instanceof UploadPartCommand) {
        if (PartNumber < 1 || PartNumber > 10000) throw error('InvalidArgument', 400);
        const body = Buffer.from(command.input.Body);
        const ETag = `"${createHash('md5').update(body).digest('hex')}"`;
        upload.parts.set(PartNumber, { PartNumber, ETag, Size: body.length, body });
        return ok(200, { ETag });
      }
      if (command instanceof ListPartsCommand) return ok(200, { IsTruncated: false, Parts: [...upload.parts.values()].sort((a, b) => a.PartNumber - b.PartNumber) });
      const parts = command.input.MultipartUpload.Parts.map(part => {
        const stored = upload.parts.get(part.PartNumber);
        assert.equal(part.ETag, stored.ETag);
        return stored.body;
      });
      bucket.objects.set(Key, Buffer.concat(parts)); bucket.uploads.delete(UploadId); return ok(200);
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  }
}

test('UploadPart verifies parts and completion, isolating and cleaning repeated runs', async () => {
  const client = new FakeS3();
  client.buckets.set('existing', { objects: new Map([['keep', Buffer.from('keep')]]), uploads: new Map() });
  await run({ client }); await run({ client });
  const buckets = client.calls.filter(c => c instanceof CreateBucketCommand).map(c => c.input.Bucket);
  assert.equal(new Set(buckets).size, 6);
  assert.deepEqual([...client.buckets.keys()], ['existing']);
  assert.equal(client.buckets.get('existing').objects.get('keep').toString(), 'keep');
});

test('UploadPart detects bad responses, part state, errors and assembled bytes', async () => {
  for (const mode of ['status', 'etag', 'initial parts', 'order', 'size', 'replacement', 'same key', 'neighbor', 'truncated', 'existing object', 'neighbor object', 'wrong key', 'missing upload', 'zero', 'too large', 'invalid code', 'wrong bucket', 'other bucket parts', 'complete status', 'content length', 'content', 'completed upload', 'aborted upload', 'missing bucket', 'missing bucket code']) {
    let uploads = 0, lists = 0, gets = 0;
    const client = new FakeS3(async (command, service, next) => {
      if (command instanceof UploadPartCommand) {
        const { Bucket, Key, UploadId, PartNumber } = command.input;
        if (!service.buckets.has(Bucket)) {
          if (mode === 'missing bucket') return ok(200);
          if (mode === 'missing bucket code') throw error('NoSuchUpload');
          return next();
        }
        if (PartNumber === 0 || PartNumber === 10001) {
          if ((mode === 'zero' && PartNumber === 0) || (mode === 'too large' && PartNumber === 10001)) return ok(200);
          if (mode === 'invalid code') throw error('InvalidRequest', 400);
          return next();
        }
        if (UploadId === 'nonexistent-upload-id' && mode === 'missing upload') return ok(200);
        if (Key.endsWith('/child') && UploadId === 'upload-1' && mode === 'wrong key') return ok(200);
        if (!service.buckets.get(Bucket).uploads.has(UploadId)) {
          const crossBucket = [...service.buckets.values()].some(bucket => bucket.uploads.has(UploadId));
          if (crossBucket && mode === 'wrong bucket') return ok(200);
          if (!crossBucket && ((UploadId === 'upload-1' && mode === 'completed upload') || (UploadId === 'upload-3' && mode === 'aborted upload'))) return ok(200);
          return next();
        }
        const result = await next(); uploads++;
        if (uploads === 1 && mode === 'status') result.$metadata.httpStatusCode = 201;
        if (uploads === 1 && mode === 'etag') delete result.ETag;
        return result;
      }
      if (command instanceof ListPartsCommand) {
        const result = await next(); lists++;
        if (lists === 1 && mode === 'initial parts') result.Parts.pop();
        if (lists === 1 && mode === 'order') result.Parts.reverse();
        if (lists === 1 && mode === 'size') result.Parts[0] = { ...result.Parts[0], Size: 99 };
        if (lists === 1 && mode === 'truncated') result.IsTruncated = true;
        if (lists === 2 && mode === 'replacement') result.Parts[0] = { ...result.Parts[0], Size: 8 };
        if (lists === 3 && mode === 'same key') result.Parts = [];
        if (lists === 4 && mode === 'neighbor') result.Parts = [];
        if (command.input.UploadId === 'upload-4' && mode === 'other bucket parts') result.Parts = [];
        return result;
      }
      if (command instanceof GetObjectCommand) {
        gets++;
        if (gets === 2 && mode === 'neighbor object') return ok(200);
        const result = await next();
        if ((gets === 1 && mode === 'existing object') || (gets === 3 && mode === 'content')) result.Body = { transformToByteArray: async () => Buffer.from('wrong') };
        if (gets === 3 && mode === 'content length') result.ContentLength = 1;
        return result;
      }
      if (command instanceof CompleteMultipartUploadCommand) {
        const result = await next();
        if (mode === 'complete status') result.$metadata.httpStatusCode = 201;
        return result;
      }
      return next();
    });
    await assert.rejects(run({ client }), undefined, mode);
    assert.equal(client.buckets.size, 0, mode);
  }
});

test('UploadPart cleans unknown uploads after lost creation responses', async () => {
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof CreateMultipartUploadCommand) { await next(); throw new Error('response lost'); }
    return next();
  });
  await assert.rejects(run({ client }), /response lost/);
  assert.equal(client.calls.filter(c => c instanceof AbortMultipartUploadCommand).length, 1);
  assert.equal(client.buckets.size, 0);
});

test('UploadPart preserves rejected bucket creations and cleans a recreated missing bucket', async () => {
  const rejected = new FakeS3((command, service, next) => {
    if (command instanceof CreateBucketCommand) throw error('BucketAlreadyExists', 409);
    return next();
  });
  await assert.rejects(run({ client: rejected }), /BucketAlreadyExists/);
  assert.equal(rejected.calls.filter(c => c instanceof DeleteBucketCommand).length, 0);

  const recreated = new FakeS3(async (command, service, next) => {
    if (command instanceof UploadPartCommand && !service.buckets.has(command.input.Bucket)) {
      service.buckets.set(command.input.Bucket, { objects: new Map([[command.input.Key, Buffer.from('unexpected')]]), uploads: new Map() });
      return ok(200);
    }
    return next();
  });
  await assert.rejects(run({ client: recreated }), /UploadPart missing bucket/);
  assert.equal(recreated.buckets.size, 0);
});

test('a nested upload cleanup failure retains only the affected bucket', async () => {
  const created = [];
  const client = new FakeS3((command, service, next) => {
    if (command instanceof CreateBucketCommand) created.push(command.input.Bucket);
    if (command instanceof AbortMultipartUploadCommand && command.input.Bucket === created[1]) {
      throw new Error('other bucket abort failed');
    }
    return next();
  });
  await assert.rejects(run({ client }), err => {
    assert.match(err.message, /other bucket abort failed/);
    assert.ok(err.message.includes(`bucket ${created[1]} retained`));
    return true;
  });
  assert.equal(created.length, 2);
  assert.deepEqual([...client.buckets.keys()], [created[1]]);
  assert.equal(client.buckets.get(created[1]).uploads.size, 1);
  assert.ok(client.calls.some(c => c instanceof DeleteBucketCommand && c.input.Bucket === created[0]));
  assert.ok(!client.calls.some(c => c instanceof DeleteBucketCommand && c.input.Bucket === created[1]));
});

test('UploadPart reports cleanup failures, attempts every abort and object deletion, and retains the bucket', async () => {
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof UploadPartCommand) throw new Error('upload failed');
    if (command instanceof ListMultipartUploadsCommand) throw new Error('listing failed');
    if (command instanceof AbortMultipartUploadCommand) throw new Error(`abort failed ${command.input.UploadId}`);
    return next();
  });
  await assert.rejects(run({ client }), /upload failed.*listing failed.*abort failed upload-1.*abort failed upload-2.*abort failed upload-3.*retained/s);
  assert.equal(client.calls.filter(c => c instanceof AbortMultipartUploadCommand).length, 3);
  assert.equal(client.calls.filter(c => c instanceof DeleteObjectCommand).length, 2);
  assert.equal(client.calls.filter(c => c instanceof DeleteBucketCommand).length, 0);
  assert.equal(client.buckets.size, 1);
});
