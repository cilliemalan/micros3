import assert from 'node:assert/strict';

// Helpers for listings requested with `EncodingType=url` and for inspecting
// the raw XML a listing was parsed from.

// S3 orders keys by their UTF-8 bytes. JavaScript compares UTF-16 code units,
// which differs for characters outside the Basic Multilingual Plane.
export function compareKeys(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// Neither S3 nor the SDK documents exactly which safe characters are left
// unescaped, and S3 encodes a space as `+` (as form encoding does), so accept
// any encoding that a form decoder maps back to the original value. A literal
// `+` must therefore be escaped. The encoded value itself must be printable
// ASCII, which is the purpose of the encoding.
export function decodeUrlValue(value, field) {
  assert.equal(typeof value, 'string', `${field} should be a string`);
  assert.match(value, /^[\x21-\x7e]*$/, `${field} should be URL-encoded printable ASCII, got ${JSON.stringify(value)}`);
  assert.ok(!/%(?![0-9A-Fa-f]{2})/.test(value), `${field} has a malformed percent escape: ${JSON.stringify(value)}`);
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    assert.fail(`${field} is not valid URL-encoded UTF-8: ${JSON.stringify(value)}`);
  }
}

export function assertUrlEncoded(value, expected, field) {
  assert.equal(decodeUrlValue(value, field), expected, `${field} should decode to ${JSON.stringify(expected)}`);
}

const rawBodies = new WeakMap();

// Records the raw HTTP response body of a command before the SDK parses it.
// The body is buffered and handed on unchanged. Clients that do not use the
// SDK middleware stack (such as test fakes) record nothing.
export function captureRawBody(command) {
  command.middlewareStack?.addRelativeTo(next => async args => {
    const result = await next(args);
    const body = result.response?.body;
    if (body && typeof body[Symbol.asyncIterator] === 'function') {
      const chunks = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      const buffer = Buffer.concat(chunks);
      rawBodies.set(command, buffer);
      result.response.body = buffer;
    } else if (body instanceof Uint8Array) {
      rawBodies.set(command, Buffer.from(body));
    }
    return result;
  }, {
    relation: 'after',
    toMiddleware: 'deserializerMiddleware',
    name: 'micros3VerifyRawBody',
    override: true,
  });
  return command;
}

export function rawBody(command) {
  return rawBodies.get(command);
}

// The SDK's XML parser tolerates characters that XML 1.0 forbids, so check the
// raw document: it must be valid UTF-8 and contain no forbidden characters,
// whether literal or as character references.
export function assertXmlDocument(body, operation) {
  assert.ok(Buffer.isBuffer(body), `${operation} raw response body was not captured`);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    assert.fail(`${operation} response is not valid UTF-8`);
  }
  const literal = text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  assert.ok(!literal, `${operation} response contains a character XML 1.0 forbids: ${JSON.stringify(literal?.[0])} at offset ${literal?.index}`);
  for (const [reference, hex, decimal] of text.matchAll(/&#(?:x([0-9A-Fa-f]+)|([0-9]+));/g)) {
    const code = hex === undefined ? Number(decimal) : parseInt(hex, 16);
    const allowed = code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff)
      || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
    assert.ok(allowed, `${operation} response references a character XML 1.0 forbids: ${reference}`);
  }
  return text;
}
