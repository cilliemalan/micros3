import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { S3Client } from '@aws-sdk/client-s3';
import { runVerification } from './verification.js';
import { TargetError, describeTarget, resolveTarget } from './target.js';
import { resolveTimeouts } from './timeouts.js';
import bucketTests from './checks/bucket.js';
import objectTests from './checks/object.js';
import listingTests from './checks/listing.js';
import listingEncodingTests from './checks/listing-encoding.js';
import multipartTests from './checks/multipart.js';
import corsTests from './checks/cors.js';
import corsBehaviorTests from './checks/cors-behavior.js';
import encryptionTests from './checks/encryption.js';

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

async function resolveRegion(client) {
  try {
    return await client.config.region();
  } catch {
    return undefined;
  }
}

const suites = [
  { name: 'Bucket operations', tests: bucketTests },
  { name: 'Object operations', tests: objectTests },
  { name: 'Listing operations', tests: [...listingTests, ...listingEncodingTests] },
  { name: 'Multipart operations', tests: multipartTests },
  { name: 'CORS operations', tests: [...corsTests, ...corsBehaviorTests] },
  { name: 'Encryption', tests: encryptionTests },
];

const options = parseOptions();
const timeouts = options && selectTimeouts(options);

if (!options || !timeouts) {
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
    if (!await runVerification(client, suites, console, timeouts)) {
      process.exitCode = 1;
    }
  }
}
