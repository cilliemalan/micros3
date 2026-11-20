import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateBucketCommand, CreateMultipartUploadCommand,
  DeleteBucketCommand, DeleteObjectCommand, ListMultipartUploadsCommand, PutObjectCommand, UploadPartCommand,
} from '@aws-sdk/client-s3';
import checks from '../checks/multipart.js';

const run = checks.find(check => check.name === 'ListMultipartUploads').run;
const ok = (httpStatusCode, fields = {}) => ({ ...fields, $metadata: { httpStatusCode } });
const error = (name, code = 404) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: code } });

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
      if (bucket.objects.size || bucket.uploads.size) throw error('BucketNotEmpty', 409);
      this.buckets.delete(Bucket);
      return ok(204);
    }
    if (command instanceof PutObjectCommand) { bucket.objects.set(Key, command.input.Body); return ok(200); }
    if (command instanceof DeleteObjectCommand) { bucket.objects.delete(Key); return ok(204); }
    if (command instanceof CreateMultipartUploadCommand) {
      const id = `id-${String(++this.nextId).padStart(3, '0')}`;
      bucket.uploads.set(id, { Key, UploadId: id, Initiated: new Date(), StorageClass: 'STANDARD' });
      return ok(200, { Bucket, Key, UploadId: id });
    }
    if (command instanceof ListMultipartUploadsCommand) {
      const { Prefix = '', Delimiter, MaxUploads = 1000, KeyMarker, UploadIdMarker, EncodingType } = command.input;
      const uploads = [...bucket.uploads.values()].filter(u => u.Key.startsWith(Prefix)).sort((a, b) => a.Key < b.Key ? -1 : a.Key > b.Key ? 1 : a.UploadId.localeCompare(b.UploadId));
      const entries = [];
      const prefixes = new Set();
      for (const upload of uploads) {
        const index = Delimiter ? upload.Key.indexOf(Delimiter, Prefix.length) : -1;
        if (index !== -1) {
          const prefix = upload.Key.slice(0, index + Delimiter.length);
          if (!prefixes.has(prefix)) { entries.push({ prefix, key: prefix }); prefixes.add(prefix); }
        } else entries.push({ upload, key: upload.Key });
      }
      const filtered = entries.filter(entry => !KeyMarker || entry.key > KeyMarker || (entry.key === KeyMarker && UploadIdMarker && entry.upload?.UploadId > UploadIdMarker));
      const selected = filtered.slice(0, MaxUploads);
      const truncated = filtered.length > MaxUploads;
      const last = selected.at(-1);
      const encode = value => EncodingType === 'url' ? encodeURIComponent(value) : value;
      return ok(200, {
        Bucket, IsTruncated: truncated, MaxUploads,
        ...(command.input.Prefix !== undefined ? { Prefix: encode(Prefix) } : {}),
        ...(Delimiter !== undefined ? { Delimiter: encode(Delimiter) } : {}),
        ...(KeyMarker !== undefined ? { KeyMarker: encode(KeyMarker) } : {}),
        ...(UploadIdMarker !== undefined ? { UploadIdMarker } : {}),
        ...(EncodingType ? { EncodingType } : {}),
        Uploads: selected.filter(e => e.upload).map(e => ({ ...e.upload, Key: encode(e.key) })),
        CommonPrefixes: selected.filter(e => e.prefix).map(e => ({ Prefix: encode(e.prefix) })),
        ...(truncated ? { NextKeyMarker: encode(last.key), NextUploadIdMarker: last.upload?.UploadId } : {}),
      });
    }
    if (command instanceof AbortMultipartUploadCommand || command instanceof UploadPartCommand || command instanceof CompleteMultipartUploadCommand) {
      const upload = bucket.uploads.get(UploadId);
      if (!upload || upload.Key !== Key) throw error('NoSuchUpload');
      if (command instanceof AbortMultipartUploadCommand) { bucket.uploads.delete(UploadId); return ok(204); }
      if (command instanceof UploadPartCommand) return ok(200, { ETag: 'etag' });
      bucket.uploads.delete(UploadId);
      bucket.objects.set(Key, 'complete');
      return ok(200);
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  }
}

