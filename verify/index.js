import { parseArgs } from 'node:util';
import dotenv from 'dotenv';

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
