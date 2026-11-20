import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateBucketCommand, CreateMultipartUploadCommand,
  DeleteBucketCommand, DeleteObjectCommand, GetObjectCommand, ListMultipartUploadsCommand, ListPartsCommand,
  PutObjectCommand, UploadPartCommand,
} from '@aws-sdk/client-s3';
import checks from '../checks/multipart.js';

const run = checks.find(check => check.name === 'AbortMultipartUpload').run;
const ok = (httpStatusCode, fields = {}) => ({ ...fields, $metadata: { httpStatusCode } });
const error = name => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });

class FakeS3 {
  constructor(intercept) {
    this.config = { region: async () => 'us-east-1' };
    this.buckets = new Map();
    this.calls = [];
    this.nextId = 0;
    this.intercept = intercept;
  }
  async send(command) {
    this.calls.push(command);
    const next = () => this.respond(command);
    return this.intercept ? this.intercept(command, this, next) : next();
  }
  async respond(command) {
    const { Bucket, Key, UploadId } = command.input;
    if (command instanceof CreateBucketCommand) {
      this.buckets.set(Bucket, { objects: new Map(), uploads: new Map() });
      return ok(200);
    }
    const bucket = this.buckets.get(Bucket);
    if (!bucket) throw error('NoSuchBucket');
    if (command instanceof DeleteBucketCommand) {
      if (bucket.objects.size || bucket.uploads.size) throw new Error('BucketNotEmpty');
      this.buckets.delete(Bucket);
      return ok(204);
    }
    if (command instanceof PutObjectCommand) {
      bucket.objects.set(Key, { body: Buffer.from(command.input.Body), ContentType: command.input.ContentType });
      return ok(200);
    }
    if (command instanceof DeleteObjectCommand) { bucket.objects.delete(Key); return ok(204); }
    if (command instanceof GetObjectCommand) {
      const object = bucket.objects.get(Key);
      if (!object) throw error('NoSuchKey');
      return ok(200, { ...object, Body: { transformToByteArray: async () => object.body } });
    }
    if (command instanceof CreateMultipartUploadCommand) {
      const id = `upload-${++this.nextId}`;
      bucket.uploads.set(id, { Key, UploadId: id, parts: new Map() });
      return ok(200, { Bucket, Key, UploadId: id });
    }
    if (command instanceof ListMultipartUploadsCommand) return ok(200, { IsTruncated: false, Uploads: [...bucket.uploads.values()] });
    if (command instanceof AbortMultipartUploadCommand || command instanceof UploadPartCommand || command instanceof ListPartsCommand || command instanceof CompleteMultipartUploadCommand) {
      const upload = bucket.uploads.get(UploadId);
      if (!upload || upload.Key !== Key) throw error('NoSuchUpload');
      if (command instanceof AbortMultipartUploadCommand) { bucket.uploads.delete(UploadId); return ok(204); }
      if (command instanceof UploadPartCommand) {
        const body = Buffer.from(command.input.Body);
        const ETag = `"${createHash('md5').update(body).digest('hex')}"`;
        upload.parts.set(command.input.PartNumber, { PartNumber: command.input.PartNumber, ETag, body });
        return ok(200, { ETag });
      }
      if (command instanceof ListPartsCommand) return ok(200, { IsTruncated: false, Parts: [...upload.parts.values()] });
      const part = upload.parts.get(1);
      assert.equal(command.input.MultipartUpload.Parts[0].ETag, part.ETag);
      bucket.objects.set(Key, { body: part.body });
      bucket.uploads.delete(UploadId);
      return ok(200);
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  }
}

test('AbortMultipartUpload verifies isolation and cleans resources on repeated runs', async () => {
  const client = new FakeS3();
  client.buckets.set('existing', { objects: new Map([['keep', {}]]), uploads: new Map() });
  await run({ client });
  await run({ client });
  const buckets = client.calls.filter(c => c instanceof CreateBucketCommand).map(c => c.input.Bucket);
  assert.equal(new Set(buckets).size, 6);
  assert.deepEqual([...client.buckets.keys()], ['existing']);
  assert.ok(client.buckets.get('existing').objects.has('keep'));
});

test('AbortMultipartUpload accepts NoSuchUpload for an upload in a missing bucket', async () => {
  // S3 does not document which error takes precedence when both are missing.
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof AbortMultipartUploadCommand && !service.buckets.has(command.input.Bucket)) throw error('NoSuchUpload');
    return next();
  });
  await run({ client });
  assert.equal(client.buckets.size, 0);
});

