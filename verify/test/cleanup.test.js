import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, HeadObjectCommand,
  ListObjectsCommand, ListObjectsV2Command, PutObjectCommand,
} from '@aws-sdk/client-s3';
import objectChecks from '../checks/object.js';
import listingChecks from '../checks/listing.js';
import { runTests } from '../test-runner.js';

const ok = (httpStatusCode, fields = {}) => ({ ...fields, $metadata: { httpStatusCode } });
const missing = name => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });

// Model an upload whose response is lost, followed by malformed successful
// deletion responses. The deletions do take effect, so all buckets can be removed.
class CleanupService {
  constructor() {
    this.config = { region: async () => 'us-east-1' };
    this.buckets = new Map([['unrelated', new Map([['keep', 'untouched']])]]);
    this.created = [];
  }
  async send(command) {
    const { Bucket, Key } = command.input;
    if (command instanceof CreateBucketCommand) {
      assert.ok(!this.buckets.has(Bucket), 'each check must use a fresh bucket');
      this.created.push(Bucket);
      this.buckets.set(Bucket, new Map());
      return ok(200);
    }
    const objects = this.buckets.get(Bucket);
    if (!objects) throw missing('NoSuchBucket');
    if (command instanceof HeadObjectCommand) throw missing('NotFound');
    if (command instanceof ListObjectsCommand || command instanceof ListObjectsV2Command) {
      return ok(200, { Name: Bucket, IsTruncated: false, KeyCount: 0 });
    }
    if (command instanceof PutObjectCommand) {
      objects.set(Key, command.input.Body);
      throw new Error('upload response lost');
    }
    if (command instanceof DeleteObjectCommand) {
      objects.delete(Key);
      return ok(200); // DeleteObject should return 204.
    }
    if (command instanceof DeleteBucketCommand) {
      assert.equal(objects.size, 0, 'bucket cleanup must follow object cleanup');
      this.buckets.delete(Bucket);
      return ok(204);
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  }
}

test('object checks report failed cleanup independently and leave unrelated resources intact', async () => {
  const client = new CleanupService();
  const checks = [
    ...objectChecks.filter(({ name }) => ['HeadObject', 'CopyObject', 'DeleteObject', 'DeleteObjects'].includes(name)),
    ...listingChecks,
  ];
  const lines = [];
  const result = await runTests([{ name: 'cleanup', tests: checks }], { client }, { log: line => lines.push(line) });
  assert.deepEqual(result, { passed: 0, failed: 6, blocked: 0, notRun: 0 });
  for (const { name } of checks) {
    const line = lines.find(text => text.startsWith(`  FAIL ${name}:`));
    assert.match(line, /upload response lost/, name);
    assert.match(line, /cleanup DeleteObject HTTP status/, name);
  }
  assert.equal(new Set(client.created).size, client.created.length);
  assert.deepEqual([...client.buckets.keys()], ['unrelated']);
  assert.equal(client.buckets.get('unrelated').get('keep'), 'untouched');
  assert.ok(lines.includes('\nResults: 0 passed, 6 failed'));
});
