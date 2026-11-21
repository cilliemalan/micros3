import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ListBucketsCommand } from '@aws-sdk/client-s3';
import { PrerequisiteError, ScenarioError, runTests, scenario } from '../test-runner.js';
import { runVerification } from '../verification.js';

const verifierDirectory = fileURLToPath(new URL('../', import.meta.url));

function verifierEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.toUpperCase().startsWith('AWS_')) {
      delete env[name];
    }
  }
  return {
    ...env,
    AWS_ACCESS_KEY_ID: 'test-key',
    AWS_SECRET_ACCESS_KEY: 'test-secret',
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_MAX_ATTEMPTS: '1',
    ...overrides,
  };
}

function runVerifier(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['index.js', ...args], {
      cwd: verifierDirectory,
      env,
      timeout: 15_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function startServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('runner awaits checks in order, reports failures, and continues', async () => {
  const events = [];
  const context = { client: {} };
  const lines = [];
  const output = {
    log: line => lines.push(line),
    error: line => lines.push(line),
  };
  const suites = [
    { name: 'First', tests: [
      { name: 'async pass', async run(received) {
        assert.equal(received, context);
        events.push('start');
        await new Promise(resolve => setImmediate(resolve));
        events.push('finish');
      } },
      { name: 'sync fail', run() { events.push('sync'); throw new Error('broken'); } },
      { name: 'async fail', async run() { events.push('async'); throw 'rejected'; } },
    ] },
    { name: 'Second', tests: [
      { name: 'pass after failures', run() { events.push('last'); } },
    ] },
  ];

  assert.deepEqual(await runTests(suites, context, output), { passed: 2, failed: 2, blocked: 0, notRun: 0 });
  assert.deepEqual(events, ['start', 'finish', 'sync', 'async', 'last']);
  assert.deepEqual(lines, [
    '\nFirst:',
    '  PASS async pass',
    '  FAIL sync fail: broken',
    '  FAIL async fail: rejected',
    '\nSecond:',
    '  PASS pass after failures',
    '\nResults: 2 passed, 2 failed',
  ]);
});

test('a failing scenario names its case, and a blocked scenario still blocks its check', async () => {
  const lines = [];
  const order = [];
  const suites = [{ name: 'Scenarios', tests: [
    { name: 'named failure', async run() {
      assert.equal(await scenario('first case', () => { order.push('first'); return 1; }), 1);
      await scenario('second case', async () => { order.push('second'); throw new Error('broken'); });
      order.push('not reached');
    } },
    { name: 'nested', run: () => scenario('outer', () => scenario('inner', () => { throw 'rejected'; })) },
    { name: 'blocked', run: () => scenario('listing', () => { throw new PrerequisiteError('ListParts', new Error('NotImplemented')); }) },
    { name: 'blocked with cleanup failure', async run() {
      const failure = await scenario('listing', () => { throw new PrerequisiteError('ListParts', new Error('NotImplemented')); }).catch(e => e);
      assert.ok(failure instanceof ScenarioError);
      assert.equal(failure.scenario, 'listing');
      throw new AggregateError([failure, new Error('cleanup')], `${failure.message}; cleanup failed`);
    } },
  ] }];
  assert.deepEqual(await runTests(suites, {}, { log: line => lines.push(line) }), { passed: 0, failed: 2, blocked: 2, notRun: 0 });
  assert.deepEqual(order, ['first', 'second']);
  assert.deepEqual(lines, [
    '\nScenarios:',
    '  FAIL named failure: second case: broken',
    '  FAIL nested: outer: inner: rejected',
    '  BLOCKED blocked: listing: prerequisite ListParts failed: NotImplemented',
    '  BLOCKED blocked with cleanup failure: listing: prerequisite ListParts failed: NotImplemented; cleanup failed',
    '\nResults: 0 passed, 2 failed, 2 blocked',
  ]);
});

test('verification checks the connection, shares the client, and disposes it', async () => {
  const events = [];
  const client = {
    async send(command) {
      assert.ok(command instanceof ListBucketsCommand);
      events.push('connected');
    },
    destroy() { events.push('destroyed'); },
  };
  const output = { log() {}, error() {} };
  const suites = [{ name: 'Example', tests: [{ name: 'pass', run(context) {
    assert.equal(context.client, client);
    events.push('test');
  } }] }];

  assert.equal(await runVerification(client, suites, output), true);
  assert.deepEqual(events, ['connected', 'test', 'destroyed']);
});

test('verification fails on a test failure and still disposes the client', async () => {
  let destroyed = false;
  const client = {
    async send() {},
    destroy() { destroyed = true; },
  };
  const lines = [];
  const output = { log: line => lines.push(line), error() {} };
  const suites = [{ name: 'Example', tests: [{ name: 'fail', run() {
    throw new Error('test failure');
  } }] }];

  assert.equal(await runVerification(client, suites, output), false);
  assert.equal(destroyed, true);
  assert.ok(lines.includes('  FAIL fail: test failure'));
});

test('verification stops on connection failure and disposes the client', async () => {
  const events = [];
  const client = {
    async send() { events.push('connect'); throw new Error('unavailable'); },
    destroy() { events.push('destroyed'); },
  };
  const errors = [];
  const output = { log() {}, error: line => errors.push(line) };
  const suites = [{ name: 'Example', tests: [{ name: 'never', run() {
    events.push('test');
  } }] }];

  assert.equal(await runVerification(client, suites, output), false);
  assert.deepEqual(events, ['connect', 'destroyed']);
  assert.deepEqual(errors, ['unavailable', 'Initial check failed']);
});

test('verification disposes the client if the runner unexpectedly throws', async () => {
  let destroyed = false;
  const client = {
    async send() {},
    destroy() { destroyed = true; },
  };
  const output = { log() {}, error() {} };

  await assert.rejects(runVerification(client, [{ name: 'Invalid' }], output), TypeError);
  assert.equal(destroyed, true);
});

test('verifier loads an env file and stops if the connection check fails', async t => {
  const requests = [];
  const endpoint = await startServer(t, (request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(403, { 'Content-Type': 'application/xml' });
    response.end('<Error><Code>AccessDenied</Code><Message>Denied</Message></Error>');
  });
  const directory = await mkdtemp(join(tmpdir(), 'micros3-verify-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(directory, 'connection.env');
  await writeFile(envFile, `AWS_ENDPOINT_URL=${endpoint}\nAWS_DEFAULT_REGION=us-east-1\n`);

  const result = await runVerifier(['--env', envFile], verifierEnvironment());
  assert.equal(result.signal, null);
  assert.equal(result.code, 1);
  assert.deepEqual(requests.map(request => request.method), ['GET']);
  assert.match(requests[0].url, /^\/(?:\?|$)/);
  assert.match(result.stderr, /Initial check failed/);
  assert.doesNotMatch(result.stdout, /Bucket operations:|Results:|FAIL /);
});

test('verifier stops when the requested env file cannot be loaded', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'micros3-verify-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await runVerifier(['-e', join(directory, 'missing.env')], verifierEnvironment());
  assert.equal(result.signal, null);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Failed to load environment file/);
  assert.doesNotMatch(result.stdout, /Bucket operations:|Results:/);
});

async function startDeniedServer(t) {
  const requests = [];
  const endpoint = await startServer(t, (request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(403, { 'Content-Type': 'application/xml' });
    response.end('<Error><Code>AccessDenied</Code><Message>Denied</Message></Error>');
  });
  return { endpoint, requests };
}

async function tempDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'micros3-verify-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function assertRefused(result) {
  assert.equal(result.signal, null);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Refusing to run without an explicit target/);
  assert.doesNotMatch(result.stdout, /Target:|Bucket operations:|Results:/);
  assert.doesNotMatch(result.stderr, /Initial check failed/);
}

