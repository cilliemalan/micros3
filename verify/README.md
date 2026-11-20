# MicroS3 verification program

This program is intended to verify the S3 operations planned for MicroS3's
[backend](../lib/README.md). It will initially run against an already-running
Floci instance to validate the verifier before checking MicroS3. See
[todo.md](todo.md) for the planned checks.

The verifier first calls ListBuckets to check the S3 connection, then runs the
operation checks in sequence and reports each result and a summary. Implemented
checks cover bucket creation, listing, existence, location and deletion,
including invalid names, repeat creation, missing buckets and non-empty buckets.
Both object-listing APIs are checked for ordered keys and metadata, empty and
missing buckets, prefixes, delimiters, and pagination (including rolled-up
prefixes). CORS configuration checks cover multiple ordered rules and their
fields, replacement, bucket isolation, the 100-rule limit, invalid inputs, and
missing configurations and buckets. Encryption checks verify the SSE-S3 default
configuration on a newly created bucket and the missing-bucket error. Changing
encryption configuration is outside the planned scope. The other operation
checks are still failing stubs. A connection error stops the run, and any
connection or check failure gives a nonzero exit status.

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
The bucket, listing, CORS and encryption checks create uniquely named buckets
and temporary objects or CORS configurations. They attempt cleanup even after failures;
cleanup errors identify the affected resources, which may need manual removal.
A rejected creation is not cleaned up when the response could indicate a bucket
owned by someone else; after an ambiguous SDK retry, manually inspect the named
bucket. The repeat-creation and
non-empty deletion checks also require PutObject, GetObject and DeleteObject
support. The object listing checks require PutObject and DeleteObject support.
The bucket listing check follows up to 1,000 pages when looking for its two test
buckets.

The configured Floci instance currently accepts invalid bucket names and invalid
CORS configurations, so those checks fail against it. They are retained to
verify S3's validation rules. The CORS checks verify configuration APIs; they do
not test HTTP preflight or response headers.

## Implementing checks

The stubs are grouped by operation in `checks/`. Each test has a name and a
`run({ client })` function, which may be asynchronous. Replace the exception with
checks that throw on failure, for example using `node:assert/strict`. The runner
continues after failures, so each implemented test should manage its own setup,
use isolated resource names, and clean up resources in `finally` even if an
assertion fails. Add new sections to the suite list in `index.js`.

Run `pnpm test:unit` to test the runner, startup behavior, bucket, listing, CORS
and encryption checks offline using mock services. This does not run the S3
operation checks against a real endpoint.
