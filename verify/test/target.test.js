import assert from 'node:assert/strict';
import test from 'node:test';
import { TargetError, describeTarget, resolveTarget } from '../target.js';

test('target requires an endpoint or an explicit AWS opt-in', () => {
  assert.throws(() => resolveTarget({}, {}), TargetError);
  assert.throws(() => resolveTarget({}, { AWS_ENDPOINT_URL: '  ', AWS_REGION: 'us-east-1' }),
    /No S3 endpoint configured.*--aws/);
  assert.deepEqual(resolveTarget({ aws: true }, { AWS_REGION: 'eu-west-1' }), {
    endpoint: undefined,
    source: '--aws',
    aws: true,
    region: 'eu-west-1',
    regionSource: 'AWS_REGION',
  });
});

test('target endpoint precedence is command line, then S3-specific, then generic variable', () => {
  const env = {
    AWS_ENDPOINT_URL_S3: 'http://s3-specific:1',
    AWS_ENDPOINT_URL: 'http://generic:2',
  };
  assert.equal(resolveTarget({ endpoint: 'http://cli:3' }, env).endpoint, 'http://cli:3');
  assert.equal(resolveTarget({ endpoint: 'http://cli:3' }, env).source, '--endpoint');
  assert.equal(resolveTarget({}, env).endpoint, 'http://s3-specific:1');
  assert.equal(resolveTarget({}, env).source, 'AWS_ENDPOINT_URL_S3');
  assert.equal(resolveTarget({}, { ...env, AWS_ENDPOINT_URL_S3: '' }).endpoint, 'http://generic:2');
  assert.equal(resolveTarget({}, { AWS_ENDPOINT_URL: 'http://generic:2' }).source, 'AWS_ENDPOINT_URL');
});

test('target region prefers AWS_REGION over AWS_DEFAULT_REGION', () => {
  const endpoint = { AWS_ENDPOINT_URL: 'http://localhost:1' };
  assert.equal(resolveTarget({}, { ...endpoint, AWS_REGION: 'a', AWS_DEFAULT_REGION: 'b' }).region, 'a');
  const fallback = resolveTarget({}, { ...endpoint, AWS_REGION: '', AWS_DEFAULT_REGION: 'b' });
  assert.equal(fallback.region, 'b');
  assert.equal(fallback.regionSource, 'AWS_DEFAULT_REGION');
  const none = resolveTarget({}, endpoint);
  assert.equal(none.region, undefined);
  assert.equal(none.regionSource, undefined);
});

test('target rejects ambiguous and invalid endpoints', () => {
  assert.throws(() => resolveTarget({ aws: true, endpoint: 'http://cli:1' }, {}),
    /--aws .* --endpoint/);
  assert.throws(() => resolveTarget({ aws: true }, { AWS_ENDPOINT_URL: 'http://env:1' }),
    /--aws .* AWS_ENDPOINT_URL/);
  assert.throws(() => resolveTarget({ endpoint: '' }, { AWS_ENDPOINT_URL: 'http://env:1' }),
    /--endpoint requires a URL/);
  assert.throws(() => resolveTarget({}, { AWS_ENDPOINT_URL: 'localhost:4566' }),
    /must use http or https/);
  assert.throws(() => resolveTarget({}, { AWS_ENDPOINT_URL: 'not a url' }),
    /Invalid endpoint from AWS_ENDPOINT_URL/);
});

test('target description names the endpoint, its source and the region', () => {
  const custom = resolveTarget({}, { AWS_ENDPOINT_URL: 'http://localhost:4566' });
  assert.equal(describeTarget(custom, 'us-east-1'),
    'Target: http://localhost:4566 (from AWS_ENDPOINT_URL), region us-east-1');
  const aws = resolveTarget({ aws: true }, {});
  assert.match(describeTarget(aws, undefined),
    /^Target: default AWS S3 endpoint \(opted in with --aws; .*charges\), region unresolved$/);
});
