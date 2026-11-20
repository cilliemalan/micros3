import assert from 'node:assert/strict';
import { ListObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { assertStatus, withBucket } from './resources.js';
import { withObjects } from './listing.js';
import { assertXmlDocument, captureRawBody, compareKeys, decodeUrlValue, rawBody } from './encoding.js';

// Keys that need escaping in XML or in a URL, multibyte keys whose UTF-8 order
// differs from their UTF-16 order, and (under `ctl/`) control characters that
// XML 1.0 cannot represent at all, so they are only listed with
// `EncodingType=url`. AWS recommends URL encoding for such keys.
export const textKeys = [
  'enc/plain.txt',
  'enc/a b+c%d&e=f?g#h;i.txt',
  `enc/xml <a href="x">'y'</a> &amp; ]]>.txt`,
  'enc/sub dir/inner.txt',
  'enc/日本語/ü.txt',
  'enc/Ａ.txt',
  'enc/\u{1f600}.txt',
  'enc/trailing space ',
];
export const controlKeys = [
  'ctl/tab\there.txt',
  'ctl/nl\nhere.txt',
  'ctl/cr\rhere.txt',
  'ctl/soh\u0001here.txt',
  'ctl/del\u007fhere.txt',
];
const uploads = [...textKeys, ...controlKeys].map((Key, i) => ({ Key, Body: `object ${i}` }));

// The expected listing: object keys and rolled-up prefixes in UTF-8 order,
// strictly after `after` (a key or prefix previously returned).
export function expectedEntries(keys, { Prefix = '', Delimiter, after } = {}) {
  const entries = [];
  for (const key of [...keys].sort(compareKeys)) {
    if (!key.startsWith(Prefix)) continue;
    const at = Delimiter ? key.indexOf(Delimiter, Prefix.length) : -1;
    const entry = at === -1 ? { key } : { prefix: key.slice(0, at + Delimiter.length) };
    if (after !== undefined && compareKeys(entry.key ?? entry.prefix, after) <= 0) continue;
    if (entry.prefix !== undefined && entries.at(-1)?.prefix === entry.prefix) continue;
    entries.push(entry);
  }
  return entries;
}

async function verifyEncodedListing(client, v2) {
  const Command = v2 ? ListObjectsV2Command : ListObjectsCommand;
  const name = v2 ? 'ListObjectsV2' : 'ListObjects';
  const startField = v2 ? 'StartAfter' : 'Marker';

  await withBucket(client, async ({ Bucket }) => {
    await withObjects(client, Bucket, async expected => {
      const keys = [...expected.keys()];

      // Check one page against the expected entries and return the decoded
      // continuation (V1) or the opaque token (V2) for a truncated page.
      const page = async (input, entries, truncated = false) => {
        const label = `${name} ${JSON.stringify(input)}`;
        const encoded = input.EncodingType === 'url';
        const value = (raw, field) => encoded ? decodeUrlValue(raw, `${label} ${field}`) : raw;
        const command = captureRawBody(new Command({ Bucket, ...input }));
        const result = await client.send(command);
        assertStatus(result, 200, label);
        assertXmlDocument(rawBody(command), label);
        assert.equal(result.Name, Bucket, `${label} bucket name`);
        assert.equal(result.IsTruncated, truncated, `${label} IsTruncated`);
        if (encoded) assert.equal(result.EncodingType, 'url', `${label} EncodingType`);
        for (const field of ['Prefix', 'Delimiter', startField]) {
          if (input[field] !== undefined) assert.equal(value(result[field], field), input[field], `${label} ${field}`);
        }
        if (input.MaxKeys !== undefined) assert.equal(result.MaxKeys, input.MaxKeys, `${label} MaxKeys`);
        // Continuation tokens are opaque and are not URL-encoded.
        if (input.ContinuationToken !== undefined) {
          assert.equal(result.ContinuationToken, input.ContinuationToken, `${label} ContinuationToken`);
        }
        const contents = result.Contents ?? [];
        const listedKeys = contents.map(item => value(item.Key, 'Key'));
        const listedPrefixes = (result.CommonPrefixes ?? []).map(item => value(item.Prefix, 'CommonPrefixes Prefix'));
        assert.deepEqual(listedKeys, entries.filter(e => e.key !== undefined).map(e => e.key), `${label} object keys`);
        assert.deepEqual(listedPrefixes, entries.filter(e => e.prefix !== undefined).map(e => e.prefix), `${label} common prefixes`);
        contents.forEach((item, i) => {
          const object = expected.get(listedKeys[i]);
          assert.equal(item.Size, object.Size, `${label} size for ${JSON.stringify(listedKeys[i])}`);
          assert.equal(item.ETag, object.ETag, `${label} ETag for ${JSON.stringify(listedKeys[i])}`);
        });
        if (v2) assert.equal(result.KeyCount, entries.length, `${label} KeyCount`);
        if (!truncated) {
          if (v2) assert.ok(!result.NextContinuationToken, `${label} continuation on final page`);
          return undefined;
        }
        if (v2) return result.NextContinuationToken;
        const last = entries.at(-1);
        // V1 returns NextMarker (encoded like a key) only with a delimiter;
        // otherwise the last key is the marker.
        if (result.NextMarker === undefined) {
          assert.ok(!input.Delimiter, `${label} NextMarker for a truncated delimited page`);
          return last.key;
        }
        const next = value(result.NextMarker, 'NextMarker');
        assert.equal(next, last.key ?? last.prefix, `${label} NextMarker`);
        return next;
      };

      // Follow every page of a listing, sending decoded markers back.
      const pages = async (input, MaxKeys) => {
        const entries = expectedEntries(keys, input);
        const seen = new Set();
        let token;
        for (let start = 0; start === 0 || start < entries.length; start += MaxKeys) {
          const chunk = entries.slice(start, start + MaxKeys);
          const truncated = start + MaxKeys < entries.length;
          const request = { ...input, MaxKeys, ...(token !== undefined && { [v2 ? 'ContinuationToken' : 'Marker']: token }) };
          token = await page(request, chunk, truncated);
          if (truncated) {
            assert.ok(typeof token === 'string' && token.length > 0, `${name} continuation for a truncated page`);
            assert.ok(!seen.has(token), `${name} repeated continuation`);
            seen.add(token);
          }
        }
      };

      const url = { EncodingType: 'url' };
      // Encoded listings, including control characters and every response field.
      await page(url, expectedEntries(keys));
      await pages(url, 3);
      await page({ ...url, Prefix: 'ctl/' }, expectedEntries(keys, { Prefix: 'ctl/' }));
      await page({ ...url, Prefix: 'ctl/soh\u0001' }, expectedEntries(keys, { Prefix: 'ctl/soh\u0001' }));
      await page({ ...url, Prefix: 'enc/日本語/' }, expectedEntries(keys, { Prefix: 'enc/日本語/' }));
      await page({ ...url, Prefix: 'enc/', Delimiter: '/' }, expectedEntries(keys, { Prefix: 'enc/', Delimiter: '/' }));
      await page({ ...url, Prefix: 'enc/', Delimiter: ' ' }, expectedEntries(keys, { Prefix: 'enc/', Delimiter: ' ' }));
      await pages({ ...url, Prefix: 'enc/', Delimiter: ' ' }, 1);
      await pages({ ...url, Delimiter: '\n' }, 2);
      for (const after of ['enc/Ａ.txt', 'ctl/nl\nhere.txt', 'enc/a b+c%d&e=f?g#h;i.txt']) {
        await page({ ...url, [startField]: after }, expectedEntries(keys, { after }));
      }

      // Unencoded listings of keys that XML can represent must be escaped
      // correctly and preserve whitespace.
      await page({ Prefix: 'enc/' }, expectedEntries(keys, { Prefix: 'enc/' }));
      await pages({ Prefix: 'enc/' }, 2);
      await pages({ Prefix: 'enc/', Delimiter: ' ' }, 1);
      await page({ Prefix: 'enc/', [startField]: 'enc/Ａ.txt' }, expectedEntries(keys, { Prefix: 'enc/', after: 'enc/Ａ.txt' }));
    }, uploads);
  });
}

export default [
  { name: 'ListObjects URL encoding and special keys', run: ({ client }) => verifyEncodedListing(client, false) },
  { name: 'ListObjectsV2 URL encoding and special keys', run: ({ client }) => verifyEncodedListing(client, true) },
];
