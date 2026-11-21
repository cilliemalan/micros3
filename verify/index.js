import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { S3Client } from '@aws-sdk/client-s3';
import { runVerification } from './verification.js';
import { TargetError, describeTarget, resolveTarget } from './target.js';
import { resolveTimeouts } from './timeouts.js';
import { SuiteSelectionError, selectSuites, suites as allSuites } from './suites.js';

function parseOptions() {
  try {
    return parseArgs({
      options: {
        env: { type: 'string', short: 'e' },
        endpoint: { type: 'string' },
        aws: { type: 'boolean', default: false },
        'request-timeout': { type: 'string' },
        'run-timeout': { type: 'string' },
        'cleanup-grace': { type: 'string' },
        suite: { type: 'string', short: 's', multiple: true },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }).values;
  } catch (error) {
    console.error(error.message);
    return undefined;
  }
}

function loadEnvFile(env) {
  if (!env) {
    return true;
  }

  const { error } = dotenv.config({ path: env, quiet: true });

  if (error?.message) {
    console.error(error.message);
  }
  return !error;
}

function selectTarget(options) {
  try {
    return resolveTarget(options, process.env);
  } catch (error) {
    if (error instanceof TargetError) {
      console.error(error.message);
      return undefined;
    }
    throw error;
  }
}

function selectTimeouts(options) {
  try {
    return resolveTimeouts(options);
  } catch (error) {
    if (error instanceof RangeError) {
      console.error(error.message);
      return undefined;
    }
    throw error;
  }
}

function chooseSuites(options) {
  try {
    return selectSuites(options.suite);
  } catch (error) {
    if (error instanceof SuiteSelectionError) {
      console.error(error.message);
      return undefined;
    }
    throw error;
  }
}

const usage = `Usage: node index.js [options]

Verifies an S3 endpoint against the operations MicroS3 supports.

Options:
  --endpoint <url>           S3 endpoint (else AWS_ENDPOINT_URL_S3 or AWS_ENDPOINT_URL)
  --aws                      use the default AWS S3 endpoint (creates real buckets)
  -e, --env <file>           load environment variables from a file
  -s, --suite <name>         run only the named suite; repeat or comma-separate
                             for several (${allSuites.map(suite => suite.id).join(', ')})
  --request-timeout <secs>   per-request timeout (default 30)
  --run-timeout <secs>       whole-run timeout (default 1800)
  --cleanup-grace <secs>     cleanup time after the run timeout (default 120)
  -h, --help                 show this help`;

async function resolveRegion(client) {
  try {
    return await client.config.region();
  } catch {
    return undefined;
  }
}

const options = parseOptions();
const timeouts = options && !options.help && selectTimeouts(options);
const suites = timeouts && chooseSuites(options);

if (options?.help) {
  console.log(usage);
} else if (!options || !timeouts || !suites) {
  if (!options) console.error('Run with --help for usage');
  process.exitCode = 1;
} else if (!loadEnvFile(options.env)) {
  console.error('Failed to load environment file');
  process.exitCode = 1;
} else {
  const target = selectTarget(options);
  if (!target) {
    console.error('Refusing to run without an explicit target');
    process.exitCode = 1;
  } else {
    if (target.aws) {
      // Use the real default endpoint that was opted into, not an endpoint_url
      // from the shared AWS config file that would not be shown to the user.
      process.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = 'true';
    }
    const client = new S3Client({
      endpoint: target.endpoint,
      region: target.region,
      forcePathStyle: true,
    });

    console.log(describeTarget(target, await resolveRegion(client)));
    console.log(`Timeouts: ${timeouts.requestTimeout / 1000} s per request, ` +
      `${timeouts.runTimeout / 1000} s per run, ${timeouts.cleanupGrace / 1000} s cleanup grace`);
    if (suites.length !== allSuites.length) {
      console.log(`Suites: ${suites.map(suite => suite.id).join(', ')}`);
    }
    if (!await runVerification(client, suites, console, timeouts)) {
      process.exitCode = 1;
    }
  }
}
