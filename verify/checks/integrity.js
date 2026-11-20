import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { assertMissing, assertStatus, cleanupDelete, message, status, withBucket, withCleanup } from './resources.js';

// Expected values are calculated here, independently of the service, so a
// consistently wrong ETag or checksum cannot pass by comparison with itself.
// The ETag of a single-part, unencrypted or SSE-S3 object (including a copy of
// one) is the quoted hex MD5 of its content. This does not hold for multipart,
// SSE-KMS or SSE-C objects, which are not checked here. See
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_Object.html
export const md5Hex = body => createHash('md5').update(body).digest('hex');
export const md5Base64 = body => createHash('md5').update(body).digest('base64');
export const sha256Base64 = body => createHash('sha256').update(body).digest('base64');
export const etagOf = body => `"${md5Hex(body)}"`;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

// CRC-32 (ISO-HDLC), as used by x-amz-checksum-crc32: big-endian, base64.
export function crc32Base64(body) {
  let crc = 0xffffffff;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const out = Buffer.alloc(4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return out.toString('base64');
}

// CopySource is a URL-encoded path, not an ordinary object key.
const copySource = (bucket, key) => `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

async function cleanObjects(client, Bucket, keys) {
  const failures = [];
  for (const Key of keys) {
    try {
      await cleanupDelete(client, new DeleteObjectCommand({ Bucket, Key }), ['NoSuchBucket', 'NoSuchKey']);
    } catch (error) {
      failures.push(new Error(`${Bucket}/${Key}: ${message(error)}`, { cause: error }));
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map(message).join('; '));
}

function objectHelpers(client, Bucket) {
  const put = async (Key, Body, fields, label) => {
    const response = await client.send(new PutObjectCommand({ Bucket, Key, Body, ...fields }));
    assertStatus(response, 200, label);
    assert.equal(response.ETag, etagOf(Body), `${label} ETag must be the quoted MD5 of the content`);
    return response;
  };
  // Confirm the stored content and that GET and HEAD report the content's MD5.
  const stored = async (Key, Body, label) => {
    const got = await client.send(new GetObjectCommand({ Bucket, Key }));
    assertStatus(got, 200, `GetObject ${label}`);
    assert.deepEqual(Buffer.from(await got.Body.transformToByteArray()), Body, `GetObject ${label} content`);
    assert.equal(got.ETag, etagOf(Body), `GetObject ${label} ETag must be the quoted MD5 of the content`);
    const head = await client.send(new HeadObjectCommand({ Bucket, Key }));
    assertStatus(head, 200, `HeadObject ${label}`);
    assert.equal(head.ContentLength, Body.length, `HeadObject ${label} ContentLength`);
    assert.equal(head.ETag, etagOf(Body), `HeadObject ${label} ETag must be the quoted MD5 of the content`);
    return head;
  };
  // A rejected upload must neither create nor replace the object.
  const rejected = async (input, httpStatus, code, label) => {
    await assert.rejects(() => client.send(new PutObjectCommand({ Bucket, ...input })), error => {
      assert.equal(status(error), httpStatus, `${label} should return HTTP ${httpStatus}`);
      assert.equal(error.name, code, `${label} error code`);
      return true;
    }, `${label} should reject with ${code}`);
  };
  const absent = (Key, label) => assertMissing(() => client.send(new GetObjectCommand({ Bucket, Key })), `GetObject ${label}`, 'NoSuchKey');
  return { put, stored, rejected, absent };
}

async function verifyEtags(client) {
  await withBucket(client, async ({ Bucket: sourceBucket }) => {
    await withBucket(client, async ({ Bucket: destinationBucket }) => {
      const plain = 'plain/雪 +&%.bin';
      const encrypted = 'sse-s3.bin';
      const empty = 'empty';
      const sourceKeys = [plain, encrypted, empty, 'self-copy'];
      const destinationKeys = ['copy', 'copy-replaced', 'copy-empty', 'copy-encrypted'];
      await withCleanup(async () => {
        await withCleanup(async () => {
          const source = objectHelpers(client, sourceBucket);
          const destination = objectHelpers(client, destinationBucket);
          const body = Buffer.from([0, 1, 2, 127, 128, 200, 254, 255]);
          const secret = Buffer.from('server-side encrypted with SSE-S3');
          await source.put(plain, body, { ContentType: 'application/octet-stream' }, 'PutObject');
          await source.stored(plain, body, 'after PutObject');
          await source.put(empty, Buffer.alloc(0), {}, 'PutObject empty');
          await source.stored(empty, Buffer.alloc(0), 'empty');
          const sse = await source.put(encrypted, secret, { ServerSideEncryption: 'AES256' }, 'PutObject SSE-S3');
          assert.equal(sse.ServerSideEncryption, 'AES256', 'PutObject SSE-S3 ServerSideEncryption');
          const sseHead = await source.stored(encrypted, secret, 'SSE-S3');
          assert.equal(sseHead.ServerSideEncryption, 'AES256', 'HeadObject SSE-S3 ServerSideEncryption');
          // An overwrite must report the new content's digest, not the old one.
          const replacement = Buffer.from('replacement content');
          await source.put(plain, replacement, {}, 'PutObject overwrite');
          await source.stored(plain, replacement, 'after overwrite');

          const copy = async (Key, from, extra, expected, label) => {
            const response = await client.send(new CopyObjectCommand({ Bucket: destinationBucket, Key,
              CopySource: copySource(sourceBucket, from), ...extra }));
            assertStatus(response, 200, label);
            assert.equal(response.CopyObjectResult?.ETag, etagOf(expected), `${label} result ETag must be the quoted MD5 of the content`);
            await destination.stored(Key, expected, `after ${label}`);
            return response;
          };
          await copy('copy', plain, {}, replacement, 'CopyObject');
          await copy('copy-replaced', plain, { MetadataDirective: 'REPLACE', ContentType: 'text/plain' }, replacement, 'CopyObject with REPLACE');
          await copy('copy-empty', empty, {}, Buffer.alloc(0), 'CopyObject empty');
          const sseCopy = await copy('copy-encrypted', encrypted, { ServerSideEncryption: 'AES256' }, secret, 'CopyObject SSE-S3');
          assert.equal(sseCopy.ServerSideEncryption, 'AES256', 'CopyObject SSE-S3 ServerSideEncryption');
          // Same-bucket copy to a new key, then confirm the source is unaffected.
          const self = await client.send(new CopyObjectCommand({ Bucket: sourceBucket, Key: 'self-copy', CopySource: copySource(sourceBucket, plain) }));
          assertStatus(self, 200, 'CopyObject same bucket');
          assert.equal(self.CopyObjectResult?.ETag, etagOf(replacement), 'CopyObject same bucket result ETag must be the quoted MD5 of the content');
          await source.stored('self-copy', replacement, 'after CopyObject same bucket');
          await source.stored(plain, replacement, 'source after copies');
        }, () => cleanObjects(client, destinationBucket, destinationKeys), `objects in bucket ${destinationBucket}`);
      }, () => cleanObjects(client, sourceBucket, sourceKeys), `objects in bucket ${sourceBucket}`);
    });
  });
}

async function verifyContentMd5(client) {
  await withBucket(client, async ({ Bucket }) => {
    const keys = ['matching', 'mismatched', 'malformed', 'existing'];
    const [matching, mismatched, malformed, existing] = keys;
    await withCleanup(async () => {
      const { put, stored, rejected, absent } = objectHelpers(client, Bucket);
      const body = Buffer.from('content protected by Content-MD5');
      const other = Buffer.from('different content');
      await put(matching, body, { ContentMD5: md5Base64(body) }, 'PutObject matching Content-MD5');
      await stored(matching, body, 'matching Content-MD5');

      // A well-formed digest of other content is BadDigest; an invalid one is InvalidDigest.
      // See https://docs.aws.amazon.com/AmazonS3/latest/API/ErrorResponses.html
      await rejected({ Key: mismatched, Body: body, ContentMD5: md5Base64(other) }, 400, 'BadDigest', 'PutObject mismatched Content-MD5');
      await absent(mismatched, 'after mismatched Content-MD5');
      await rejected({ Key: malformed, Body: body, ContentMD5: 'bm90LWEtZGlnZXN0' }, 400, 'InvalidDigest', 'PutObject malformed Content-MD5');
      await absent(malformed, 'after malformed Content-MD5');

      await put(existing, other, {}, 'PutObject setup');
      await rejected({ Key: existing, Body: body, ContentMD5: md5Base64(other) }, 400, 'BadDigest', 'PutObject overwrite with mismatched Content-MD5');
      await stored(existing, other, 'after rejected overwrite');
    }, () => cleanObjects(client, Bucket, keys), `objects in bucket ${Bucket}`);
  });
}

async function verifyChecksums(client) {
  await withBucket(client, async ({ Bucket }) => {
    const keys = ['crc32', 'sha256', 'bad-crc32', 'bad-sha256', 'existing'];
    const [crc32, sha256, badCrc32, badSha256, existing] = keys;
    await withCleanup(async () => {
      const { put, stored, rejected, absent } = objectHelpers(client, Bucket);
      const body = Buffer.from([0, 1, 2, 3, 127, 128, 255, ...Buffer.from(' checksum content')]);
      const other = Buffer.from('different content');

      // Let the SDK calculate the checksum, then compare it with an independent calculation.
      const crc = await put(crc32, body, { ChecksumAlgorithm: 'CRC32' }, 'PutObject CRC32');
      assert.equal(crc.ChecksumCRC32, crc32Base64(body), 'PutObject CRC32 ChecksumCRC32');
      await stored(crc32, body, 'CRC32');
      const sha = await put(sha256, body, { ChecksumAlgorithm: 'SHA256', ChecksumSHA256: sha256Base64(body) }, 'PutObject SHA256');
      assert.equal(sha.ChecksumSHA256, sha256Base64(body), 'PutObject SHA256 ChecksumSHA256');
      await stored(sha256, body, 'SHA256');

      // The SDK sends a supplied checksum unchanged. A mismatch is BadDigest.
      // See https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity.html
      await rejected({ Key: badCrc32, Body: body, ChecksumAlgorithm: 'CRC32', ChecksumCRC32: crc32Base64(other) }, 400, 'BadDigest', 'PutObject mismatched CRC32');
      await absent(badCrc32, 'after mismatched CRC32');
      await rejected({ Key: badSha256, Body: body, ChecksumAlgorithm: 'SHA256', ChecksumSHA256: sha256Base64(other) }, 400, 'BadDigest', 'PutObject mismatched SHA256');
      await absent(badSha256, 'after mismatched SHA256');

      await put(existing, other, {}, 'PutObject setup');
      await rejected({ Key: existing, Body: body, ChecksumAlgorithm: 'SHA256', ChecksumSHA256: sha256Base64(other) }, 400, 'BadDigest', 'PutObject overwrite with mismatched SHA256');
      await stored(existing, other, 'after rejected overwrite');
    }, () => cleanObjects(client, Bucket, keys), `objects in bucket ${Bucket}`);
  });
}

export default [
  { name: 'Object ETags are MD5 digests', run: ({ client }) => verifyEtags(client) },
  { name: 'PutObject validates Content-MD5', run: ({ client }) => verifyContentMd5(client) },
  { name: 'PutObject validates checksums', run: ({ client }) => verifyChecksums(client) },
];
