import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import checks from '../checks/listing.js';

const check = name => checks.find(item => item.name === name).run;
const ok = (httpStatusCode, fields = {}) => ({ ...fields, $metadata: { httpStatusCode } });

function s3Error(name, httpStatusCode) {
  const error = new Error(name);
  error.name = name;
  error.$metadata = { httpStatusCode };
  return error;
}

// Model the S3 boundary, including opaque V2 tokens and V1 delimiter markers.
// Interceptors can break individual behaviors without breaking setup or cleanup.
class FakeS3 {
  constructor({ region = 'us-east-1', intercept } = {}) {
    this.config = { region: async () => region };
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
    if (!objects) throw s3Error('NoSuchBucket', 404);
    if (command instanceof DeleteBucketCommand) {
      if (objects.size) throw s3Error('BucketNotEmpty', 409);
      this.buckets.delete(Bucket);
      return ok(204);
    }
    if (command instanceof PutObjectCommand) {
      const Body = Buffer.from(command.input.Body);
      const ETag = `"etag-${Key}"`;
      objects.set(Key, { Body, ETag });
      return ok(200, { ETag });
    }
    if (command instanceof DeleteObjectCommand) {
      objects.delete(Key);
      return ok(204);
    }
    if (command instanceof ListObjectsCommand || command instanceof ListObjectsV2Command) {
      const { Prefix = '', Delimiter, MaxKeys = 1000 } = command.input;
      const v2 = command instanceof ListObjectsV2Command;
      const marker = v2
        ? (command.input.ContinuationToken?.slice('opaque:'.length) ?? command.input.StartAfter ?? '')
        : (command.input.Marker ?? '');
      if (v2 && command.input.ContinuationToken && !command.input.ContinuationToken.startsWith('opaque:')) {
        throw s3Error('InvalidArgument', 400);
      }
      const entries = new Map();
      for (const [key, object] of objects) {
        if (!key.startsWith(Prefix)) continue;
        const delimiterAt = Delimiter ? key.indexOf(Delimiter, Prefix.length) : -1;
        if (delimiterAt !== -1) {
          const prefix = key.slice(0, delimiterAt + Delimiter.length);
          entries.set(prefix, { prefix });
        } else {
          entries.set(key, { key, object });
        }
      }
      const all = [...entries.entries()].filter(([name]) => name > marker).sort(([a], [b]) => a < b ? -1 : 1);
      const page = all.slice(0, MaxKeys);
      const truncated = all.length > page.length;
      const last = page.at(-1)?.[0];
      return ok(200, {
        Name: Bucket, Prefix, Delimiter, MaxKeys, IsTruncated: truncated,
        Contents: page.filter(([, entry]) => entry.key).map(([, { key, object }]) => ({
          Key: key, Size: object.Body.length, ETag: object.ETag, LastModified: new Date('2024-01-02T03:04:05Z'),
        })),
        CommonPrefixes: page.filter(([, entry]) => entry.prefix).map(([, entry]) => ({ Prefix: entry.prefix })),
        ...(v2
          ? { KeyCount: page.length, NextContinuationToken: truncated ? `opaque:${last}` : undefined,
            ContinuationToken: command.input.ContinuationToken, StartAfter: command.input.StartAfter }
          : { Marker: marker, NextMarker: truncated && Delimiter ? last : undefined }),
      });
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  }
}

for (const name of ['ListObjects', 'ListObjectsV2']) {
  test(`${name} passes against a correct service and cleans up independently`, async () => {
    const client = new FakeS3({ region: 'eu-west-1' });
    client.buckets.set('existing-bucket', new Map([['existing-key', { Body: Buffer.from('keep'), ETag: 'keep' }]]));
    await check(name)({ client });
    assert.deepEqual([...client.buckets.keys()], ['existing-bucket']);
    assert.equal(client.buckets.get('existing-bucket').get('existing-key').Body.toString(), 'keep');
    const creates = client.calls.filter(command => command instanceof CreateBucketCommand);
    assert.equal(creates.length, 1);
    assert.match(creates[0].input.Bucket, /^micros3-verify-[0-9a-f-]{36}$/);
    assert.deepEqual(creates[0].input.CreateBucketConfiguration, { LocationConstraint: 'eu-west-1' });
  });

  const Command = name === 'ListObjects' ? ListObjectsCommand : ListObjectsV2Command;
  const isPopulatedList = (command, service) => command instanceof Command
    && service.buckets.get(command.input.Bucket)?.size > 0;

  test(`${name} uses a fresh bucket on every run`, async () => {
    const client = new FakeS3();
    await check(name)({ client });
    await check(name)({ client });
    const buckets = client.calls.filter(command => command instanceof CreateBucketCommand).map(command => command.input.Bucket);
    assert.equal(buckets.length, 2);
    assert.notEqual(buckets[0], buckets[1]);
    assert.equal(client.buckets.size, 0);
  });

  test(`${name} catches incorrect keys, ordering, metadata, status and bucket identity`, async () => {
    const faults = [
      ['bucket name', result => { result.Name = 'wrong-bucket'; }],
      ['HTTP status', result => { result.$metadata.httpStatusCode = 201; }],
      ['object keys', result => { result.Contents.pop(); }],
      ['object keys', result => { result.Contents.push(result.Contents[0]); }],
      ['object keys', result => { result.Contents.reverse(); }],
      ['size', result => { result.Contents[0].Size++; }],
      ['ETag', result => { result.Contents[0].ETag = 'wrong'; }],
      ['LastModified', result => { result.Contents[0].LastModified = undefined; }],
      ['common prefixes', result => { result.CommonPrefixes = [{ Prefix: 'unexpected/' }]; }],
    ];
    for (const [failure, mutate] of faults) {
      const client = new FakeS3({ async intercept(command, service, next) {
        const result = await next();
        if (isPopulatedList(command, service) && !command.input.Prefix && !command.input.MaxKeys) mutate(result);
        return result;
      } });
      await assert.rejects(check(name)({ client }), new RegExp(failure));
      assert.equal(client.buckets.size, 0, `cleanup after ${failure}`);
    }
  });

  test(`${name} detects phantom results in an empty bucket or a nonmatching prefix`, async () => {
    for (const mode of ['empty bucket', 'nonmatching prefix']) {
      const client = new FakeS3({ async intercept(command, service, next) {
        const result = await next();
        if (command instanceof Command && (mode === 'empty bucket'
          ? service.buckets.get(command.input.Bucket)?.size === 0
          : command.input.Prefix === 'missing/')) {
          result.Contents = [{ Key: 'phantom', Size: 1, ETag: 'bad', LastModified: new Date() }];
        }
        return result;
      } });
      await assert.rejects(check(name)({ client }), /object keys/);
      assert.equal(client.buckets.size, 0);
    }
  });

  test(`${name} detects ignored prefix, delimiter and exclusive starting position`, async () => {
    for (const mode of ['prefix', 'delimiter', 'start']) {
      const client = new FakeS3({ async intercept(command, service, next) {
        if (!isPopulatedList(command, service)) return next();
        const input = command.input;
        if (mode === 'prefix' && input.Prefix === 'alpha/' && !input.Delimiter) {
          return { ...await service.respond(new Command({ ...input, Prefix: '' })), Prefix: input.Prefix };
        }
        if (mode === 'delimiter' && input.Delimiter && !input.MaxKeys) {
          return { ...await service.respond(new Command({ ...input, Delimiter: undefined })), Delimiter: input.Delimiter };
        }
        if (mode === 'start' && (input.StartAfter || input.Marker)) {
          return { ...await service.respond(new Command({ ...input, StartAfter: undefined, Marker: undefined })),
            StartAfter: input.StartAfter, Marker: input.Marker };
        }
        return next();
      } });
      await assert.rejects(check(name)({ client }), /object keys|common prefixes/);
      assert.equal(client.buckets.size, 0, `cleanup after ignored ${mode}`);
    }
  });

  if (name === 'ListObjects') {
    test('ListObjects falls back to the last key when a truncated page omits NextMarker', async () => {
      const client = new FakeS3({ async intercept(command, service, next) {
        const result = await next();
        if (command instanceof ListObjectsCommand && command.input.Delimiter && result.IsTruncated
          && result.Contents?.length && !result.CommonPrefixes?.length) result.NextMarker = undefined;
        return result;
      } });
      await check(name)({ client });
      assert.equal(client.buckets.size, 0);
    });
  }

  test(`${name} rejects broken pagination and cleans up`, async () => {
    for (const mode of ['truncation', 'ignored marker', 'ignored prefix on later page', 'missing continuation', 'repeated continuation']) {
      const client = new FakeS3({ async intercept(command, service, next) {
        if (!(command instanceof Command) || !command.input.MaxKeys) return next();
        const input = command.input;
        const token = input.ContinuationToken ?? input.Marker;
        if (mode === 'ignored marker' && token) {
          return { ...await service.respond(new Command({ ...input, ContinuationToken: undefined, Marker: undefined })),
            ContinuationToken: input.ContinuationToken, Marker: input.Marker };
        }
        if (mode === 'ignored prefix on later page' && token && input.Prefix === 'alpha/' && !input.Delimiter) {
          return { ...await service.respond(new Command({ ...input, Prefix: '' })), Prefix: input.Prefix };
        }
        const result = await next();
        if (mode === 'truncation' && !token) result.IsTruncated = false;
        if (mode === 'missing continuation' && input.Delimiter && token) {
          result.NextContinuationToken = undefined;
          result.NextMarker = undefined;
        }
        if (mode === 'repeated continuation' && input.Delimiter && token) {
          if (name === 'ListObjectsV2') result.NextContinuationToken = token;
          else result.NextMarker = token;
        }
        return result;
      } });
      await assert.rejects(check(name)({ client }), /IsTruncated|object keys|continuation/);
      assert.equal(client.buckets.size, 0, `cleanup after ${mode}`);
    }
  });

  test(`${name} checks response parameters and continuation metadata`, async () => {
    const faults = [
      ['prefix', input => input.Prefix === 'alpha/' && !input.Delimiter, result => { result.Prefix = 'wrong/'; }],
      ['delimiter', input => !!input.Delimiter, result => { result.Delimiter = 'wrong'; }],
      ['MaxKeys', input => !!input.MaxKeys, result => { result.MaxKeys = 999; }],
      ...(name === 'ListObjectsV2' ? [
        ['KeyCount', input => !!input.Delimiter, result => { result.KeyCount = 99; }],
        ['StartAfter', input => !!input.StartAfter, result => { result.StartAfter = 'wrong'; }],
        ['ContinuationToken', input => !!input.ContinuationToken, result => { result.ContinuationToken = 'wrong'; }],
        ['continuation on final page', input => !!input.ContinuationToken, result => {
          if (!result.IsTruncated) result.NextContinuationToken = 'unexpected';
        }],
      ] : [
        ['Marker', input => !!input.Marker, result => { result.Marker = 'wrong'; }],
      ]),
    ];
    for (const [failure, matches, mutate] of faults) {
      const client = new FakeS3({ async intercept(command, service, next) {
        const result = await next();
        if (command instanceof Command && matches(command.input)) mutate(result);
        return result;
      } });
      await assert.rejects(check(name)({ client }), new RegExp(failure));
      assert.equal(client.buckets.size, 0, `cleanup after wrong ${failure}`);
    }
  });

  test(`${name} requires a NoSuchBucket 404 for a missing bucket`, async () => {
    for (const mode of ['success', 'status', 'code']) {
      const client = new FakeS3({ intercept(command, service, next) {
        if (command instanceof Command && !service.buckets.has(command.input.Bucket)) {
          if (mode === 'success') return ok(200, { Name: command.input.Bucket, IsTruncated: false });
          throw mode === 'status' ? s3Error('AccessDenied', 403) : s3Error('NoSuchKey', 404);
        }
        return next();
      } });
      await assert.rejects(check(name)({ client }), /missing bucket|HTTP 404|error code/);
      assert.equal(client.buckets.size, 0);
    }
  });

  test(`${name} cleans up ambiguous bucket creation but does not delete a known collision`, async () => {
    for (const collision of [false, true]) {
      const client = new FakeS3({ async intercept(command, service, next) {
        if (command instanceof CreateBucketCommand) {
          await next();
          throw s3Error(collision ? 'BucketAlreadyExists' : 'InternalError', collision ? 409 : 500);
        }
        return next();
      } });
      await assert.rejects(check(name)({ client }), /BucketAlreadyExists|InternalError/);
      assert.equal(client.buckets.size, collision ? 1 : 0);
      assert.equal(client.calls.filter(command => command instanceof DeleteBucketCommand).length, collision ? 0 : 1);
    }
  });

  test(`${name} cleans up an object when the upload response is lost`, async () => {
    let uploads = 0;
    const client = new FakeS3({ async intercept(command, service, next) {
      if (command instanceof PutObjectCommand && ++uploads === 2) {
        await next();
        throw new Error('upload response lost');
      }
      return next();
    } });
    await assert.rejects(check(name)({ client }), /upload response lost/);
    assert.equal(client.buckets.size, 0);
    assert.equal(client.calls.filter(command => command instanceof DeleteObjectCommand).length, 2);
  });

  test(`${name} cleans up after an invalid setup upload response`, async () => {
    for (const mode of ['status', 'ETag']) {
      const client = new FakeS3({ async intercept(command, service, next) {
        const result = await next();
        if (command instanceof PutObjectCommand) {
          if (mode === 'status') result.$metadata.httpStatusCode = 201;
          else result.ETag = undefined;
        }
        return result;
      } });
      await assert.rejects(check(name)({ client }), /PutObject setup/);
      assert.equal(client.buckets.size, 0);
      assert.equal(client.calls.filter(command => command instanceof DeleteObjectCommand).length, 1);
    }
  });

  test(`${name} tries every cleanup and preserves the original and resource errors`, async () => {
    let failedKey;
    const client = new FakeS3({ intercept(command, service, next) {
      if (isPopulatedList(command, service)) throw new Error('listing failed');
      if (command instanceof DeleteObjectCommand && !failedKey) {
        failedKey = command.input.Key;
        throw new Error('object delete failed');
      }
      return next();
    } });
    await assert.rejects(check(name)({ client }), error => {
      assert.match(error.message, /listing failed/);
      assert.match(error.message, /cleanup failed for objects in bucket micros3-verify-/i);
      assert.ok(error.message.includes(`/${failedKey}: object delete failed`));
      assert.match(error.message, /cleanup failed for bucket micros3-verify-.*BucketNotEmpty/i);
      return true;
    });
    const [remaining] = client.buckets.values();
    assert.deepEqual([...remaining.keys()], [failedKey]);
    assert.equal(client.calls.filter(command => command instanceof DeleteObjectCommand).length, 9);
  });
}