test('AbortMultipartUpload detects incorrect status, errors, state and isolation', async () => {
  for (const mode of ['abort status', 'wrong key accepted', 'abort retained', 'same-key lost', 'neighbor lost', 'list truncated', 'parts retained', 'upload accepted', 'complete accepted', 'repeat accepted', 'missing accepted', 'old content', 'old headers', 'neighbor object', 'survivor parts', 'neighbor parts', 'survivor content', 'empty abort', 'wrong bucket accepted', 'other bucket parts', 'missing bucket', 'missing bucket code']) {
    let aborts = 0;
    let lists = 0;
    let partLists = 0;
    let gets = 0;
    const client = new FakeS3(async (command, service, next) => {
      if (command instanceof AbortMultipartUploadCommand) {
        if (!service.buckets.has(command.input.Bucket)) {
          if (mode === 'missing bucket') return ok(204);
          if (mode === 'missing bucket code') throw error('NoSuchKey');
          return next();
        }
        aborts++;
        if (aborts === 1 && mode === 'wrong key accepted') return ok(204);
        if (aborts === 2) {
          if (mode === 'abort retained') return ok(204);
          const result = await next();
          if (mode === 'abort status') result.$metadata.httpStatusCode = 200;
          if (mode === 'same-key lost') service.buckets.get(command.input.Bucket).uploads.delete('upload-2');
          if (mode === 'neighbor lost') service.buckets.get(command.input.Bucket).uploads.delete('upload-3');
          return result;
        }
        if (aborts === 3 && mode === 'repeat accepted') return ok(204);
        if (aborts === 4 && mode === 'missing accepted') return ok(204);
        if (aborts === 5 && mode === 'empty abort') return ok(200);
        if (aborts === 6 && mode === 'wrong bucket accepted') return ok(204);
      }
      if (command instanceof ListMultipartUploadsCommand) {
        const result = await next();
        if (++lists === 2 && mode === 'list truncated') result.IsTruncated = true;
        return result;
      }
      if (command instanceof ListPartsCommand) {
        partLists++;
        if (partLists === 2 && mode === 'parts retained') return ok(200, { IsTruncated: false, Parts: [] });
        const result = await next();
        if ((partLists === 3 && mode === 'survivor parts') || (partLists === 4 && mode === 'neighbor parts') || (partLists === 6 && mode === 'other bucket parts')) result.Parts = [];
        return result;
      }
      if (command instanceof UploadPartCommand && command.input.UploadId === 'upload-1' && service.calls.filter(c => c instanceof UploadPartCommand && c.input.UploadId === 'upload-1').length === 2 && mode === 'upload accepted') return ok(200);
      if (command instanceof CompleteMultipartUploadCommand && command.input.UploadId === 'upload-1' && mode === 'complete accepted') return ok(200);
      if (command instanceof GetObjectCommand) {
        gets++;
        if (gets === 2 && mode === 'neighbor object') return ok(200);
        const result = await next();
        if ((gets === 1 && mode === 'old content') || (gets === 3 && mode === 'survivor content')) result.Body = { transformToByteArray: async () => Buffer.from('wrong') };
        if (gets === 1 && mode === 'old headers') result.ContentType = 'wrong';
        return result;
      }
      return next();
    });
    await assert.rejects(run({ client }), undefined, mode);
    assert.equal(client.buckets.size, 0, mode);
  }
});

test('cleanup discovers unknown uploads after a lost response and preserves failures', async () => {
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof CreateMultipartUploadCommand) { await next(); throw new Error('response lost'); }
    return next();
  });
  await assert.rejects(run({ client }), /response lost/);
  assert.equal(client.calls.filter(c => c instanceof AbortMultipartUploadCommand).length, 1);
  assert.equal(client.buckets.size, 0);
});

test('cleanup attempts every known abort and object deletion when listing and abort fail', async () => {
  let listings = 0;
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof ListMultipartUploadsCommand && ++listings === 1) throw new Error('check failed');
    if (command instanceof ListMultipartUploadsCommand) throw new Error('listing failed');
    if (command instanceof AbortMultipartUploadCommand) throw new Error(`abort failed ${command.input.UploadId}`);
    return next();
  });
  await assert.rejects(run({ client }), error => {
    assert.match(error.message, /check failed.*listing failed.*abort failed upload-1.*abort failed upload-2.*abort failed upload-3.*retained/s);
    return true;
  });
  assert.equal(client.calls.filter(c => c instanceof AbortMultipartUploadCommand).length, 3);
  assert.equal(client.calls.filter(c => c instanceof DeleteObjectCommand).length, 2);
  assert.equal(client.calls.filter(c => c instanceof DeleteBucketCommand).length, 0);
  assert.equal(client.buckets.size, 1);
});
