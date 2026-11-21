import assert from 'node:assert/strict';
import test from 'node:test';
import { SuiteSelectionError, selectSuites, suites } from '../suites.js';

test('suites have unique ids in design order and contain checks', () => {
  assert.deepEqual(suites.map(suite => suite.id),
    ['buckets', 'objects', 'listing', 'multipart', 'cors', 'encryption']);
  for (const suite of suites) {
    assert.ok(suite.tests.length > 0, suite.id);
    for (const check of suite.tests) assert.equal(typeof check.run, 'function', check.name);
  }
});

test('no selection runs every suite', () => {
  assert.equal(selectSuites(undefined), suites);
  assert.equal(selectSuites([]), suites);
});

test('selection keeps run order, ignores case and duplicates, and accepts comma lists', () => {
  assert.deepEqual(selectSuites(['cors']).map(suite => suite.id), ['cors']);
  assert.deepEqual(selectSuites(['Encryption', 'buckets']).map(suite => suite.id),
    ['buckets', 'encryption']);
  assert.deepEqual(selectSuites(['listing, objects', 'listing']).map(suite => suite.id),
    ['objects', 'listing']);
});

test('an unknown or empty suite name is rejected with the valid names', () => {
  assert.throws(() => selectSuites(['bucket']), error =>
    error instanceof SuiteSelectionError &&
    /Unknown suite "bucket"; expected one of: buckets, objects, listing, multipart, cors, encryption/
      .test(error.message));
  assert.throws(() => selectSuites(['']), SuiteSelectionError);
  assert.throws(() => selectSuites(['cors,']), SuiteSelectionError);
});
