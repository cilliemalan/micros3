// The verifier's suites, in run order, and selection by `--suite <name>`.
import bucketTests from './checks/bucket.js';
import objectTests from './checks/object.js';
import listingTests from './checks/listing.js';
import listingEncodingTests from './checks/listing-encoding.js';
import multipartTests from './checks/multipart.js';
import corsTests from './checks/cors.js';
import corsBehaviorTests from './checks/cors-behavior.js';
import encryptionTests from './checks/encryption.js';
import signatureTests from './checks/signature.js';

export const suites = [
  { id: 'auth', name: 'Authentication', tests: signatureTests },
  { id: 'buckets', name: 'Bucket operations', tests: bucketTests },
  { id: 'objects', name: 'Object operations', tests: objectTests },
  { id: 'listing', name: 'Listing operations', tests: [...listingTests, ...listingEncodingTests] },
  { id: 'multipart', name: 'Multipart operations', tests: multipartTests },
  { id: 'cors', name: 'CORS operations', tests: [...corsTests, ...corsBehaviorTests] },
  { id: 'encryption', name: 'Encryption', tests: encryptionTests },
];

export class SuiteSelectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SuiteSelectionError';
  }
}

// Returns the suites named in `names` (each case-insensitive, and each may be a
// comma-separated list), in run order and without duplicates. No names selects
// every suite. An unknown name throws SuiteSelectionError.
export function selectSuites(names, available = suites) {
  const requested = (names ?? [])
    .flatMap(name => String(name).split(','))
    .map(name => name.trim().toLowerCase());
  if (requested.length === 0) return available;
  const known = new Set(available.map(suite => suite.id));
  const unknown = requested.filter(name => !known.has(name));
  if (unknown.length) {
    const list = unknown.map(name => JSON.stringify(name)).join(', ');
    throw new SuiteSelectionError(`Unknown suite ${list}; expected one of: ${[...known].join(', ')}`);
  }
  const wanted = new Set(requested);
  return available.filter(suite => wanted.has(suite.id));
}