test('verifier refuses to use the default endpoint without an opt-in', async t => {
  // A shared-config endpoint_url is not shown to the user, so it must not
  // count as an explicit endpoint either.
  const { endpoint, requests } = await startDeniedServer(t);
  const directory = await tempDirectory(t);
  const configFile = join(directory, 'config');
  await writeFile(configFile, `[default]\nregion = us-east-1\nendpoint_url = ${endpoint}\n`);

  const result = await runVerifier([], verifierEnvironment({
    AWS_CONFIG_FILE: configFile,
    AWS_DEFAULT_REGION: 'us-east-1',
  }));
  assertRefused(result);
  assert.match(result.stderr, /No S3 endpoint configured.*--aws/);
  assert.deepEqual(requests, []);
});

test('verifier refuses an endpoint combined with the AWS opt-in', async t => {
  const { endpoint, requests } = await startDeniedServer(t);
  const result = await runVerifier(['--aws'], verifierEnvironment({
    AWS_ENDPOINT_URL: endpoint,
    AWS_DEFAULT_REGION: 'us-east-1',
  }));
  assertRefused(result);
  assert.match(result.stderr, /--aws .* AWS_ENDPOINT_URL/);
  assert.deepEqual(requests, []);
});

test('verifier refuses an invalid endpoint and unknown options', async () => {
  const invalid = await runVerifier([], verifierEnvironment({ AWS_ENDPOINT_URL: 'localhost:4566' }));
  assertRefused(invalid);
  assert.match(invalid.stderr, /must use http or https/);

  const unknown = await runVerifier(['--endpiont', 'http://127.0.0.1:1'], verifierEnvironment());
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown option '--endpiont'/);
  assert.doesNotMatch(unknown.stdout, /Target:|Results:/);
});