test('ListMultipartUploads verifies listing semantics and cleans isolated resources', async () => {
  const client = new FakeS3();
  client.buckets.set('existing', { objects: new Map([['keep', 'data']]), uploads: new Map() });
  await run({ client });
  await run({ client });
  const created = client.calls.filter(c => c instanceof CreateBucketCommand).map(c => c.input.Bucket);
  assert.equal(new Set(created).size, 6);
  assert.deepEqual([...client.buckets.keys()], ['existing']);
  assert.equal(client.buckets.get('existing').objects.get('keep'), 'data');
  assert.ok(client.calls.some(c => c instanceof ListMultipartUploadsCommand && c.input.UploadIdMarker));
  assert.ok(client.calls.some(c => c instanceof ListMultipartUploadsCommand && c.input.Delimiter && c.input.MaxUploads === 1));
});

test('ListMultipartUploads detects broken responses, filtering, pagination and lifecycle', async () => {
  const modes = ['status', 'bucket', 'truncation', 'empty', 'object listed', 'missing upload', 'duplicate upload', 'order', 'timestamp', 'initiation order', 'storage', 'prefix', 'marker', 'delimiter', 'encoded', 'encoded prefix', 'next key', 'next id', 'page duplicate', 'prefix page', 'grouped prefix', 'other bucket', 'aborted', 'completed', 'missing bucket', 'missing code'];
  for (const mode of modes) {
    let changed = false;
    const client = new FakeS3(async (command, service, next) => {
      if (!(command instanceof ListMultipartUploadsCommand) || changed) return next();
      const { Bucket, Prefix, Delimiter, MaxUploads, KeyMarker, EncodingType } = command.input;
      const bucket = service.buckets.get(Bucket);
      if (!bucket) {
        if (mode === 'missing bucket') { changed = true; return ok(200); }
        if (mode === 'missing code') { changed = true; throw error('NoSuchKey'); }
        return next();
      }
      const result = await next();
      const count = bucket.uploads.size;
      const corrupt = () => {
        if (mode === 'status' && count === 0) result.$metadata.httpStatusCode = 201;
        else if (mode === 'bucket' && count === 0) result.Bucket = 'wrong';
        else if (mode === 'truncation' && count === 0) delete result.IsTruncated;
        else if (mode === 'empty' && count === 0 && !bucket.objects.size) result.Uploads = [{ Key: 'phantom', UploadId: 'id', Initiated: new Date(), StorageClass: 'STANDARD' }];
        else if (mode === 'object listed' && count === 0 && bucket.objects.size) result.Uploads = [{ Key: 'alpha/one', UploadId: 'id', Initiated: new Date(), StorageClass: 'STANDARD' }];
        else if (mode === 'missing upload' && count === 6 && !Prefix && !MaxUploads && !KeyMarker) result.Uploads.pop();
        else if (mode === 'duplicate upload' && count === 6 && !Prefix && !MaxUploads && !KeyMarker) result.Uploads[1] = result.Uploads[0];
        else if (mode === 'order' && count === 6 && !Prefix && !MaxUploads && !KeyMarker) result.Uploads.reverse();
        else if (mode === 'timestamp' && count === 6) result.Uploads[0].Initiated = 'invalid';
        else if (mode === 'initiation order' && count === 6) result.Uploads[0].Initiated = new Date('2100-01-01');
        else if (mode === 'storage' && count === 6) result.Uploads[0].StorageClass = 'wrong';
        else if (mode === 'prefix' && Prefix === 'alpha/' && !Delimiter && !MaxUploads) result.Uploads.pop();
        else if (mode === 'marker' && KeyMarker === 'alpha/one' && !MaxUploads) result.Uploads.unshift({ Key: 'alpha/one', UploadId: 'bad', Initiated: new Date(), StorageClass: 'STANDARD' });
        else if (mode === 'delimiter' && Delimiter && !MaxUploads && !KeyMarker) result.CommonPrefixes = [];
        else if (mode === 'encoded' && EncodingType) result.Uploads[0].Key = 'wrong';
        else if (mode === 'encoded prefix' && EncodingType) result.Prefix = Prefix;
        else if (mode === 'next key' && MaxUploads === 1 && !Delimiter) delete result.NextKeyMarker;
        else if (mode === 'next id' && MaxUploads === 1 && !Delimiter) delete result.NextUploadIdMarker;
        else if (mode === 'page duplicate' && MaxUploads === 1 && KeyMarker && !Delimiter) result.Uploads[0].UploadId = 'wrong';
        else if (mode === 'prefix page' && Prefix === 'alpha/' && MaxUploads === 2 && KeyMarker) result.Uploads = [];
        else if (mode === 'grouped prefix' && Delimiter && MaxUploads === 1 && result.CommonPrefixes.length) result.CommonPrefixes = [];
        else if (mode === 'other bucket' && count === 1) result.Uploads = [];
        else if ((mode === 'aborted' || mode === 'completed') && count === 4 && !Prefix && !MaxUploads) result.Uploads.push({ Key: mode === 'aborted' ? 'alpha/one' : 'alpha/two', UploadId: mode === 'aborted' ? 'id-003' : 'id-004', Initiated: new Date(), StorageClass: 'STANDARD' });
        else return false;
        return true;
      };
      changed = corrupt();
      return result;
    });
    await assert.rejects(run({ client }), undefined, mode);
    assert.ok(changed, `mutation exercised: ${mode}`);
    assert.equal(client.buckets.size, 0, mode);
  }
});

