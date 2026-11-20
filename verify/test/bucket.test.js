import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetBucketLocationCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import checks from '../checks/bucket.js';

const check = name => checks.find(item => item.name === name).run;
const ok = (httpStatusCode, fields = {}) => ({ ...fields, $metadata: { httpStatusCode } });

function s3Error(name, httpStatusCode) {
  const error = new Error(name);
  error.name = name;
  error.$metadata = { httpStatusCode };
  return error;
}

// A small stateful service double. Interceptors can break one behavior at a time
// while leaving setup and cleanup real, so false positives and leaks are visible.
class FakeS3 {
  constructor({ region = 'us-east-1', intercept, pageSize = Infinity } = {}) {
    this.region = region;
    this.config = { region: async () => region };
    this.intercept = intercept;
    this.pageSize = pageSize;
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
      if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(Bucket)) throw s3Error('InvalidBucketName', 400);
      if (this.buckets.has(Bucket)) {
        if (this.region !== 'us-east-1') throw s3Error('BucketAlreadyOwnedByYou', 409);
        return ok(200, { Location: `/${Bucket}` });
      }
      this.buckets.set(Bucket, new Map());
      return ok(200, { Location: `/${Bucket}` });
    }
    if (command instanceof ListBucketsCommand) {
      const names = [...this.buckets.keys()];
      const start = Number(command.input.ContinuationToken || 0);
      const end = Math.min(start + this.pageSize, names.length);
      return ok(200, {
        Buckets: names.slice(start, end).map(Name => ({ Name })),
        ContinuationToken: end < names.length ? String(end) : undefined,
      });
    }
    const objects = this.buckets.get(Bucket);
    if (!objects) throw s3Error('NoSuchBucket', 404);
    if (command instanceof HeadBucketCommand) return ok(200, { BucketRegion: this.region });
    if (command instanceof GetBucketLocationCommand) {
      return ok(200, { LocationConstraint: this.region === 'us-east-1' ? undefined : this.region });
    }
    if (command instanceof DeleteBucketCommand) {
      if (objects.size) throw s3Error('BucketNotEmpty', 409);
      this.buckets.delete(Bucket);
      return ok(204);
    }
    if (command instanceof PutObjectCommand) {
      objects.set(Key, command.input.Body);
      return ok(200);
    }
    if (command instanceof GetObjectCommand) {
      if (!objects.has(Key)) throw s3Error('NoSuchKey', 404);
      return ok(200, { Body: { transformToString: async () => objects.get(Key) } });
    }
    if (command instanceof DeleteObjectCommand) {
      objects.delete(Key);
      return ok(204);
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  }
}

function callsOf(client, Command) {
  return client.calls.filter(command => command instanceof Command);
}

