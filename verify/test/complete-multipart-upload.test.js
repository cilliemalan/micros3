import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateBucketCommand, CreateMultipartUploadCommand,
  DeleteBucketCommand, DeleteObjectCommand, GetObjectCommand, ListMultipartUploadsCommand, ListPartsCommand,
  PutObjectCommand, UploadPartCommand,
} from '@aws-sdk/client-s3';
import checks from '../checks/multipart.js';

const run = checks.find(check => check.name === 'CompleteMultipartUpload').run;
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
    if (command instanceof PutObjectCommand) { bucket.objects.set(Key, { body: Buffer.from(command.input.Body) }); return ok(200); }
    if (command instanceof DeleteObjectCommand) { bucket.objects.delete(Key); return ok(204); }
    if (command instanceof GetObjectCommand) {
      const object = bucket.objects.get(Key);
      if (!object) throw error('NoSuchKey');
      return ok(200, { ...object, ContentLength: object.body.length, Body: { transformToByteArray: async () => object.body } });
    }
    if (command instanceof CreateMultipartUploadCommand) {
      const id = `upload-${++this.nextId}`;
      bucket.uploads.set(id, { ...command.input, UploadId: id, parts: new Map() });
      return ok(200, { Bucket, Key, UploadId: id });
    }
    if (command instanceof ListMultipartUploadsCommand) return ok(200, { IsTruncated: false, Uploads: [...bucket.uploads.values()] });
    if (command instanceof UploadPartCommand || command instanceof ListPartsCommand || command instanceof AbortMultipartUploadCommand || command instanceof CompleteMultipartUploadCommand) {
      const upload = bucket.uploads.get(UploadId);
      if (!upload || upload.Key !== Key) throw error('NoSuchUpload');
      if (command instanceof AbortMultipartUploadCommand) { bucket.uploads.delete(UploadId); return ok(204); }
      if (command instanceof UploadPartCommand) {
        const body = Buffer.from(command.input.Body);
        const ETag = `"${createHash('md5').update(body).digest('hex')}"`;
        upload.parts.set(PartNumber, { PartNumber, ETag, body }); return ok(200, { ETag });
      }
      if (command instanceof ListPartsCommand) return ok(200, { IsTruncated: false, Parts: [...upload.parts.values()].sort((a, b) => a.PartNumber - b.PartNumber) });
      const parts = command.input.MultipartUpload.Parts;
      if (parts.some((p, i) => i > 0 && p.PartNumber <= parts[i - 1].PartNumber)) throw error('InvalidPartOrder', 400);
      const selected = parts.map(p => upload.parts.get(p.PartNumber));
      if (selected.some((p, i) => !p || p.ETag !== parts[i].ETag)) throw error('InvalidPart', 400);
      if (selected.slice(0, -1).some(p => p.body.length < 5 * 1024 * 1024)) throw error('EntityTooSmall', 400);
      const body = Buffer.concat(selected.map(p => p.body));
      const ETag = '"multipart-etag"';
      bucket.objects.set(Key, { body, ETag, ContentType: upload.ContentType, CacheControl: upload.CacheControl, Metadata: upload.Metadata });
      bucket.uploads.delete(UploadId);
      return ok(200, { Bucket, Key, ETag });
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  }
}

test('CompleteMultipartUpload verifies completion and cleans isolated repeated runs', async () => {
  const client = new FakeS3();
  client.buckets.set('existing', { objects: new Map([['keep', {}]]), uploads: new Map() });
  await run({ client }); await run({ client });
  assert.equal(new Set(client.calls.filter(c => c instanceof CreateBucketCommand).map(c => c.input.Bucket)).size, 6);
  assert.deepEqual([...client.buckets.keys()], ['existing']);
  assert.ok(client.buckets.get('existing').objects.has('keep'));
});

