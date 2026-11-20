# MicroS3 verification program

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

The program includes the AWS SDK S3 client for future S3-compatible storage checks.
