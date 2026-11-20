// Selects the S3 endpoint the verifier will create resources on.
//
// An endpoint must be supplied explicitly (command line or environment), or
// the real AWS S3 endpoint must be opted into with --aws. This prevents the
// AWS SDK's default endpoint and credential chain from silently creating real,
// billable buckets.

export const AWS_OPT_IN_FLAG = '--aws';
export const ENDPOINT_FLAG = '--endpoint';

// Mirrors the AWS SDK's own precedence for configured endpoint variables.
const ENDPOINT_VARIABLES = ['AWS_ENDPOINT_URL_S3', 'AWS_ENDPOINT_URL'];

export class TargetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TargetError';
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function validateEndpoint(endpoint, source) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new TargetError(`Invalid endpoint from ${source}: ${endpoint}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TargetError(`Endpoint from ${source} must use http or https: ${endpoint}`);
  }
  return endpoint;
}

// Returns { endpoint, source, aws, region, regionSource }. `endpoint` is
// undefined only when the AWS default endpoint was explicitly opted into.
export function resolveTarget({ endpoint: cliEndpoint, aws = false } = {}, env = process.env) {
  let endpoint;
  let source;

  if (cliEndpoint !== undefined) {
    endpoint = nonEmpty(cliEndpoint);
    source = ENDPOINT_FLAG;
    if (!endpoint) {
      throw new TargetError(`${ENDPOINT_FLAG} requires a URL`);
    }
  } else {
    for (const name of ENDPOINT_VARIABLES) {
      endpoint = nonEmpty(env[name]);
      if (endpoint) {
        source = name;
        break;
      }
    }
  }

  if (endpoint && aws) {
    throw new TargetError(
      `${AWS_OPT_IN_FLAG} selects the AWS default endpoint but an endpoint was also supplied by ${source}`);
  }
  if (!endpoint && !aws) {
    throw new TargetError(
      `No S3 endpoint configured. Set ${ENDPOINT_VARIABLES.join(' or ')} (for example with --env), ` +
      `pass ${ENDPOINT_FLAG} <url>, or pass ${AWS_OPT_IN_FLAG} to create real, billable resources ` +
      'on the default AWS S3 endpoint.');
  }

  const region = nonEmpty(env.AWS_REGION) ?? nonEmpty(env.AWS_DEFAULT_REGION);
  const regionSource = nonEmpty(env.AWS_REGION) ? 'AWS_REGION'
    : region ? 'AWS_DEFAULT_REGION' : undefined;

  return {
    endpoint: endpoint ? validateEndpoint(endpoint, source) : undefined,
    source: endpoint ? source : AWS_OPT_IN_FLAG,
    aws,
    region,
    regionSource,
  };
}

export function describeTarget(target, region) {
  const where = target.endpoint
    ? `${target.endpoint} (from ${target.source})`
    : `default AWS S3 endpoint (opted in with ${AWS_OPT_IN_FLAG}; real resources may incur charges)`;
  return `Target: ${where}, region ${region ?? 'unresolved'}`;
}
