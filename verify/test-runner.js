// Each test's run function receives the shared context and may be synchronous or async.
//
// When `deadline` is supplied (see timeouts.js), checks not yet started at the
// run timeout are reported as not run. A check in progress at the run timeout
// has its requests cancelled while its cleanup continues; if it has still not
// settled when the cleanup grace period ends, it is abandoned and reported as
// a failure whose resources may remain.
// A check that cannot exercise its operation because another operation it
// depends on failed is reported as blocked rather than as the operation failing.
export class PrerequisiteError extends Error {
  constructor(operation, cause) {
    super(`prerequisite ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'PrerequisiteError';
    this.operation = operation;
  }
}

// Cleanup failures are aggregated after the original failure (see withCleanup).
function blockedBy(error) {
  if (error instanceof PrerequisiteError) return error;
  if (error instanceof AggregateError && error.errors?.[0] instanceof PrerequisiteError) return error.errors[0];
  return undefined;
}

export async function runTests(suites, context, output = console, { deadline } = {}) {
  let passed = 0;
  let failed = 0;
  let notRun = 0;
  let blocked = 0;

  for (const suite of suites) {
    output.log(`\n${suite.name}:`);
    for (const test of suite.tests) {
      if (deadline?.signal.aborted) {
        output.log(`  NOT RUN ${test.name}: run timeout reached`);
        notRun++;
        continue;
      }
      try {
        await settleWithin(() => test.run(context), deadline);
        output.log(`  PASS ${test.name}`);
        passed++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (blockedBy(error)) {
          output.log(`  BLOCKED ${test.name}: ${message}`);
          blocked++;
        } else {
          output.log(`  FAIL ${test.name}: ${message}`);
          failed++;
        }
      }
    }
  }

  output.log(`\nResults: ${passed} passed, ${failed} failed${blocked ? `, ${blocked} blocked` : ''}${notRun ? `, ${notRun} not run` : ''}`);
  return { passed, failed, blocked, notRun };
}

// Cancelled cleanup requests settle promptly; allow them to report first.
const ABANDON_MARGIN_MS = 1000;

async function settleWithin(run, deadline) {
  const result = (async () => run())();
  if (!deadline) return result;

  const signal = deadline.cleanupSignal;
  let onAbort;
  let timer;
  const abandoned = new Promise((_, reject) => {
    onAbort = () => {
      timer = setTimeout(() => reject(new Error(
        'abandoned after the run timeout and cleanup grace period; its resources may remain and need manual cleanup')),
      ABANDON_MARGIN_MS);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  // The abandoned check may still reject later; nothing is left to report it to.
  result.catch(() => {});
  try {
    return await Promise.race([result, abandoned]);
  } finally {
    signal.removeEventListener('abort', onAbort);
    clearTimeout(timer);
  }
}
