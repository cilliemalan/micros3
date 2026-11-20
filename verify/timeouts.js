// Bounded request and run timeouts with cleanup-aware cancellation.
//
// Every request is bounded by a per-request timeout, which covers SDK retries
// and reading a streamed response body. When the run timeout expires, requests
// made by checks are cancelled, but requests made while cleaning up continue
// (still bounded by the request timeout) until a further cleanup grace period
// expires. Cleanup code marks itself with `inCleanup`, so a check interrupted
// by the run timeout still removes, or reports and retains, its resources.
import { AsyncLocalStorage } from 'node:async_hooks';

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_CLEANUP_GRACE_MS = 2 * 60_000;

const cleanupScope = new AsyncLocalStorage();

export class VerifierTimeoutError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'VerifierTimeoutError';
  }
}

export function inCleanup(action) {
  return cleanupScope.run(true, action);
}

export function isCleaningUp() {
  return cleanupScope.getStore() === true;
}

function operationName(command) {
  return command?.constructor?.name?.replace(/Command$/, '') || 'request';
}

// Run-level cancellation: `signal` aborts at the run deadline and
// `cleanupSignal` aborts once the cleanup grace period has also passed.
export function createRunDeadline({ runTimeout = DEFAULT_RUN_TIMEOUT_MS,
  cleanupGrace = DEFAULT_CLEANUP_GRACE_MS } = {}) {
  const run = new AbortController();
  const cleanup = new AbortController();
  let cleanupTimer;
  const expire = reason => {
    if (run.signal.aborted) return;
    run.abort(reason);
    cleanupTimer = setTimeout(() => cleanup.abort(
      new VerifierTimeoutError(`cleanup grace period of ${cleanupGrace} ms after the run timeout expired`)), cleanupGrace);
    cleanupTimer.unref?.();
  };
  const runTimer = setTimeout(() => expire(
    new VerifierTimeoutError(`run timeout of ${runTimeout} ms reached`)), runTimeout);
  runTimer.unref?.();
  return {
    signal: run.signal,
    cleanupSignal: cleanup.signal,
    runTimeout,
    cleanupGrace,
    // Expires the run early; used by tests and signal handlers.
    expire: () => expire(new VerifierTimeoutError('run cancelled')),
    dispose() {
      clearTimeout(runTimer);
      clearTimeout(cleanupTimer);
    },
  };
}

const clientBounds = new WeakMap();

// Combines the per-request timeout, the run or cleanup deadline and a caller's
// signal. `describe()` explains which of them stopped the request.
function requestBounds({ requestTimeout, deadline }, operation, callerSignal) {
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), requestTimeout);
  timeout.unref?.();
  const cleaning = isCleaningUp();
  const run = deadline && (cleaning ? deadline.cleanupSignal : deadline.signal);
  const signal = AbortSignal.any([timer.signal, run, callerSignal].filter(Boolean));
  return {
    signal,
    clear: () => clearTimeout(timeout),
    stopped: () => timer.signal.aborted || Boolean(run?.aborted),
    describe: () => timer.signal.aborted
      ? `${operation} timed out after ${requestTimeout} ms`
      : `${operation} cancelled: ${cleaning ? 'cleanup grace period expired' : 'run timeout reached'}`,
  };
}

// Wraps client.send in place so every request is bounded. Requests outside
// cleanup also stop at the run deadline; cleanup requests stop at the end of
// the grace period. Timeout errors carry no HTTP status, so checks never treat
// them as proof that a resource is missing or that creation was rejected.
export function applyTimeouts(client, { requestTimeout = DEFAULT_REQUEST_TIMEOUT_MS, deadline } = {}) {
  clientBounds.set(client, { requestTimeout, deadline });
  const send = client.send.bind(client);
  client.send = async (command, options = {}, ...rest) => {
    const bounds = requestBounds({ requestTimeout, deadline }, operationName(command), options.abortSignal);
    const { signal: abortSignal, describe } = bounds;
    try {
      const response = await send(command, { ...options, abortSignal }, ...rest);
      // Keep the request bounded while a streamed body is consumed.
      const body = response?.Body;
      if (body && typeof body.destroy === 'function' && typeof body.once === 'function' && !body.readableEnded) {
        const onAbort = () => body.destroy(new VerifierTimeoutError(`${describe()} while reading the response body`));
        const done = () => {
          bounds.clear();
          abortSignal.removeEventListener('abort', onAbort);
        };
        if (abortSignal.aborted) onAbort();
        else abortSignal.addEventListener('abort', onAbort, { once: true });
        body.once('end', done);
        body.once('close', done);
        body.once('error', done);
      } else {
        bounds.clear();
      }
      return response;
    } catch (error) {
      bounds.clear();
      if (bounds.stopped()) throw new VerifierTimeoutError(describe(), { cause: error });
      throw error;
    }
  };
  return client;
}

// Bounds a request made outside the SDK (such as an unsigned CORS preflight)
// like one made through a client passed to applyTimeouts. `request(signal)`
// must finish reading the response before it resolves. Without applied
// timeouts the request is unbounded and receives no signal.
export async function boundedRequest(client, operation, request) {
  const limits = clientBounds.get(client);
  if (!limits) return request(undefined);
  const bounds = requestBounds(limits, operation);
  try {
    return await request(bounds.signal);
  } catch (error) {
    if (bounds.stopped()) throw new VerifierTimeoutError(bounds.describe(), { cause: error });
    throw error;
  } finally {
    bounds.clear();
  }
}

// Parses a command-line timeout in seconds into milliseconds.
export function parseTimeoutSeconds(value, option, fallbackMs) {
  if (value === undefined) return fallbackMs;
  const text = String(value).trim();
  const seconds = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : NaN;
  const ms = Math.round(seconds * 1000);
  if (!Number.isFinite(seconds) || ms < 1 || ms > 2 ** 31 - 1) {
    throw new RangeError(`${option} must be a positive number of seconds, got ${JSON.stringify(value)}`);
  }
  return ms;
}

// Resolves { requestTimeout, runTimeout, cleanupGrace } from parsed options.
export function resolveTimeouts(options = {}) {
  return {
    requestTimeout: parseTimeoutSeconds(options['request-timeout'], '--request-timeout', DEFAULT_REQUEST_TIMEOUT_MS),
    runTimeout: parseTimeoutSeconds(options['run-timeout'], '--run-timeout', DEFAULT_RUN_TIMEOUT_MS),
    cleanupGrace: parseTimeoutSeconds(options['cleanup-grace'], '--cleanup-grace', DEFAULT_CLEANUP_GRACE_MS),
  };
}