test('all bucket checks pass independently, use unique valid names, and leave existing buckets alone', async () => {
  const client = new FakeS3({ pageSize: 1 });
  client.buckets.set('some-existing-bucket', new Map());
  for (const { run } of checks) {
    await run({ client });
    assert.deepEqual([...client.buckets.keys()], ['some-existing-bucket']);
  }

  const createCalls = callsOf(client, CreateBucketCommand).map(command => command.input.Bucket);
  const valid = createCalls.filter(name => name.startsWith('micros3-verify-'));
  const created = new Set(valid);
  assert.equal(created.size, checks.length); // ListBuckets uses two buckets; the invalid-name check has none.
  assert.equal(valid.length, created.size + 1); // The repeat-creation check reuses its bucket.
  assert.equal(createCalls.length, valid.length + 1);
  for (const name of created) {
    assert.match(name, /^micros3-verify-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    assert.ok(name.length <= 63);
  }
  assert.ok(callsOf(client, ListBucketsCommand).some(command => command.input.ContinuationToken === '1'));
  assert.ok(callsOf(client, ListBucketsCommand).some(command => command.input.ContinuationToken === '2'));
  assert.ok(callsOf(client, DeleteObjectCommand).length > 0);
  assert.ok(!callsOf(client, DeleteBucketCommand).some(command => command.input.Bucket === 'some-existing-bucket'));
});

test('creation and location checks handle S3 region conventions', async () => {
  for (const region of ['us-east-1', 'eu-west-1', 'ap-south-1']) {
    const client = new FakeS3({ region, async intercept(command, service, next) {
      if (command instanceof GetBucketLocationCommand && service.buckets.has(command.input.Bucket) && region === 'eu-west-1') {
        return ok(200, { LocationConstraint: 'EU' });
      }
      return next();
    } });
    await check('GetBucketLocation')({ client });
    const [create] = callsOf(client, CreateBucketCommand);
    assert.deepEqual(create.input.CreateBucketConfiguration,
      region === 'us-east-1' ? undefined : { LocationConstraint: region });
    assert.equal(client.buckets.size, 0);
  }
});

test('CreateBucket catches bad responses and a bucket that was not created', async () => {
  for (const intercept of [
    async (command, service, next) => command instanceof CreateBucketCommand
      ? { ...await next(), $metadata: { httpStatusCode: 201 } } : next(),
    async (command, service, next) => command instanceof CreateBucketCommand
      ? { ...await next(), Location: '/wrong-bucket' } : next(),
    async (command, service, next) => command instanceof CreateBucketCommand
      ? ok(200, { Location: `/${command.input.Bucket}` }) : next(),
  ]) {
    const client = new FakeS3({ intercept });
    await assert.rejects(check('CreateBucket')({ client }));
    assert.equal(client.buckets.size, 0);
    assert.equal(callsOf(client, DeleteBucketCommand).length, 1);
  }
});

test('invalid bucket names must be rejected, and an unexpectedly created bucket is cleaned up', async () => {
  const client = new FakeS3({ intercept(command, service, next) {
    if (command instanceof CreateBucketCommand && command.input.Bucket.includes('_')) {
      service.buckets.set(command.input.Bucket, new Map());
      return ok(200); // The broken service accepts an invalid name.
    }
    return next();
  } });
  await assert.rejects(check('CreateBucket rejects an invalid bucket name')({ client }), /should reject/);
  assert.equal(client.buckets.size, 0);
  assert.equal(callsOf(client, DeleteBucketCommand).length, 1);

  const wrongError = new FakeS3({ intercept(command, service, next) {
    if (command instanceof CreateBucketCommand) throw s3Error('AccessDenied', 403);
    return next();
  } });
  await assert.rejects(check('CreateBucket rejects an invalid bucket name')({ client: wrongError }), /HTTP 400/);
  assert.equal(callsOf(wrongError, DeleteBucketCommand).length, 0);
});

test('repeat creation checks the region-specific response and preserves existing objects', async () => {
  for (const region of ['us-east-1', 'eu-west-1']) {
    const client = new FakeS3({ region });
    await check('CreateBucket preserves an existing bucket on repeat creation')({ client });
    assert.equal(client.buckets.size, 0);
    assert.equal(callsOf(client, CreateBucketCommand).length, 2);
    assert.equal(callsOf(client, DeleteObjectCommand).length, 1);
  }

  const erased = new FakeS3({ async intercept(command, service, next) {
    if (command instanceof CreateBucketCommand && service.buckets.has(command.input.Bucket)) {
      service.buckets.get(command.input.Bucket).clear();
      return ok(200);
    }
    return next();
  } });
  await assert.rejects(check('CreateBucket preserves an existing bucket on repeat creation')({ client: erased }));
  assert.equal(erased.buckets.size, 0);

  const wrongResponse = new FakeS3({ region: 'eu-west-1', intercept(command, service, next) {
    if (command instanceof CreateBucketCommand && service.buckets.has(command.input.Bucket)) return ok(200);
    return next();
  } });
  await assert.rejects(check('CreateBucket preserves an existing bucket on repeat creation')({ client: wrongResponse }), /already owned/);
  assert.equal(wrongResponse.buckets.size, 0);
});

test('ListBuckets detects missing buckets and repeated pagination tokens', async () => {
  for (const response of [ok(200, { Buckets: [] }), ok(200, { Buckets: [], ContinuationToken: 'stuck' })]) {
    const client = new FakeS3({ intercept: (command, service, next) =>
      command instanceof ListBucketsCommand ? response : next() });
    await assert.rejects(check('ListBuckets')({ client }), /did not include|repeated a continuation token/);
    assert.equal(client.buckets.size, 0);
  }
});

test('ListBuckets must include both independently created buckets', async () => {
  const client = new FakeS3({ intercept(command, service, next) {
    if (command instanceof ListBucketsCommand) {
      return ok(200, { Buckets: [{ Name: [...service.buckets.keys()][0] }] });
    }
    return next();
  } });
  await assert.rejects(check('ListBuckets')({ client }), /did not include/);
  assert.equal(client.buckets.size, 0);
});

test('ListBuckets cannot loop forever on an endless sequence of new tokens', async () => {
  let page = 0;
  const client = new FakeS3({ intercept: (command, service, next) =>
    command instanceof ListBucketsCommand ? ok(200, { Buckets: [], ContinuationToken: String(++page) }) : next() });
  await assert.rejects(check('ListBuckets')({ client }), /exceeded 1000 pages/);
  assert.equal(page, 1000);
  assert.equal(client.buckets.size, 0);
});

test('HeadBucket requires the right region and a 404 for a missing bucket', async () => {
  for (const intercept of [
    (command, service, next) => command instanceof HeadBucketCommand && service.buckets.has(command.input.Bucket)
      ? ok(200, { BucketRegion: 'wrong-region' }) : next(),
    (command, service, next) => command instanceof HeadBucketCommand && !service.buckets.has(command.input.Bucket)
      ? ok(200) : next(),
    (command, service, next) => {
      if (command instanceof HeadBucketCommand && !service.buckets.has(command.input.Bucket)) throw s3Error('AccessDenied', 403);
      return next();
    },
  ]) {
    const client = new FakeS3({ intercept });
    await assert.rejects(check('HeadBucket')({ client }));
    assert.equal(client.buckets.size, 0);
  }
});

test('GetBucketLocation detects a wrong region and a missing bucket that appears to exist', async () => {
  for (const intercept of [
    (command, service, next) => command instanceof GetBucketLocationCommand && service.buckets.has(command.input.Bucket)
      ? ok(200, { LocationConstraint: 'wrong-region' }) : next(),
    (command, service, next) => command instanceof GetBucketLocationCommand && !service.buckets.has(command.input.Bucket)
      ? ok(200) : next(),
    (command, service, next) => {
      if (command instanceof GetBucketLocationCommand && !service.buckets.has(command.input.Bucket)) throw s3Error('NoSuchKey', 404);
      return next();
    },
  ]) {
    const client = new FakeS3({ intercept });
    await assert.rejects(check('GetBucketLocation')({ client }));
    assert.equal(client.buckets.size, 0);
  }
});

test('DeleteBucket detects success without deletion and incorrect missing-bucket responses', async () => {
  let first = true;
  const client = new FakeS3({ intercept(command, service, next) {
    if (command instanceof DeleteBucketCommand && first) {
      first = false;
      return ok(204); // Leave the bucket behind; the cleanup call must remove it.
    }
    return next();
  } });
  await assert.rejects(check('DeleteBucket')({ client }), /missing bucket/);
  assert.equal(client.buckets.size, 0);
  assert.equal(callsOf(client, DeleteBucketCommand).length, 2);

  const missing = new FakeS3({ intercept: (command, service, next) =>
    command instanceof DeleteBucketCommand && !service.buckets.has(command.input.Bucket) ? ok(204) : next() });
  await assert.rejects(check('DeleteBucket')({ client: missing }), /missing bucket/);
  assert.equal(missing.buckets.size, 0);

  const wrongError = new FakeS3({ intercept(command, service, next) {
    if (command instanceof DeleteBucketCommand && !service.buckets.has(command.input.Bucket)) throw s3Error('NoSuchKey', 404);
    return next();
  } });
  await assert.rejects(check('DeleteBucket')({ client: wrongError }), /error code/);
  assert.equal(wrongError.buckets.size, 0);
});

test('a rejected non-empty delete must preserve the bucket and object', async () => {
  for (const intercept of [
    (command, service, next) => command instanceof DeleteBucketCommand && service.buckets.get(command.input.Bucket)?.size
      ? ok(204) : next(),
    (command, service, next) => command instanceof DeleteBucketCommand && service.buckets.get(command.input.Bucket)?.size
      ? Promise.reject(s3Error('AccessDenied', 403)) : next(),
    (command, service, next) => command instanceof GetObjectCommand
      ? ok(200, { Body: { transformToString: async () => 'corrupted' } }) : next(),
  ]) {
    const client = new FakeS3({ intercept });
    await assert.rejects(check('DeleteBucket rejects a non-empty bucket')({ client }));
    assert.equal(client.buckets.size, 0);
    assert.equal(callsOf(client, DeleteObjectCommand).length, 1);
  }
});

test('cleanup handles ambiguous creation and upload failures but never deletes a known collision', async () => {
  for (const [name, code] of [['InternalError', 500], ['RequestTimeout', 408]]) {
    const createFailure = new FakeS3({ async intercept(command, service, next) {
      if (command instanceof CreateBucketCommand) {
        await next();
        throw s3Error(name, code);
      }
      return next();
    } });
    await assert.rejects(check('CreateBucket')({ client: createFailure }), new RegExp(name));
    assert.equal(createFailure.buckets.size, 0);
  }

  const uploadFailure = new FakeS3({ async intercept(command, service, next) {
    if (command instanceof PutObjectCommand) {
      await next();
      throw new Error('upload response lost');
    }
    return next();
  } });
  await assert.rejects(check('DeleteBucket rejects a non-empty bucket')({ client: uploadFailure }), /upload response lost/);
  assert.equal(uploadFailure.buckets.size, 0);
  assert.equal(callsOf(uploadFailure, DeleteObjectCommand).length, 1);

  for (const code of [403, 409]) {
    const collision = new FakeS3({ intercept(command, service, next) {
      if (command instanceof CreateBucketCommand) {
        service.buckets.set(command.input.Bucket, new Map()); // Represents a bucket not owned by the check.
        throw s3Error('CreateRejected', code);
      }
      return next();
    } });
    await assert.rejects(check('CreateBucket')({ client: collision }), /CreateRejected/);
    assert.equal(collision.buckets.size, 1);
    assert.equal(callsOf(collision, DeleteBucketCommand).length, 0);
  }

  const retry = new FakeS3({ intercept(command, service, next) {
    if (command instanceof CreateBucketCommand) {
      const error = s3Error('BucketAlreadyOwnedByYou', 409);
      error.$metadata.attempts = 2;
      throw error;
    }
    return next();
  } });
  await assert.rejects(check('CreateBucket')({ client: retry }), /retries for micros3-verify-.*inspect for a leftover bucket/);
  assert.equal(callsOf(retry, DeleteBucketCommand).length, 0);
});

test('object and bucket cleanup failures include both resource names and the original failure', async () => {
  const client = new FakeS3({ intercept(command, service, next) {
    if (command instanceof GetObjectCommand) throw new Error('read failed');
    if (command instanceof DeleteObjectCommand) throw new Error('object delete failed');
    return next(); // The bucket cleanup also fails because the object remains.
  } });
  await assert.rejects(check('DeleteBucket rejects a non-empty bucket')({ client }), error => {
    assert.match(error.message, /read failed/);
    assert.match(error.message, /cleanup failed for object micros3-verify-.*\/non-empty-check: object delete failed/);
    assert.match(error.message, /cleanup failed for bucket micros3-verify-.*: BucketNotEmpty/);
    return true;
  });
});

test('bucket cleanup detects a successful delete response that left the bucket behind', async () => {
  const client = new FakeS3({ intercept(command, service, next) {
    if (command instanceof DeleteBucketCommand) return ok(204);
    return next();
  } });
  await assert.rejects(check('CreateBucket')({ client }), /cleanup failed for bucket .*HeadBucket after cleanup/i);
  assert.equal(client.buckets.size, 1);
});

test('an unverifiable bucket deletion reports both the check and cleanup failures', async () => {
  const client = new FakeS3({ intercept(command, service, next) {
    if (command instanceof HeadBucketCommand) {
      if (service.buckets.has(command.input.Bucket)) throw new Error('check failed');
      throw s3Error('AccessDenied', 403);
    }
    return next();
  } });
  await assert.rejects(check('CreateBucket')({ client }), err => {
    assert.match(err.message, /check failed/);
    assert.match(err.message, /cleanup failed for bucket .*HeadBucket after cleanup.*HTTP 404/is);
    return true;
  });
  assert.equal(client.buckets.size, 0);
});

test('cleanup reports incorrect delete statuses even when the resources were removed', async () => {
  for (const Command of [DeleteObjectCommand, DeleteBucketCommand]) {
    const client = new FakeS3({ async intercept(command, service, next) {
      const response = await next();
      if (command instanceof Command) response.$metadata.httpStatusCode = 200;
      return response;
    } });
    await assert.rejects(check('CreateBucket preserves an existing bucket on repeat creation')({ client }),
      new RegExp(`cleanup.*${Command.name.replace('Command', '')} HTTP status`, 'i'));
    assert.equal(client.buckets.size, 0);
    assert.ok(callsOf(client, DeleteBucketCommand).length > 0);
  }
});

test('a wrong 404 error during bucket cleanup is not silently ignored', async () => {
  const client = new FakeS3({ intercept(command, service, next) {
    if (command instanceof DeleteBucketCommand) throw s3Error('NoSuchKey', 404);
    return next();
  } });
  await assert.rejects(check('CreateBucket')({ client }), /Cleanup failed for bucket .*NoSuchKey/);
});

test('cleanup errors are reported without hiding the original check failure', async () => {
  for (const failCheck of [false, true]) {
    const client = new FakeS3({ intercept(command, service, next) {
      if (command instanceof HeadBucketCommand && failCheck) throw new Error('head failed');
      if (command instanceof DeleteBucketCommand) throw new Error('delete failed');
      return next();
    } });
    await assert.rejects(check('CreateBucket')({ client }), error => {
      assert.match(error.message, /cleanup failed for bucket micros3-verify-.*: delete failed/i);
      if (failCheck) assert.match(error.message, /head failed/);
      return true;
    });
  }
});
