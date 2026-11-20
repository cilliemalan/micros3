import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateBucketCommand, CreateMultipartUploadCommand,
  DeleteBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, ListMultipartUploadsCommand,
  PutObjectCommand, UploadPartCommand,
} from '@aws-sdk/client-s3';
import checks from '../checks/multipart.js';

const run = checks.find(check => check.name === 'CreateMultipartUpload').run;
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
    if (command instanceof HeadBucketCommand) return ok(200);
    if (command instanceof PutObjectCommand) {
      bucket.objects.set(Key, { body: Buffer.from(command.input.Body), ContentType: command.input.ContentType });
      return ok(200);
    }
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
    if (command instanceof ListMultipartUploadsCommand) {
      const uploads = [...bucket.uploads.values()].map(({ Key, UploadId }) => ({ Key, UploadId }));
      return ok(200, { IsTruncated: false, Uploads: uploads });
    }
    if (command instanceof AbortMultipartUploadCommand || command instanceof UploadPartCommand || command instanceof CompleteMultipartUploadCommand) {
      const upload = bucket.uploads.get(UploadId);
      if (!upload || upload.Key !== Key) throw error('NoSuchUpload');
      if (command instanceof AbortMultipartUploadCommand) { bucket.uploads.delete(UploadId); return ok(204); }
      if (command instanceof UploadPartCommand) {
        upload.parts.set(command.input.PartNumber, { PartNumber: command.input.PartNumber, ETag: 'etag', body: Buffer.from(command.input.Body) });
        return ok(200, { ETag: 'etag' });
      }
      const part = upload.parts.get(1);
      assert.equal(command.input.MultipartUpload.Parts[0].ETag, part.ETag);
      bucket.objects.set(Key, { body: part.body, ContentType: upload.ContentType, CacheControl: upload.CacheControl, Metadata: upload.Metadata });
      bucket.uploads.delete(UploadId);
      return ok(200);
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  }
}

test('CreateMultipartUpload verifies independent initiations and cleans isolated resources', async () => {
  const client = new FakeS3();
  client.buckets.set('existing', { objects: new Map([['keep', {}]]), uploads: new Map() });
  await run({ client });
  await run({ client });
  const buckets = client.calls.filter(c => c instanceof CreateBucketCommand).map(c => c.input.Bucket);
  assert.equal(new Set(buckets).size, 4);
  assert.deepEqual([...client.buckets.keys()], ['existing']);
  assert.ok(client.buckets.get('existing').objects.has('keep'));
});

test('CreateMultipartUpload detects incorrect responses, state, and completed metadata', async () => {
  for (const mode of ['status', 'bucket', 'key', 'id', 'duplicate id', 'listing', 'truncated', 'old object', 'neighbor object', 'completed content', 'completed type', 'completed cache', 'completed metadata', 'second content', 'second metadata', 'neighbor upload lost', 'missing bucket', 'missing code']) {
    let creates = 0;
    let gets = 0;
    let listings = 0;
    const client = new FakeS3(async (command, service, next) => {
      if (command instanceof CreateMultipartUploadCommand) {
        if (!service.buckets.has(command.input.Bucket)) {
          if (mode === 'missing bucket') return ok(200, { Bucket: command.input.Bucket, Key: command.input.Key, UploadId: 'bad' });
          if (mode === 'missing code') throw error('NoSuchKey');
          return next();
        }
        const result = await next();
        creates++;
        if (mode === 'status') result.$metadata.httpStatusCode = 201;
        if (mode === 'bucket') result.Bucket = 'wrong';
        if (mode === 'key') result.Key = 'wrong';
        if (mode === 'id') delete result.UploadId;
        if (mode === 'duplicate id' && creates === 2) result.UploadId = 'upload-1';
        return result;
      }
      if (command instanceof ListMultipartUploadsCommand && service.buckets.has(command.input.Bucket)) {
        const result = await next();
        listings++;
        if (listings === 1 && creates === 3) {
          if (mode === 'listing') result.Uploads.pop();
          if (mode === 'truncated') result.IsTruncated = true;
        }
        if (listings === 2 && mode === 'neighbor upload lost') result.Uploads = [];
        return result;
      }
      if (command instanceof GetObjectCommand) {
        gets++;
        if (mode === 'neighbor object' && gets === 2) return ok(200);
        const result = await next();
        if ((mode === 'old object' && gets === 1) || (mode === 'completed content' && gets === 3) || (mode === 'second content' && gets === 4)) result.Body = { transformToByteArray: async () => Buffer.from('wrong') };
        if (gets === 3 && mode === 'completed type') result.ContentType = 'wrong';
        if (gets === 3 && mode === 'completed cache') result.CacheControl = 'wrong';
        if ((gets === 3 && mode === 'completed metadata') || (gets === 4 && mode === 'second metadata')) result.Metadata = {};
        return result;
      }
      return next();
    });
    await assert.rejects(run({ client }), undefined, mode);
    assert.equal(client.buckets.size, 0, mode);
  }
});

