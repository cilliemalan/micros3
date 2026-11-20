# MicroS3 verification program

This program is intended to verify the S3 operations planned for MicroS3's
[backend](../lib/README.md). It will initially run against an already-running
Floci instance to validate the verifier before checking MicroS3. See
[todo.md](todo.md) for the planned checks.

The verifier first calls ListBuckets to check the S3 connection, then runs the
operation checks in sequence and reports each result and a summary. All operation
checks are currently failing stubs; they do not yet exercise the operations or
create resources. A connection error stops the run, and any connection or test
failure gives a nonzero exit status.

Install Node.js 20 or newer and pnpm, then install dependencies and run the program:

```sh
cd verify
pnpm install
pnpm test
```

To load environment variables from a file, pass its path with `-e` or `--env`:

```sh
pnpm test -e ../floci.env
# or
pnpm test --env ../floci.env
```

The repository's `floci.env` provides the connection settings for the running
Floci instance: `AWS_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
and `AWS_DEFAULT_REGION`. The client uses path-style addressing and the AWS SDK's
credential provider chain; `AWS_REGION` takes precedence over
`AWS_DEFAULT_REGION`. Existing environment variables are not overwritten by the
environment file.

`pnpm start` is an alias for the verifier and accepts the same options. Without
a custom endpoint, the AWS SDK uses its default AWS S3 endpoint and credentials,
so ensure the intended endpoint and credentials are configured before running.

## Implementing checks

The stubs are grouped by operation in `checks/`. Each test has a name and a
`run({ client })` function, which may be asynchronous. Replace the exception with
checks that throw on failure, for example using `node:assert/strict`. The runner
continues after failures, so each implemented test should manage its own setup,
use isolated resource names, and clean up resources in `finally` even if an
assertion fails. Add new sections to the suite list in `index.js`.

Run `pnpm test:unit` to test the runner and startup behavior offline using a
local mock HTTP server. This does not run the S3 operation checks against a
real endpoint.
