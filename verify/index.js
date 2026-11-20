import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';

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

async function initialCheck() {
  const client = new S3Client({
    endpoint: process.env.AWS_ENDPOINT_URL,
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
    forcePathStyle: true,
  });
  
  try {
    await client.send(new ListBucketsCommand({}));
    return true;
  } catch (error) {
    console.error(error.message);
  } finally {
    client.destroy();
  }

  return false;
}



if (!loadEnvFile()) {
  console.error('Failed to load environment file');
  process.exit(1);
}

if (!await initialCheck()) {
  console.error('Initial check failed');
  process.exit(1);
}

// TODO: run through a list of tests in sequence.