test('cleanup discovers and aborts uploads when create response is lost', async () => {
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof CreateMultipartUploadCommand) { await next(); throw new Error('lost response'); }
    return next();
  });
  await assert.rejects(run({ client }), /lost response/);
  assert.equal(client.calls.filter(c => c instanceof AbortMultipartUploadCommand).length, 1);
  assert.equal(client.buckets.size, 0);
});

test('cleanup preserves failures, attempts known aborts, and never deletes rejected buckets', async () => {
  let creates = 0;
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof CreateMultipartUploadCommand && ++creates === 2) throw new Error('create failed');
    if (command instanceof ListMultipartUploadsCommand && creates === 2) throw new Error('listing failed');
    if (command instanceof AbortMultipartUploadCommand) throw new Error('abort failed');
    return next();
  });
  await assert.rejects(run({ client }), err => {
    assert.match(err.message, /create failed/);
    assert.match(err.message, /listing failed/);
    assert.match(err.message, /abort failed/);
    assert.match(err.message, /bucket .*retained.*upload/i);
    return true;
  });
  assert.equal(client.calls.filter(c => c instanceof AbortMultipartUploadCommand).length, 1);
  assert.equal(client.calls.filter(c => c instanceof DeleteObjectCommand).length, 5);
  assert.equal(client.buckets.size, 1);
  const rejected = new FakeS3(command => {
    if (command instanceof CreateBucketCommand) throw error('BucketAlreadyExists', 409);
    throw new Error('unexpected cleanup');
  });
  await assert.rejects(run({ client: rejected }), /BucketAlreadyExists/);
  assert.equal(rejected.calls.length, 1);
});

test('a broken missing-bucket listing that recreates the bucket is cleaned up', async () => {
  const client = new FakeS3((command, service, next) => {
    if (command instanceof ListMultipartUploadsCommand && !service.buckets.has(command.input.Bucket)) {
      service.buckets.set(command.input.Bucket, { objects: new Map(), uploads: new Map() });
      return ok(200);
    }
    return next();
  });
  await assert.rejects(run({ client }), /missing bucket/);
  assert.equal(client.buckets.size, 0);
});