test('verifier shows the target before its first request', async t => {
  const { endpoint, requests } = await startDeniedServer(t);
  const result = await runVerifier([], verifierEnvironment({
    AWS_ENDPOINT_URL: endpoint,
    AWS_REGION: 'eu-west-1',
    AWS_DEFAULT_REGION: 'us-east-1',
  }));
  assert.equal(result.code, 1);
  assert.equal(result.stdout.split('\n')[0],
    `Target: ${endpoint} (from AWS_ENDPOINT_URL), region eu-west-1`);
  assert.equal(requests.length, 1);
  assert.match(result.stderr, /Initial check failed/);
});

test('verifier endpoint precedence: option, then S3 variable, then generic variable', async t => {
  const cli = await startDeniedServer(t);
  const specific = await startDeniedServer(t);
  const generic = await startDeniedServer(t);
  const env = verifierEnvironment({
    AWS_ENDPOINT_URL_S3: specific.endpoint,
    AWS_ENDPOINT_URL: generic.endpoint,
    AWS_DEFAULT_REGION: 'us-east-1',
  });

  const fromOption = await runVerifier(['--endpoint', cli.endpoint], env);
  assert.match(fromOption.stdout, new RegExp(`^Target: ${cli.endpoint} \\(from --endpoint\\)`));
  assert.deepEqual([cli, specific, generic].map(s => s.requests.length), [1, 0, 0]);

  const fromSpecific = await runVerifier([], env);
  assert.match(fromSpecific.stdout, /\(from AWS_ENDPOINT_URL_S3\)/);
  assert.deepEqual([cli, specific, generic].map(s => s.requests.length), [1, 1, 0]);

  const { AWS_ENDPOINT_URL_S3, ...genericOnly } = env;
  const fromGeneric = await runVerifier([], genericOnly);
  assert.match(fromGeneric.stdout, /\(from AWS_ENDPOINT_URL\)/);
  assert.deepEqual([cli, specific, generic].map(s => s.requests.length), [1, 1, 1]);
});

