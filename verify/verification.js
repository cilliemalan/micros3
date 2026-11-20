import { ListBucketsCommand } from '@aws-sdk/client-s3';
import { runTests } from './test-runner.js';
import { applyTimeouts, createRunDeadline } from './timeouts.js';

// Own the client for the whole run, including the initial connection check.
// `timeouts` ({ requestTimeout, runTimeout, cleanupGrace } in milliseconds)
// bounds every request and the run as a whole; omit it to run unbounded.
export async function runVerification(client, suites, output = console, timeouts) {
  const deadline = timeouts && createRunDeadline(timeouts);
  if (timeouts) applyTimeouts(client, { requestTimeout: timeouts.requestTimeout, deadline });
  try {
    try {
      await client.send(new ListBucketsCommand({}));
    } catch (error) {
      output.error(error instanceof Error ? error.message : String(error));
      output.error('Initial check failed');
      return false;
    }

    const { failed, notRun } = await runTests(suites, { client }, output, { deadline });
    if (deadline?.signal.aborted) {
      output.error(`Run timeout of ${deadline.runTimeout} ms reached; ${notRun} checks not run`);
    }
    return failed === 0 && !notRun;
  } finally {
    deadline?.dispose();
    client.destroy();
  }
}
