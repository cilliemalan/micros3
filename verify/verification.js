import { ListBucketsCommand } from '@aws-sdk/client-s3';
import { runTests } from './test-runner.js';

// Own the client for the whole run, including the initial connection check.
export async function runVerification(client, suites, output = console) {
  try {
    try {
      await client.send(new ListBucketsCommand({}));
    } catch (error) {
      output.error(error instanceof Error ? error.message : String(error));
      output.error('Initial check failed');
      return false;
    }

    const { failed } = await runTests(suites, { client }, output);
    return failed === 0;
  } finally {
    client.destroy();
  }
}
