import assert from 'node:assert/strict';
import test from 'node:test';
import { CreateBucketCommand, DeleteBucketCommand, GetBucketEncryptionCommand } from '@aws-sdk/client-s3';
import checks from '../checks/encryption.js';

const check = name => checks.find(item => item.name === name).run;
const ok = (httpStatusCode, fields = {}) => ({ ...fields, $metadata: { httpStatusCode } });

function s3Error(name, httpStatusCode) {
  const error = new Error(name);
  error.name = name;
  error.$metadata = { httpStatusCode };
  return error;
}

class FakeS3 {
  constructor({ region = 'us-east-1', intercept } = {}) {
    this.config = { region: async () => region };
    this.intercept = intercept;
    this.buckets = new Set();
    this.calls = [];
  }

  async send(command) {
    this.calls.push(command);
    const next = () => this.respond(command);
    return this.intercept ? this.intercept(command, this, next) : next();
  }

  async respond(command) {
    const { Bucket } = command.input;
    if (command instanceof CreateBucketCommand) {
      if (this.buckets.has(Bucket)) throw s3Error('BucketAlreadyExists', 409);
      this.buckets.add(Bucket);
      return ok(200);
    }
    if (!this.buckets.has(Bucket)) throw s3Error('NoSuchBucket', 404);
    if (command instanceof DeleteBucketCommand) {
      this.buckets.delete(Bucket);
      return ok(204);
    }
    if (command instanceof GetBucketEncryptionCommand) {
      return ok(200, { ServerSideEncryptionConfiguration: { Rules: [
        { ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' }, BucketKeyEnabled: false },
      ] } });
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  }
}

test('encryption checks use isolated buckets, respect the region and clean up', async () => {
  const client = new FakeS3({ region: 'eu-west-1' });
  client.buckets.add('existing-bucket');
  for (const { run } of checks) {
    await run({ client });
    assert.deepEqual([...client.buckets], ['existing-bucket']);
  }
  const creates = client.calls.filter(command => command instanceof CreateBucketCommand);
  assert.equal(creates.length, 2);
  assert.equal(new Set(creates.map(command => command.input.Bucket)).size, 2);
  for (const { input } of creates) {
    assert.match(input.Bucket, /^micros3-verify-[0-9a-f-]{36}$/);
    assert.deepEqual(input.CreateBucketConfiguration, { LocationConstraint: 'eu-west-1' });
  }
  assert.ok(!client.calls.some(command => command instanceof DeleteBucketCommand && command.input.Bucket === 'existing-bucket'));
});

test('GetBucketEncryption accepts an omitted optional bucket key flag', async () => {
  const client = new FakeS3({ async intercept(command, service, next) {
    const response = await next();
    if (command instanceof GetBucketEncryptionCommand) delete response.ServerSideEncryptionConfiguration.Rules[0].BucketKeyEnabled;
    return response;
  } });
  await check('GetBucketEncryption')({ client });
  assert.equal(client.buckets.size, 0);
});

test('GetBucketEncryption detects incorrect status and default encryption configuration', async () => {
  const faults = [
    ['status', r => { r.$metadata.httpStatusCode = 201; }],
    ['missing configuration', r => { delete r.ServerSideEncryptionConfiguration; }],
    ['missing rules', r => { delete r.ServerSideEncryptionConfiguration.Rules; }],
    ['empty rules', r => { r.ServerSideEncryptionConfiguration.Rules = []; }],
    ['extra rule', r => { r.ServerSideEncryptionConfiguration.Rules.push({}); }],
    ['missing default', r => { delete r.ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault; }],
    ['missing algorithm', r => { delete r.ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm; }],
    ['wrong algorithm', r => { r.ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm = 'aws:kms'; }],
    ['KMS key', r => { r.ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.KMSMasterKeyID = 'key'; }],
    ['bucket key', r => { r.ServerSideEncryptionConfiguration.Rules[0].BucketKeyEnabled = true; }],
  ];
  for (const [name, mutate] of faults) {
    const client = new FakeS3({ async intercept(command, service, next) {
      const response = await next();
      if (command instanceof GetBucketEncryptionCommand) mutate(response);
      return response;
    } });
    await assert.rejects(check('GetBucketEncryption')({ client }), undefined, name);
    assert.equal(client.buckets.size, 0, `cleanup after ${name}`);
  }
});

test('missing bucket must produce NoSuchBucket and HTTP 404', async () => {
  for (const mode of ['success', 'wrong status', 'wrong code']) {
    const client = new FakeS3({ intercept(command, service, next) {
      if (command instanceof GetBucketEncryptionCommand && !service.buckets.has(command.input.Bucket)) {
        if (mode === 'success') return ok(200);
        throw mode === 'wrong status' ? s3Error('AccessDenied', 403) : s3Error('ServerSideEncryptionConfigurationNotFoundError', 404);
      }
      return next();
    } });
    await assert.rejects(check('GetBucketEncryption rejects a missing bucket')({ client }), /missing bucket|HTTP 404|error code/, mode);
    assert.equal(client.buckets.size, 0);
  }
});

test('cleanup remains armed when a broken missing-bucket GET recreates the bucket', async () => {
  for (const mode of ['success', 'lost response']) {
    const client = new FakeS3({ intercept(command, service, next) {
      if (command instanceof GetBucketEncryptionCommand && !service.buckets.has(command.input.Bucket)) {
        service.buckets.add(command.input.Bucket);
        if (mode === 'lost response') throw new Error('response lost');
        return ok(200);
      }
      return next();
    } });
    await assert.rejects(check('GetBucketEncryption rejects a missing bucket')({ client }));
    assert.equal(client.buckets.size, 0, mode);
  }
});

test('missing-bucket setup verifies deletion before checking encryption', async () => {
  const client = new FakeS3({ async intercept(command, service, next) {
    if (command instanceof DeleteBucketCommand && service.buckets.has(command.input.Bucket)) {
      const response = await next();
      response.$metadata.httpStatusCode = 200;
      return response;
    }
    return next();
  } });
  await assert.rejects(check('GetBucketEncryption rejects a missing bucket')({ client }), /DeleteBucket setup HTTP status/);
  assert.ok(!client.calls.some(command => command instanceof GetBucketEncryptionCommand));
  assert.equal(client.buckets.size, 0);
});

test('cleanup reports failures without hiding the original error', async () => {
  const client = new FakeS3({ intercept(command, service, next) {
    if (command instanceof GetBucketEncryptionCommand) throw new Error('get failed');
    if (command instanceof DeleteBucketCommand) throw new Error('delete failed');
    return next();
  } });
  await assert.rejects(check('GetBucketEncryption')({ client }), error => {
    assert.match(error.message, /get failed/);
    assert.match(error.message, /cleanup failed for bucket micros3-verify-.*delete failed/i);
    return true;
  });
});

test('a rejected bucket creation never deletes a possible collision', async () => {
  const client = new FakeS3({ intercept(command, service, next) {
    if (command instanceof CreateBucketCommand) throw s3Error('BucketAlreadyExists', 409);
    return next();
  } });
  await assert.rejects(check('GetBucketEncryption')({ client }), /BucketAlreadyExists/);
  assert.ok(!client.calls.some(command => command instanceof DeleteBucketCommand));
});
