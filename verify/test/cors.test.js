import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteBucketCorsCommand,
  GetBucketCorsCommand,
  PutBucketCorsCommand,
} from '@aws-sdk/client-s3';
import checks from '../checks/cors.js';

const check = name => checks.find(item => item.name === name).run;
const ok = (httpStatusCode, fields = {}) => ({ ...fields, $metadata: { httpStatusCode } });

function s3Error(name, httpStatusCode) {
  const error = new Error(name);
  error.name = name;
  error.$metadata = { httpStatusCode };
  return error;
}

// Model the S3 boundary. Interceptors can break individual behaviors while
// leaving setup and cleanup functional.
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
    const { Bucket } = command.input;
    if (command instanceof CreateBucketCommand) {
      if (this.buckets.has(Bucket)) throw s3Error('BucketAlreadyExists', 409);
      this.buckets.set(Bucket, { rules: undefined });
      return ok(200);
    }
    const bucket = this.buckets.get(Bucket);
    if (!bucket) throw s3Error('NoSuchBucket', 404);
    if (command instanceof DeleteBucketCommand) {
      this.buckets.delete(Bucket);
      return ok(204);
    }
    if (command instanceof PutBucketCorsCommand) {
      const rules = command.input.CORSConfiguration.CORSRules;
      if (!rules?.length || rules.length > 100 || rules.some(rule =>
        !rule.AllowedOrigins?.length || !rule.AllowedMethods?.length
        || rule.AllowedMethods.some(method => !['GET', 'PUT', 'POST', 'DELETE', 'HEAD'].includes(method)))) {
        throw s3Error('InvalidRequest', 400);
      }
      bucket.rules = structuredClone(rules);
      return ok(200);
    }
    if (command instanceof GetBucketCorsCommand) {
      if (!bucket.rules) throw s3Error('NoSuchCORSConfiguration', 404);
      return ok(200, { CORSRules: structuredClone(bucket.rules) });
    }
    if (command instanceof DeleteBucketCorsCommand) {
      bucket.rules = undefined;
      return ok(204);
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  }
}

for (const name of [
  'PutBucketCors rejects a rule without origins',
  'PutBucketCors rejects a rule without methods',
  'PutBucketCors rejects an empty configuration',
  'PutBucketCors rejects more than 100 rules',
]) {
  test(`${name} and preserves the previous configuration`, async () => {
    const client = new FakeS3();
    await check(name)({ client });
    assert.equal(client.buckets.size, 0);
  });
}

test('PutBucketCors accepts the maximum of 100 rules and reads all of them back', async () => {
  const client = new FakeS3();
  await check('PutBucketCors accepts 100 rules')({ client });
  assert.equal(client.buckets.size, 0);
  assert.ok(client.calls.some(command => command instanceof PutBucketCorsCommand
    && command.input.CORSConfiguration.CORSRules.length === 100));
  for (const mode of ['reject', 'truncate']) {
    const broken = new FakeS3({ async intercept(command, service, next) {
      if (mode === 'reject' && command instanceof PutBucketCorsCommand) throw s3Error('InvalidRequest', 400);
      const response = await next();
      if (mode === 'truncate' && command instanceof GetBucketCorsCommand) response.CORSRules.pop();
      return response;
    } });
    await assert.rejects(check('PutBucketCors accepts 100 rules')({ client: broken }), /InvalidRequest|CORS rules/);
    assert.equal(broken.buckets.size, 0);
  }
});

test('CORS configuration is isolated between buckets on put and delete', async () => {
  const name = 'CORS configurations are isolated between buckets';
  const good = new FakeS3();
  await check(name)({ client: good });
  assert.equal(good.buckets.size, 0);

  for (const mode of ['put', 'delete']) {
    const client = new FakeS3({ async intercept(command, service, next) {
      const result = await next();
      if ((mode === 'put' && command instanceof PutBucketCorsCommand)
        || (mode === 'delete' && command instanceof DeleteBucketCorsCommand)) {
        const source = service.buckets.get(command.input.Bucket);
        if (source) for (const bucket of service.buckets.values()) bucket.rules = structuredClone(source.rules);
      }
      return result;
    } });
    await assert.rejects(check(name)({ client }));
    assert.equal(client.buckets.size, 0, `cleanup after cross-bucket ${mode}`);
  }
});