test('CompleteMultipartUpload detects incorrect validation, state, response and content', async () => {
  for (const mode of ['order', 'bad etag', 'missing part', 'small part', 'error code', 'error status', 'wrong key', 'wrong bucket', 'cross bucket content', 'missing upload', 'aborted', 'old object', 'neighbor object', 'parts', 'truncation', 'status', 'bucket', 'key', 'etag', 'body', 'length', 'object etag', 'type', 'cache', 'metadata', 'completed', 'completed parts', 'survivor', 'recovery', 'empty', 'missing bucket', 'missing code']) {
    let gets = 0;
    const client = new FakeS3(async (command, service, next) => {
      if (command instanceof CompleteMultipartUploadCommand) {
        const { Bucket, Key, UploadId, MultipartUpload: { Parts } } = command.input;
        if (!service.buckets.has(Bucket)) {
          if (mode === 'missing bucket') return ok(200);
          if (mode === 'missing code') throw error('NoSuchUpload');
          return next();
        }
        if (Parts.length === 2 && Parts[0].PartNumber === 3) {
          if (mode === 'order') return ok(200);
          if (mode === 'error code') throw error('InvalidPart', 400);
          if (mode === 'error status') throw error('InvalidPartOrder', 500);
        }
        if (Parts[1]?.ETag === '"incorrect-etag"' && mode === 'bad etag') return ok(200);
        if (Parts[1]?.PartNumber === 4 && mode === 'missing part') return ok(200);
        if (UploadId === 'upload-3' && Parts.length === 2 && mode === 'small part') return ok(200);
        if (Key.endsWith('/child') && UploadId === 'upload-1' && mode === 'wrong key') return ok(200);
        if (UploadId === 'upload-1' && !service.buckets.get(Bucket).uploads.has(UploadId) && [...service.buckets.values()].some(b => b.uploads.has(UploadId)) && mode === 'wrong bucket') return ok(200);
        if (UploadId === 'nonexistent-upload-id' && mode === 'missing upload') return ok(200);
        if (UploadId === 'upload-4' && mode === 'aborted') return ok(200);
        if (UploadId === 'upload-1' && !service.buckets.get(Bucket).uploads.has(UploadId) && mode === 'completed') return ok(200);
        const result = await next();
        if (UploadId === 'upload-1') {
          if (mode === 'status') result.$metadata.httpStatusCode = 201;
          if (mode === 'bucket') result.Bucket = 'wrong';
          if (mode === 'key') result.Key = 'wrong';
          if (mode === 'etag') delete result.ETag;
        }
        if (UploadId === 'upload-2' && mode === 'survivor') result.$metadata.httpStatusCode = 201;
        if (UploadId === 'upload-3' && mode === 'recovery') result.$metadata.httpStatusCode = 201;
        if (Key === 'empty' && mode === 'empty') result.$metadata.httpStatusCode = 201;
        return result;
      }
      if (command instanceof ListPartsCommand) {
        if (mode === 'completed parts' && !service.buckets.get(command.input.Bucket).uploads.has(command.input.UploadId)) return ok(200);
        const result = await next();
        if (mode === 'parts') result.Parts.pop();
        if (mode === 'truncation') result.IsTruncated = true;
        return result;
      }
      if (command instanceof GetObjectCommand) {
        gets++;
        if (gets === 2 && mode === 'neighbor object') return ok(200);
        const result = await next();
        if ((gets === 1 && mode === 'old object') || (gets === 3 && mode === 'cross bucket content') || (gets === 4 && mode === 'body')) result.Body = { transformToByteArray: async () => Buffer.from('wrong') };
        if (gets === 4) {
          if (mode === 'length') result.ContentLength = 1;
          if (mode === 'object etag') result.ETag = 'wrong';
          if (mode === 'type') result.ContentType = 'wrong';
          if (mode === 'cache') result.CacheControl = 'wrong';
          if (mode === 'metadata') result.Metadata = {};
        }
        return result;
      }
      return next();
    });
    await assert.rejects(run({ client }), undefined, mode);
    assert.equal(client.buckets.size, 0, mode);
  }
});

test('cleanup discovers uploads after a lost creation response', async () => {
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof CreateMultipartUploadCommand) { await next(); throw new Error('response lost'); }
    return next();
  });
  await assert.rejects(run({ client }), /response lost/);
  assert.equal(client.calls.filter(c => c instanceof AbortMultipartUploadCommand).length, 1);
  assert.equal(client.buckets.size, 0);
});

test('cleanup handles a lost successful completion response', async () => {
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof CompleteMultipartUploadCommand && command.input.UploadId === 'upload-1') {
      await next();
      throw new Error('completion response lost');
    }
    return next();
  });
  await assert.rejects(run({ client }), /completion response lost/);
  assert.equal(client.buckets.size, 0);
});

test('rejected bucket creations are not cleaned, and a recreated missing bucket is cleaned', async () => {
  const rejected = new FakeS3((command, service, next) => {
    if (command instanceof CreateBucketCommand) throw error('BucketAlreadyExists', 409);
    return next();
  });
  await assert.rejects(run({ client: rejected }), /BucketAlreadyExists/);
  assert.equal(rejected.calls.filter(c => c instanceof DeleteBucketCommand).length, 0);

  const recreated = new FakeS3(async (command, service, next) => {
    if (command instanceof CompleteMultipartUploadCommand && !service.buckets.has(command.input.Bucket)) {
      service.buckets.set(command.input.Bucket, { objects: new Map([[command.input.Key, { body: Buffer.alloc(0) }]]), uploads: new Map() });
      return ok(200);
    }
    return next();
  });
  await assert.rejects(run({ client: recreated }), /CompleteMultipartUpload missing bucket/);
  assert.equal(recreated.buckets.size, 0);
});

test('cleanup reports failures and attempts all known resources', async () => {
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof UploadPartCommand) throw new Error('setup failed');
    if (command instanceof ListMultipartUploadsCommand) throw new Error('listing failed');
    if (command instanceof AbortMultipartUploadCommand) throw new Error(`abort failed ${command.input.UploadId}`);
    return next();
  });
  await assert.rejects(run({ client }), /setup failed.*listing failed.*abort failed upload-1.*abort failed upload-2.*abort failed upload-3.*abort failed upload-4/s);
  assert.equal(client.calls.filter(c => c instanceof AbortMultipartUploadCommand).length, 4);
  assert.equal(client.calls.filter(c => c instanceof DeleteObjectCommand).length, 3);
  assert.equal(client.calls.filter(c => c instanceof DeleteBucketCommand).length, 1);
});
