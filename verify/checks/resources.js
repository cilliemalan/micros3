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

const rawStatuses = new WeakMap();

// S3 can report a failure in the body of an HTTP 200 response (notably
// CompleteMultipartUpload and CopyObject). The SDK's throw200Exceptions
// middleware then rewrites the response status to 503 in place, so record the
// status received from the wire before that happens. The recorder sits inside
// that middleware and keeps the last attempt's status when the SDK retries.
export function recordRawStatus(command) {
  command.middlewareStack.addRelativeTo(next => async args => {
    const result = await next(args);
    rawStatuses.set(command, result.response?.statusCode);
    return result;
  }, {
    relation: 'after',
    toMiddleware: 'throw200ExceptionsMiddleware',
    name: 'micros3VerifyRawStatus',
    override: true,
  });
  return command;
}

export function embeddedError(command, error) {
  const raw = rawStatuses.get(command);
  return raw >= 200 && raw < 300 && status(error) === 503;
}

// Expect an S3 error with the given code and HTTP status, also accepting the
// same code embedded in a 200 response. An ordinary 503 does not qualify.
export async function assertS3Error(client, command, expectedStatus, code, operation) {
  recordRawStatus(command);
  await assert.rejects(() => client.send(command), error => {
    if (!embeddedError(command, error)) {
      assert.equal(status(error), expectedStatus, `${operation} should return HTTP ${expectedStatus}`);
    }
    assert.equal(error.name, code, `${operation} error code`);
    return true;
  }, `${operation} should reject with ${code}`);
}