test('PutBucketCors rejects unsupported HTTP methods without changing the existing rules', async () => {
  const name = 'PutBucketCors rejects unsupported methods';
  const client = new FakeS3();
  await check(name)({ client });
  assert.equal(client.buckets.size, 0);

  const accepted = new FakeS3({ async intercept(command, service, next) {
    if (command instanceof PutBucketCorsCommand && command.input.CORSConfiguration.CORSRules[0].AllowedMethods?.includes('TRACE')) {
      return ok(200);
    }
    return next();
  } });
  await assert.rejects(check(name)({ client: accepted }), /reject/);
  assert.equal(accepted.buckets.size, 0);
});

test('missing-bucket checks clean up a deleted test bucket if a broken service recreates it', async () => {
  for (const [name, Command] of [
    ['PutBucketCors', PutBucketCorsCommand], ['GetBucketCors', GetBucketCorsCommand], ['DeleteBucketCors', DeleteBucketCorsCommand],
  ]) {
    for (const mode of ['success', 'lost response']) {
      let failed = false;
      const client = new FakeS3({ intercept(command, service, next) {
        if (command instanceof Command && !service.buckets.has(command.input.Bucket) && !failed) {
          failed = true;
          service.buckets.set(command.input.Bucket, { rules: [{ AllowedMethods: ['GET'], AllowedOrigins: ['*'] }] });
          if (mode === 'lost response') throw new Error('response lost');
          return ok(200);
        }
        return next();
      } });
      await assert.rejects(check(name)({ client }));
      assert.equal(client.buckets.size, 0, `${name}: cleanup after ${mode}`);
    }
  }
});

test('PutBucketCors requires NoSuchBucket for a missing bucket', async () => {
  for (const mode of ['success', 'status', 'code']) {
    const client = new FakeS3({ intercept(command, service, next) {
      if (command instanceof PutBucketCorsCommand && !service.buckets.has(command.input.Bucket)) {
        if (mode === 'success') return ok(200);
        throw mode === 'status' ? s3Error('AccessDenied', 403) : s3Error('NoSuchCORSConfiguration', 404);
      }
      return next();
    } });
    await assert.rejects(check('PutBucketCors')({ client }), /missing bucket|HTTP 404|error code/);
    assert.equal(client.buckets.size, 0);
  }
});

test('DeleteBucketCors removes configuration, is idempotent, and allows it to be recreated', async () => {
  const client = new FakeS3();
  await check('DeleteBucketCors')({ client });
  assert.equal(client.buckets.size, 0);
});

test('GetBucketCors checks absent and populated configurations and a missing bucket', async () => {
  const client = new FakeS3();
  await check('GetBucketCors')({ client });
  assert.equal(client.buckets.size, 0);
});

test('PutBucketCors stores and replaces a configuration, and cleans up independently', async () => {
  const client = new FakeS3({ region: 'eu-west-1' });
  client.buckets.set('existing-bucket', { rules: [{ AllowedMethods: ['GET'], AllowedOrigins: ['https://keep.example'] }] });
  await check('PutBucketCors')({ client });
  assert.deepEqual([...client.buckets.keys()], ['existing-bucket']);
  assert.deepEqual(client.buckets.get('existing-bucket').rules, [
    { AllowedMethods: ['GET'], AllowedOrigins: ['https://keep.example'] },
  ]);
  const creates = client.calls.filter(command => command instanceof CreateBucketCommand);
  assert.equal(creates.length, 2);
  for (const { input } of creates) {
    assert.match(input.Bucket, /^micros3-verify-[0-9a-f-]{36}$/);
    assert.deepEqual(input.CreateBucketConfiguration, { LocationConstraint: 'eu-west-1' });
  }
});

test('all CORS checks use fresh buckets and leave unrelated configuration untouched', async () => {
  const client = new FakeS3();
  const original = [{ AllowedMethods: ['GET'], AllowedOrigins: ['https://keep.example'] }];
  client.buckets.set('existing-bucket', { rules: structuredClone(original) });
  for (const { run } of checks) {
    await run({ client });
    assert.deepEqual([...client.buckets.keys()], ['existing-bucket']);
    assert.deepEqual(client.buckets.get('existing-bucket').rules, original);
  }
  const buckets = client.calls.filter(command => command instanceof CreateBucketCommand).map(command => command.input.Bucket);
  assert.equal(new Set(buckets).size, buckets.length);
  for (const bucket of buckets) assert.match(bucket, /^micros3-verify-[0-9a-f-]{36}$/);
  assert.ok(!client.calls.some(command => command instanceof DeleteBucketCommand && command.input.Bucket === 'existing-bucket'));
});

