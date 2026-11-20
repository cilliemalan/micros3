# MicroS3 verification program

This program is intended to verify the S3 operations planned for MicroS3's
[backend](../lib/README.md). It will initially run against an already-running
Floci instance to validate the verifier before checking MicroS3. See
[todo.md](todo.md) for the planned checks.

On startup, the program prints `hello world` and lists buckets to check the S3
connection. An empty bucket list is reported as `(none)`. Connection or S3 errors
are reported and cause a nonzero exit status. Other operation checks are still
planned.

Install Node.js 20 or newer and pnpm, then install dependencies and run the program:

```sh
cd verify
pnpm install
pnpm start
```

To load environment variables from a file, pass its path with `-e` or `--env`:

```sh
pnpm start -e ../floci.env
# or
pnpm start --env ../floci.env
```

The repository's `floci.env` provides the connection settings for the running
Floci instance: `AWS_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
and `AWS_DEFAULT_REGION`. The client uses path-style addressing and the AWS SDK's
credential provider chain; `AWS_REGION` takes precedence over
`AWS_DEFAULT_REGION`. Existing environment variables are not overwritten by the
environment file.

Without a custom endpoint, the AWS SDK uses its default AWS S3 endpoint and
credentials, so ensure the intended endpoint and credentials are configured
before running.