test('cleanup discovers unknown uploads after lost responses and paginates before aborting', async () => {
  let pages = 0;
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof CreateMultipartUploadCommand) {
      await next();
      await next(); // a retry may create a second unknown upload
      throw new Error('response lost');
    }
    if (command instanceof ListMultipartUploadsCommand) {
      const result = await next();
      pages++;
      if (!result.Uploads.length) return ok(200, { IsTruncated: false, Uploads: [] });
      if (!command.input.KeyMarker) return ok(200, { IsTruncated: true, NextKeyMarker: result.Uploads[0].Key, NextUploadIdMarker: result.Uploads[0].UploadId, Uploads: result.Uploads.slice(0, 1) });
      return ok(200, { IsTruncated: false, Uploads: result.Uploads.slice(1) });
    }
    return next();
  });
  await assert.rejects(run({ client }), error => error.message === 'response lost');
  assert.equal(pages, 3);
  assert.equal(client.calls.filter(c => c instanceof AbortMultipartUploadCommand).length, 2);
  assert.equal(client.buckets.size, 0);
});

test('cleanup reports malformed upload entries but aborts valid uploads on this and later pages', async () => {
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof CreateMultipartUploadCommand) {
      await next();
      await next();
      await next();
      throw new Error('response lost');
    }
    if (command instanceof ListMultipartUploadsCommand) {
      const { Uploads } = await next();
      if (!command.input.KeyMarker) return ok(200, {
        IsTruncated: true, NextKeyMarker: Uploads[1].Key, NextUploadIdMarker: Uploads[1].UploadId,
        Uploads: [null, Uploads[0], { Key: 'bad' }, { Key: '', UploadId: 'invalid' }, Uploads[1]],
      });
      return ok(200, { IsTruncated: false, Uploads: [Uploads[2]] });
    }
    return next();
  });
  await assert.rejects(run({ client }), err => {
    assert.match(err.message, /response lost/);
    assert.match(err.message, /listing uploads:.*upload key and ID/);
    assert.match(err.message, /bucket .*retained.*upload/i);
    return true;
  });
  assert.deepEqual(client.calls.filter(c => c instanceof AbortMultipartUploadCommand).map(c => c.input.UploadId),
    ['upload-1', 'upload-2', 'upload-3']);
  assert.equal(client.buckets.size, 1);
  assert.equal([...client.buckets.values()][0].uploads.size, 0);
});

test('cleanup reports an invalid listing status but still aborts uploads from every page', async () => {
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof CreateMultipartUploadCommand) {
      await next();
      await next();
      throw new Error('response lost');
    }
    if (command instanceof ListMultipartUploadsCommand) {
      const { Uploads } = await next();
      if (!command.input.KeyMarker) return ok(201, {
        IsTruncated: true, NextKeyMarker: Uploads[0].Key, NextUploadIdMarker: Uploads[0].UploadId,
        Uploads: [Uploads[0]],
      });
      return ok(200, { IsTruncated: false, Uploads: [Uploads[1]] });
    }
    return next();
  });
  await assert.rejects(run({ client }), /response lost.*cleanup ListMultipartUploads HTTP status.*retained/s);
  assert.deepEqual(client.calls.filter(c => c instanceof AbortMultipartUploadCommand).map(c => c.input.UploadId),
    ['upload-1', 'upload-2']);
  assert.equal(client.buckets.size, 1);
  assert.equal([...client.buckets.values()][0].uploads.size, 0);
});

test('cleanup retains an existing bucket when upload listing falsely says NoSuchBucket', async () => {
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof CreateMultipartUploadCommand) {
      await next();
      throw new Error('response lost');
    }
    if (command instanceof ListMultipartUploadsCommand) throw error('NoSuchBucket');
    return next();
  });
  await assert.rejects(run({ client }), /response lost.*listing uploads:.*NoSuchBucket.*retained/s);
  assert.equal(client.calls.filter(c => c instanceof DeleteBucketCommand).length, 0);
  assert.equal(client.buckets.size, 1);
  assert.equal([...client.buckets.values()][0].uploads.size, 1);
});