test('verifier environment variables take precedence over the env file', async t => {
  const fromProcess = await startDeniedServer(t);
  const fromFile = await startDeniedServer(t);
  const directory = await tempDirectory(t);
  const envFile = join(directory, 'target.env');
  await writeFile(envFile,
    `AWS_ENDPOINT_URL=${fromFile.endpoint}\nAWS_REGION=eu-west-1\nAWS_DEFAULT_REGION=eu-west-1\n`);

  const result = await runVerifier(['-e', envFile], verifierEnvironment({
    AWS_ENDPOINT_URL: fromProcess.endpoint,
    AWS_REGION: 'us-east-2',
  }));
  assert.equal(result.stdout.split('\n')[0],
    `Target: ${fromProcess.endpoint} (from AWS_ENDPOINT_URL), region us-east-2`);
  assert.equal(fromProcess.requests.length, 1);
  assert.equal(fromFile.requests.length, 0);

  const fileOnly = await runVerifier(['-e', envFile], verifierEnvironment());
  assert.equal(fileOnly.stdout.split('\n')[0],
    `Target: ${fromFile.endpoint} (from AWS_ENDPOINT_URL), region eu-west-1`);
  assert.equal(fromFile.requests.length, 1);
});

test('verifier validates and reports its timeouts before the first request', async t => {
  const { endpoint, requests } = await startDeniedServer(t);
  const env = verifierEnvironment({ AWS_ENDPOINT_URL: endpoint, AWS_DEFAULT_REGION: 'us-east-1' });

  const invalid = await runVerifier(['--run-timeout', '0'], env);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /--run-timeout must be a positive number of seconds/);
  assert.doesNotMatch(invalid.stdout, /Target:|Results:/);
  assert.equal(requests.length, 0);

  const result = await runVerifier(
    ['--request-timeout', '5', '--run-timeout', '60', '--cleanup-grace', '2.5'], env);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.split('\n')[1],
    'Timeouts: 5 s per request, 60 s per run, 2.5 s cleanup grace');
  assert.equal(requests.length, 1);
});

test('verifier times out a hung connection check', async t => {
  const endpoint = await startServer(t, () => {});
  const started = Date.now();
  const result = await runVerifier(['--endpoint', endpoint, '--request-timeout', '0.3'],
    verifierEnvironment({ AWS_DEFAULT_REGION: 'us-east-1' }));
  assert.equal(result.signal, null);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ListBuckets timed out after 300 ms\nInitial check failed/);
  assert.ok(Date.now() - started < 10_000);
});

test('verifier prints usage with --help and makes no request', async t => {
  const { endpoint, requests } = await startDeniedServer(t);
  const result = await runVerifier(['--help', '--endpoint', endpoint], verifierEnvironment());
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^Usage: node index\.js \[options\]/);
  assert.match(result.stdout, /--suite <name>.*\n.*auth, buckets, objects, listing, multipart, cors, encryption/);
  assert.equal(result.stderr, '');
  assert.equal(requests.length, 0);
});

test('verifier rejects an unknown suite before its first request', async t => {
  const { endpoint, requests } = await startDeniedServer(t);
  const result = await runVerifier(['--endpoint', endpoint, '--suite', 'nope'], verifierEnvironment());
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown suite "nope"; expected one of: auth, buckets,/);
  assert.doesNotMatch(result.stdout, /Target:|Results:/);
  assert.equal(requests.length, 0);
});

test('verifier runs only the selected suites', async t => {
  // ListBuckets succeeds with an empty list; every other request is denied,
  // so the selected suite's checks run and fail without touching the others.
  const endpoint = await startServer(t, (request, response) => {
    const listBuckets = request.method === 'GET' && new URL(request.url, 'http://x').pathname === '/';
    response.writeHead(listBuckets ? 200 : 403, { 'Content-Type': 'application/xml' });
    response.end(listBuckets
      ? '<ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>'
      : '<Error><Code>AccessDenied</Code><Message>Denied</Message></Error>');
  });
  const result = await runVerifier(['--endpoint', endpoint, '-s', 'encryption'],
    verifierEnvironment({ AWS_DEFAULT_REGION: 'us-east-1' }));
  assert.equal(result.code, 1);
  assert.equal(result.stdout.split('\n')[2], 'Suites: encryption', result.stderr);
  assert.match(result.stdout, /\nEncryption:\n/, result.stderr);
  assert.doesNotMatch(result.stdout, /Bucket operations:|Object operations:|Listing operations:|Multipart operations:|CORS operations:/);
});