test('GetBucketCors detects incorrect configuration fields, rule ordering and HTTP status', async () => {
  const faults = [
    ['HTTP status', result => { result.$metadata.httpStatusCode = 201; }],
    ['missing rules', result => { result.CORSRules = undefined; }],
    ['missing rule', result => { result.CORSRules.pop(); }],
    ['extra rule', result => { result.CORSRules.push(result.CORSRules[0]); }],
    ['rule order', result => { result.CORSRules.reverse(); }],
    ['ID', result => { result.CORSRules[0].ID = 'wrong'; }],
    ['origin', result => { result.CORSRules[0].AllowedOrigins[0] = 'https://wrong.example'; }],
    ['method', result => { result.CORSRules[0].AllowedMethods.pop(); }],
    ['allowed headers', result => { result.CORSRules[0].AllowedHeaders.pop(); }],
    ['exposed headers', result => { result.CORSRules[0].ExposeHeaders.pop(); }],
    ['max age', result => { result.CORSRules[0].MaxAgeSeconds++; }],
    ['zero max age', result => { delete result.CORSRules[1].MaxAgeSeconds; }],
    ['unexpected optional field', result => { result.CORSRules[1].AllowedHeaders = ['*']; }],
  ];
  for (const [failure, mutate] of faults) {
    const client = new FakeS3({ async intercept(command, service, next) {
      const result = await next();
      if (command instanceof GetBucketCorsCommand && result.CORSRules) mutate(result);
      return result;
    } });
    await assert.rejects(check('GetBucketCors')({ client }), /GetBucketCors HTTP status|CORS rules/, failure);
    assert.equal(client.buckets.size, 0, `cleanup after ${failure}`);
  }
});

test('CORS rule order is significant, but list order within a rule is not', async () => {
  const client = new FakeS3({ async intercept(command, service, next) {
    const result = await next();
    if (command instanceof GetBucketCorsCommand && result.CORSRules) {
      for (const rule of result.CORSRules) {
        for (const field of ['AllowedOrigins', 'AllowedMethods', 'AllowedHeaders', 'ExposeHeaders']) rule[field]?.reverse();
      }
    }
    return result;
  } });
  await check('GetBucketCors')({ client });
  assert.equal(client.buckets.size, 0);
});

test('missing bucket and missing configuration errors are distinguished', async () => {
  for (const [name, Command] of [['GetBucketCors', GetBucketCorsCommand], ['DeleteBucketCors', DeleteBucketCorsCommand]]) {
    for (const mode of ['success', 'status', 'code']) {
      const client = new FakeS3({ intercept(command, service, next) {
        if (command instanceof Command && !service.buckets.has(command.input.Bucket)) {
          if (mode === 'success') return ok(200);
          throw mode === 'status' ? s3Error('AccessDenied', 403) : s3Error('NoSuchCORSConfiguration', 404);
        }
        return next();
      } });
      await assert.rejects(check(name)({ client }), /missing bucket|HTTP 404|error code/);
      assert.equal(client.buckets.size, 0, `${name}: cleanup after ${mode}`);
    }
  }
  for (const name of ['GetBucketCors', 'DeleteBucketCors']) {
    for (const mode of ['success', 'status', 'code']) {
      const client = new FakeS3({ intercept(command, service, next) {
        const bucket = service.buckets.get(command.input.Bucket);
        if (command instanceof GetBucketCorsCommand && bucket && !bucket.rules) {
          if (mode === 'success') return ok(200, { CORSRules: [] });
          throw mode === 'status' ? s3Error('AccessDenied', 403) : s3Error('NoSuchBucket', 404);
        }
        return next();
      } });
      await assert.rejects(check(name)({ client }), /without a CORS configuration|without configuration/);
      assert.equal(client.buckets.size, 0, `${name}: cleanup after ${mode}`);
    }
  }
});