test('cleanup retains the bucket if a NoSuchBucket listing cannot be verified', async () => {
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof CreateMultipartUploadCommand) {
      await next();
      throw new Error('response lost');
    }
    if (command instanceof ListMultipartUploadsCommand) throw error('NoSuchBucket');
    if (command instanceof HeadBucketCommand) throw error('AccessDenied', 403);
    return next();
  });
  await assert.rejects(run({ client }), /response lost.*NoSuchBucket; cannot verify bucket: AccessDenied.*retained/s);
  assert.equal(client.calls.filter(c => c instanceof DeleteBucketCommand).length, 0);
  assert.equal(client.buckets.size, 1);
});

test('cleanup reports non-Error listing failures and retains the bucket', async () => {
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof CreateMultipartUploadCommand) {
      await next();
      throw new Error('response lost');
    }
    if (command instanceof ListMultipartUploadsCommand) throw null;
    return next();
  });
  await assert.rejects(run({ client }), /response lost.*listing uploads: null.*retained/s);
  assert.equal(client.calls.filter(c => c instanceof DeleteBucketCommand).length, 0);
  assert.equal(client.buckets.size, 1);
});

test('cleanup continues past a malformed uploads array and reports the undiscoverable upload', async () => {
  let creates = 0;
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof CreateMultipartUploadCommand && ++creates === 2) {
      await next();
      await next();
      throw new Error('response lost');
    }
    if (command instanceof ListMultipartUploadsCommand) {
      const { Uploads } = await next();
      if (!command.input.KeyMarker) return ok(200, {
        IsTruncated: true, NextKeyMarker: Uploads[1].Key, NextUploadIdMarker: Uploads[1].UploadId,
        Uploads: { malformed: true },
      });
      return ok(200, { IsTruncated: false, Uploads: [Uploads[2]] });
    }
    return next();
  });
  await assert.rejects(run({ client }), err => {
    assert.match(err.message, /response lost/);
    assert.match(err.message, /listing uploads:.*uploads array/i);
    assert.match(err.message, /cleanup failed for bucket .*retained.*upload/i);
    return true;
  });
  assert.deepEqual(client.calls.filter(c => c instanceof AbortMultipartUploadCommand).map(c => c.input.UploadId),
    ['upload-1', 'upload-3']);
  assert.equal(client.calls.filter(c => c instanceof DeleteObjectCommand).length, 2);
  assert.equal([...client.buckets.values()][0].uploads.size, 1);
  assert.ok([...client.buckets.values()][0].uploads.has('upload-2'));
});

test('cleanup retains the bucket when uploads remain after acknowledged aborts, including later pages', async () => {
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof CreateMultipartUploadCommand) {
      await next();
      await next();
      await next();
      throw new Error('response lost');
    }
    if (command instanceof AbortMultipartUploadCommand && command.input.UploadId !== 'upload-1') return ok(204); // Broken no-ops.
    if (command instanceof ListMultipartUploadsCommand) {
      const result = await next();
      if (result.Uploads.length === 2) {
        if (!command.input.KeyMarker) return ok(200, {
          IsTruncated: true, NextKeyMarker: result.Uploads[0].Key, NextUploadIdMarker: result.Uploads[0].UploadId,
          Uploads: [result.Uploads[0]],
        });
        return ok(200, { IsTruncated: false, Uploads: [result.Uploads[1]] });
      }
      return result;
    }
    if (command instanceof DeleteBucketCommand) {
      // A general-purpose S3 bucket can be deleted while uploads are in progress.
      service.buckets.delete(command.input.Bucket);
      return ok(204);
    }
    return next();
  });
  await assert.rejects(run({ client }), err => {
    assert.match(err.message, /response lost/);
    assert.match(err.message, /upload.*upload-2.*remain/i);
    assert.match(err.message, /upload.*upload-3.*remain/i);
    assert.match(err.message, /bucket .*retained.*upload/i);
    return true;
  });
  assert.equal(client.calls.filter(c => c instanceof DeleteBucketCommand).length, 0);
  const bucket = [...client.buckets.values()][0];
  assert.deepEqual([...bucket.uploads.keys()], ['upload-2', 'upload-3']);
});

test('cleanup reports failure to verify that aborted uploads are gone', async () => {
  let listings = 0;
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof CreateMultipartUploadCommand) {
      await next();
      throw new Error('response lost');
    }
    if (command instanceof ListMultipartUploadsCommand && ++listings === 2) throw new Error('verification unavailable');
    return next();
  });
  await assert.rejects(run({ client }), /response lost.*listing uploads: verification unavailable.*retained/s);
  assert.equal(client.calls.filter(c => c instanceof AbortMultipartUploadCommand).length, 1);
  assert.equal(client.calls.filter(c => c instanceof DeleteObjectCommand).length, 2);
  assert.equal(client.buckets.size, 1);
  assert.equal([...client.buckets.values()][0].uploads.size, 0);
});

