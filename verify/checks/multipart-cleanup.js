import assert from 'node:assert/strict';
import { AbortMultipartUploadCommand, DeleteObjectCommand, ListMultipartUploadsCommand } from '@aws-sdk/client-s3';
import { assertStatus, ignoreMissing, message, withCleanup } from './resources.js';

// A create response can be lost (or retried after success), leaving upload IDs we
// never received. Enumerate the entire isolated bucket before aborting anything.
async function cleanUploads(client, Bucket, known) {
  const uploads = new Map(known.map(({ Key, UploadId }) => [JSON.stringify([Key, UploadId]), { Key, UploadId }]));
  const failures = [];
  try {
    let markers = {};
    const seen = new Set();
    for (let page = 0; ; page++) {
      if (page >= 1000) throw new Error('upload listing exceeded 1000 pages');
      const result = await client.send(new ListMultipartUploadsCommand({ Bucket, ...markers }));
      assertStatus(result, 200, 'cleanup ListMultipartUploads');
      for (const upload of result.Uploads ?? []) {
        assert.ok(typeof upload.Key === 'string' && typeof upload.UploadId === 'string' && upload.UploadId.length, 'cleanup upload key and ID');
        uploads.set(JSON.stringify([upload.Key, upload.UploadId]), upload);
      }
      assert.equal(typeof result.IsTruncated, 'boolean', 'cleanup upload listing IsTruncated');
      if (!result.IsTruncated) break;
      const { NextKeyMarker, NextUploadIdMarker } = result;
      assert.ok(typeof NextKeyMarker === 'string' && NextKeyMarker.length && typeof NextUploadIdMarker === 'string' && NextUploadIdMarker.length, 'cleanup upload listing markers');
      const token = JSON.stringify([NextKeyMarker, NextUploadIdMarker]);
      assert.ok(!seen.has(token), 'cleanup upload listing repeated markers');
      seen.add(token);
      markers = { KeyMarker: NextKeyMarker, UploadIdMarker: NextUploadIdMarker };
    }
  } catch (error) {
    // A deleted bucket needs no cleanup; other listing failures can hide uploads.
    if (!(error.name === 'NoSuchBucket' && error.$metadata?.httpStatusCode === 404)) failures.push(new Error(`listing uploads: ${message(error)}`, { cause: error }));
  }
  for (const { Key, UploadId } of uploads.values()) {
    try {
      await ignoreMissing(() => client.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId })), ['NoSuchBucket', 'NoSuchUpload']);
    } catch (error) {
      failures.push(new Error(`abort ${Bucket}/${Key} upload ${UploadId}: ${message(error)}`, { cause: error }));
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map(message).join('; '));
}

export async function withUploadCleanup(client, Bucket, keys, run) {
  const known = [];
  await withCleanup(() => run(known), async () => {
    const failures = [];
    try { await cleanUploads(client, Bucket, known); } catch (error) { failures.push(error); }
    for (const Key of keys) {
      try {
        await ignoreMissing(() => client.send(new DeleteObjectCommand({ Bucket, Key })), ['NoSuchBucket', 'NoSuchKey']);
      } catch (error) { failures.push(new Error(`delete ${Bucket}/${Key}: ${message(error)}`, { cause: error })); }
    }
    if (failures.length) throw new AggregateError(failures, failures.map(message).join('; '));
  }, `uploads and objects in bucket ${Bucket}`);
}
