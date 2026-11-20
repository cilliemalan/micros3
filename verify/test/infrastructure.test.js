import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ListBucketsCommand } from '@aws-sdk/client-s3';
import { runTests } from '../test-runner.js';
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

  assert.deepEqual(await runTests(suites, context, output), { passed: 2, failed: 2 });
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