test('multipart cleanup reports invalid abort and object delete statuses and continues', async () => {
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof CreateMultipartUploadCommand) {
      await next();
      await next();
      throw new Error('response lost');
    }
    const response = await next();
    if (command instanceof AbortMultipartUploadCommand || command instanceof DeleteObjectCommand) {
      response.$metadata.httpStatusCode = 200;
    }
    return response;
  });
  await assert.rejects(run({ client }), err => {
    assert.match(err.message, /response lost/);
    assert.match(err.message, /cleanup AbortMultipartUpload HTTP status/);
    assert.match(err.message, /cleanup DeleteObject HTTP status/);
    assert.match(err.message, /bucket .*retained.*upload/i);
    return true;
  });
  assert.equal(client.calls.filter(c => c instanceof AbortMultipartUploadCommand).length, 2);
  assert.equal(client.calls.filter(c => c instanceof DeleteObjectCommand).length, 2);
  assert.equal(client.buckets.size, 1);
});

test('cleanup reports listing and abort errors while attempting all known aborts and object deletion', async () => {
  let calls = 0;
  const client = new FakeS3(async (command, service, next) => {
    if (command instanceof GetObjectCommand) throw new Error('check failed');
    if (command instanceof ListMultipartUploadsCommand && ++calls === 2) throw new Error('listing failed');
    if (command instanceof AbortMultipartUploadCommand) throw new Error(`abort failed ${command.input.UploadId}`);
    return next();
  });
  await assert.rejects(run({ client }), err => {
    assert.match(err.message, /check failed/);
    assert.match(err.message, /listing failed/);
    assert.match(err.message, /abort failed upload-1/);
    assert.match(err.message, /abort failed upload-2/);
    assert.match(err.message, /abort failed upload-3/);
    assert.match(err.message, /bucket .*retained.*upload/i);
    return true;
  });
  assert.equal(client.calls.filter(c => c instanceof AbortMultipartUploadCommand).length, 3);
  assert.equal(client.calls.filter(c => c instanceof DeleteObjectCommand).length, 2);
  assert.equal(client.calls.filter(c => c instanceof DeleteBucketCommand).length, 0);
  assert.equal(client.buckets.size, 1);
});

test('rejected bucket creation is never cleaned; a recreated missing bucket is cleaned', async () => {
  const rejected = new FakeS3((command, service, next) => {
    if (command instanceof CreateBucketCommand) throw error('BucketAlreadyExists', 409);
    return next();
  });
  await assert.rejects(run({ client: rejected }), /BucketAlreadyExists/);
  assert.equal(rejected.calls.filter(c => c instanceof DeleteBucketCommand || c instanceof AbortMultipartUploadCommand).length, 0);

  const recreated = new FakeS3(async (command, service, next) => {
    if (command instanceof CreateMultipartUploadCommand && !service.buckets.has(command.input.Bucket)) {
      service.buckets.set(command.input.Bucket, { objects: new Map(), uploads: new Map() });
    }
    return next();
  });
  await assert.rejects(run({ client: recreated }), /missing bucket/);
  assert.equal(recreated.buckets.size, 0);
  assert.equal(recreated.calls.filter(c => c instanceof AbortMultipartUploadCommand).length, 4);
});

test('cleanup detects missing and repeated pagination markers', async () => {
  for (const mode of ['missing', 'repeated', 'missing truncation flag']) {
    const client = new FakeS3(async (command, service, next) => {
      if (command instanceof CreateMultipartUploadCommand) { await next(); throw new Error('response lost'); }
      if (command instanceof ListMultipartUploadsCommand) {
        const result = await next();
        if (mode === 'missing truncation flag') delete result.IsTruncated;
        else Object.assign(result, { IsTruncated: true, NextKeyMarker: 'key', NextUploadIdMarker: mode === 'missing' ? undefined : 'id' });
        return result;
      }
      return next();
    });
    await assert.rejects(run({ client }), /response lost.*cleanup failed.*retained/s, mode);
    assert.equal(client.calls.filter(c => c instanceof AbortMultipartUploadCommand).length, 1, mode);
    assert.equal(client.calls.filter(c => c instanceof DeleteBucketCommand).length, 0, mode);
    assert.equal(client.buckets.size, 1, mode);
  }
});
