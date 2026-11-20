import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { S3Client } from '@aws-sdk/client-s3';
import { runVerification } from './verification.js';
import bucketTests from './checks/bucket.js';
import objectTests from './checks/object.js';
import listingTests from './checks/listing.js';
import multipartTests from './checks/multipart.js';
import corsTests from './checks/cors.js';
import encryptionTests from './checks/encryption.js';

function loadEnvFile() {
  const { values: { env } } = parseArgs({
    options: {
      env: { type: 'string', short: 'e' },
    },
  });

  if (!env) {
    return true;
  }

  const { error } = dotenv.config({ path: env, quiet: true });

  if (error?.message) {
    console.error(error.message);
  }
  return !error;
}

const suites = [
  { name: 'Bucket operations', tests: bucketTests },
  { name: 'Object operations', tests: objectTests },
  { name: 'Listing operations', tests: listingTests },
  { name: 'Multipart operations', tests: multipartTests },
  { name: 'CORS operations', tests: corsTests },
  { name: 'Encryption', tests: encryptionTests },
];

if (!loadEnvFile()) {
  console.error('Failed to load environment file');
  process.exitCode = 1;
} else {
  const client = new S3Client({
    endpoint: process.env.AWS_ENDPOINT_URL,
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
    forcePathStyle: true,
  });

  if (!await runVerification(client, suites)) {
    process.exitCode = 1;
  }
}