test('DeleteBucketCors detects a no-op, incorrect status and non-idempotent deletion', async () => {
  for (const mode of ['no-op', 'status', 'repeat']) {
    let deletes = 0;
    const client = new FakeS3({ intercept(command, service, next) {
      if (command instanceof DeleteBucketCorsCommand && service.buckets.has(command.input.Bucket)) {
        deletes++;
        if (mode === 'no-op' && deletes === 1) return ok(204);
        if (mode === 'status' && deletes === 1) return ok(200);
        if (mode === 'repeat' && deletes === 2) throw s3Error('NoSuchCORSConfiguration', 404);
      }
      return next();
    } });
    await assert.rejects(check('DeleteBucketCors')({ client }), /without a CORS configuration|DeleteBucketCors HTTP status|NoSuchCORSConfiguration/);
    assert.equal(client.buckets.size, 0, `cleanup after ${mode}`);
  }
});

test('invalid configurations must return 400 and leave the previous rules intact', async () => {
  for (const { name } of checks.filter(item => item.name.startsWith('PutBucketCors rejects '))) {
    for (const mode of ['accepted', 'wrong status', 'changed rules']) {
      let writes = 0;
      const client = new FakeS3({ intercept(command, service, next) {
        if (command instanceof PutBucketCorsCommand && ++writes === 2) {
          if (mode === 'accepted') return ok(200);
          if (mode === 'changed rules') service.buckets.get(command.input.Bucket).rules = [{ AllowedMethods: ['GET'], AllowedOrigins: ['*'] }];
          throw mode === 'wrong status' ? s3Error('AccessDenied', 403) : s3Error('InvalidRequest', 400);
        }
        return next();
      } });
      await assert.rejects(check(name)({ client }), /should reject|Invalid CORS configuration HTTP status|CORS rules/);
      assert.equal(client.buckets.size, 0, `${name}: cleanup after ${mode}`);
    }
  }
});

test('CORS checks clean up even when a write succeeds but its response is lost', async () => {
  for (const { name, run } of checks) {
    let failed = false;
    const client = new FakeS3({ async intercept(command, service, next) {
      if (command instanceof PutBucketCorsCommand && !failed) {
        failed = true;
        await next();
        throw new Error('put response lost');
      }
      return next();
    } });
    await assert.rejects(run({ client }), /put response lost/, name);
    assert.equal(client.buckets.size, 0, `cleanup after ${name}`);
    for (const { input: { Bucket } } of client.calls.filter(command => command instanceof CreateBucketCommand)) {
      const cors = client.calls.findIndex(command => command instanceof DeleteBucketCorsCommand && command.input.Bucket === Bucket);
      const bucket = client.calls.findIndex(command => command instanceof DeleteBucketCommand && command.input.Bucket === Bucket);
      assert.ok(cors >= 0 && bucket > cors, `${name}: CORS and bucket cleanup for ${Bucket}`);
    }
  }
});

test('cleanup reports CORS and bucket failures without hiding the original error', async () => {
  const client = new FakeS3({ intercept(command, service, next) {
    if (command instanceof GetBucketCorsCommand) throw new Error('get failed');
    if (command instanceof DeleteBucketCorsCommand) throw new Error('cors cleanup failed');
    if (command instanceof DeleteBucketCommand) throw new Error('bucket cleanup failed');
    return next();
  } });
  await assert.rejects(check('PutBucketCors')({ client }), error => {
    assert.match(error.message, /get failed/);
    assert.match(error.message, /cleanup failed for CORS configuration in bucket micros3-verify-.*cors cleanup failed/i);
    assert.match(error.message, /cleanup failed for bucket micros3-verify-.*bucket cleanup failed/i);
    return true;
  });
  assert.ok(client.calls.some(command => command instanceof DeleteBucketCommand));
});

test('PutBucketCors detects an ignored write, merging on replacement and bad HTTP status', async () => {
  for (const mode of ['ignored', 'merge', 'status']) {
    let writes = 0;
    const client = new FakeS3({ async intercept(command, service, next) {
      if (command instanceof PutBucketCorsCommand && service.buckets.has(command.input.Bucket)) {
        writes++;
        if (mode === 'ignored') return ok(200);
        if (mode === 'merge' && writes === 2) {
          service.buckets.get(command.input.Bucket).rules.push(...structuredClone(command.input.CORSConfiguration.CORSRules));
          return ok(200);
        }
        const result = await next();
        if (mode === 'status') result.$metadata.httpStatusCode = 201;
        return result;
      }
      return next();
    } });
    await assert.rejects(check('PutBucketCors')({ client }), /NoSuchCORSConfiguration|CORS rules|PutBucketCors HTTP status/);
    assert.equal(client.buckets.size, 0, `cleanup after ${mode}`);
  }
});
