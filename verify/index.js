import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';

const { values } = parseArgs({
  options: {
    env: { type: 'string', short: 'e' },
  },
});

if (values.env !== undefined) {
  const { error } = dotenv.config({ path: values.env, quiet: true });
  if (error) {
    console.error(`Failed to load environment file: ${error.message}`);
    process.exit(1);
  }
}

console.log('hello world');

const client = new S3Client({
  endpoint: process.env.AWS_ENDPOINT_URL,
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
  forcePathStyle: true,
});

try {
  const { Buckets = [] } = await client.send(new ListBucketsCommand({}));
  console.log('Buckets:');
  if (Buckets.length === 0) {
    console.log('  (none)');
  } else {
    for (const bucket of Buckets) {
      console.log(`  ${bucket.Name}`);
    }
  }
} catch (error) {
  console.error(`Failed to list buckets: ${error.message}`);
  process.exitCode = 1;
} finally {
  client.destroy();
}
