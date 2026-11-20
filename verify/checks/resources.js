import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CreateBucketCommand, DeleteBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';

// Bucket names are global on AWS, so never reuse a name or delete a known collision.
export function bucketName() {
  return `micros3-verify-${randomUUID()}`;
}

export function status(error) {
  return error?.$metadata?.httpStatusCode;
}

export function message(error) {
  return error instanceof Error ? error.message : String(error);
}

export function creationRejected(error) {
  // An HTTP timeout, like a transport error, can follow a successful creation.
  return status(error) >= 400 && status(error) < 500 && status(error) !== 408;
}

// Preserve the original failure when cleanup fails too; the runner reports messages.
export async function withCleanup(action, cleanup, resource) {
  let failure;
  let failed = false;
  try {
    return await action();
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      if (failed) {
        throw new AggregateError([failure, error], `${message(failure)}; cleanup failed for ${resource}: ${message(error)}`);
      }
      throw new Error(`Cleanup failed for ${resource}: ${message(error)}`, { cause: error });
    }
  }
}

export async function ignoreMissing(action, errorCodes = ['NoSuchBucket']) {
  try {
    await action();
  } catch (error) {
    if (status(error) !== 404 || !errorCodes.includes(error.name)) throw error;
  }
}

export async function cleanupDelete(client, command, errorCodes) {
  await ignoreMissing(async () => {
    const response = await client.send(command);
    assertStatus(response, 204, `cleanup ${command.constructor.name.replace(/Command$/, '')}`);
  }, errorCodes);
}

export function createInput(Bucket, region) {
  return region === 'us-east-1'
    ? { Bucket }
    : { Bucket, CreateBucketConfiguration: { LocationConstraint: region } };
}

export async function withBucket(client, run) {
  const Bucket = bucketName();
  const region = await client.config.region();
  let mayExist = false;
  let retainForUploads = false;

  return withCleanup(async () => {
    // A transport or server error can happen after the bucket was created.
    mayExist = true;
    let response;
    try {
      response = await client.send(new CreateBucketCommand(createInput(Bucket, region)));
    } catch (error) {
      // A rejected creation, especially a name collision, must not delete another bucket.
      if (creationRejected(error)) {
        mayExist = false;
        if (error.$metadata?.attempts > 1) {
          throw new Error(`CreateBucket failed after retries for ${Bucket}; inspect for a leftover bucket: ${message(error)}`, { cause: error });
        }
      }
      throw error;
    }
    return run({ Bucket, region, response, markDeleted: () => { mayExist = false; },
      retainForUploads: () => { retainForUploads = true; } });
  }, async () => {
    if (mayExist) {
      if (retainForUploads) throw new Error(`bucket ${Bucket} retained because multipart uploads may remain; inspect and remove manually`);
      await cleanupDelete(client, new DeleteBucketCommand({ Bucket }));
      // A broken endpoint can acknowledge deletion without removing the bucket.
      await assertMissing(() => client.send(new HeadBucketCommand({ Bucket })), 'HeadBucket after cleanup');
    }
  }, `bucket ${Bucket}`);
}

export function assertStatus(response, expected, operation) {
  assert.equal(response.$metadata?.httpStatusCode, expected, `${operation} HTTP status`);
}

export async function assertMissing(action, operation, errorCode) {
  await assert.rejects(action, error => {
    assert.equal(status(error), 404, `${operation} should return HTTP 404`);
    if (errorCode) assert.equal(error.name, errorCode, `${operation} error code`);
    return true;
  }, `${operation} should reject a missing bucket`);
}
