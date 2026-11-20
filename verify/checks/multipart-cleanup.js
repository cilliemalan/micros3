import assert from 'node:assert/strict';
import { AbortMultipartUploadCommand, DeleteObjectCommand, HeadBucketCommand, ListMultipartUploadsCommand } from '@aws-sdk/client-s3';
import { assertStatus, cleanupDelete, message, status, withCleanup } from './resources.js';

// Enumerate all pages before aborting, so deletion cannot invalidate markers.
async function listUploads(client, Bucket, uploads, failures) {
  try {
    let markers = {};
    const seen = new Set();
    for (let page = 0; ; page++) {
      if (page >= 1000) throw new Error('upload listing exceeded 1000 pages');
      const result = await client.send(new ListMultipartUploadsCommand({ Bucket, ...markers }));
      try {
        assertStatus(result, 200, 'cleanup ListMultipartUploads');
      } catch (error) {
        // A malformed success response may still contain useful upload IDs.
        failures.push(new Error(`listing uploads: ${message(error)}`, { cause: error }));
      }
      if (result.Uploads !== undefined && !Array.isArray(result.Uploads)) {
        failures.push(new Error(`listing uploads: cleanup uploads array invalid on page ${page + 1}`));
      }
      for (const [index, upload] of (Array.isArray(result.Uploads) ? result.Uploads : []).entries()) {
        if (typeof upload?.Key !== 'string' || !upload.Key.length || typeof upload.UploadId !== 'string' || !upload.UploadId.length) {
          failures.push(new Error(`listing uploads: cleanup upload key and ID missing on page ${page + 1}, entry ${index + 1}`));
          continue;
        }
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
    if (error?.name === 'NoSuchBucket' && status(error) === 404) {
      // Do not mistake a broken listing for proof that uploads are gone.
      try {
        await client.send(new HeadBucketCommand({ Bucket }));
        failures.push(new Error('listing uploads: NoSuchBucket for an existing bucket'));
      } catch (headError) {
        if (status(headError) !== 404) failures.push(new Error(`listing uploads: NoSuchBucket; cannot verify bucket: ${message(headError)}`, { cause: headError }));
      }
    } else {
      failures.push(new Error(`listing uploads: ${message(error)}`, { cause: error }));
    }
  }
}

// Creation responses can be lost or retried, leaving IDs we never received.
async function cleanUploads(client, Bucket, known) {
  const uploads = new Map(known.map(({ Key, UploadId }) => [JSON.stringify([Key, UploadId]), { Key, UploadId }]));
  const failures = [];
  await listUploads(client, Bucket, uploads, failures);
  for (const { Key, UploadId } of uploads.values()) {
    try {
      await cleanupDelete(client, new AbortMultipartUploadCommand({ Bucket, Key, UploadId }), ['NoSuchBucket', 'NoSuchUpload']);
    } catch (error) {
      failures.push(new Error(`abort ${Bucket}/${Key} upload ${UploadId}: ${message(error)}`, { cause: error }));
    }
  }
  if (!failures.length && uploads.size) {
    const remaining = new Map();
    await listUploads(client, Bucket, remaining, failures);
    for (const { Key, UploadId } of remaining.values()) {
      failures.push(new Error(`upload ${Bucket}/${Key} upload ${UploadId} remains after cleanup`));
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map(message).join('; '));
}

export async function withUploadCleanup(client, Bucket, keys, retainForUploads, run) {
  const known = [];
  await withCleanup(() => run(known), async () => {
    const failures = [];
    try { await cleanUploads(client, Bucket, known); } catch (error) {
      // Deleting a general-purpose bucket can strand in-progress uploads.
      retainForUploads();
      failures.push(error);
    }
    for (const Key of keys) {
      try {
        await cleanupDelete(client, new DeleteObjectCommand({ Bucket, Key }), ['NoSuchBucket', 'NoSuchKey']);
      } catch (error) { failures.push(new Error(`delete ${Bucket}/${Key}: ${message(error)}`, { cause: error })); }
    }
    if (failures.length) throw new AggregateError(failures, failures.map(message).join('; '));
  }, `uploads and objects in bucket ${Bucket}`);
}
