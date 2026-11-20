// Each test's run function receives the shared context and may be synchronous or async.
export async function runTests(suites, context, output = console) {
  let passed = 0;
  let failed = 0;

  for (const suite of suites) {
    output.log(`\n${suite.name}:`);
    for (const test of suite.tests) {
      try {
        await test.run(context);
        output.log(`  PASS ${test.name}`);
        passed++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.log(`  FAIL ${test.name}: ${message}`);
        failed++;
      }
    }
  }

  output.log(`\nResults: ${passed} passed, ${failed} failed`);
  return { passed, failed };
}
