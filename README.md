# MicroS3

MicroS3 is a microminimal S3 emulator. It is a single executable that serves
the S3 REST API over plain HTTP, stores metadata in SQLite and stores object
bodies as files. The supported operations and behavior are listed in
[lib/README.md](lib/README.md). The design is in [docs/design.md](docs/design.md).

## Build

Install CMake 3.20 or newer, Git, and a C/C++17 compiler. The first
configuration downloads the third-party libraries with CMake `FetchContent`:
uWebSockets (with uSockets), SQLite, nlohmann/json, pugixml, zlib, Mbed TLS
and GoogleTest, plus libuv on Windows or Android.

```sh
cmake -B ooo -DCMAKE_BUILD_TYPE=Release
cmake --build ooo
```

Executables are placed directly in `ooo`, including with multi-configuration
generators: `ooo/micros3` is the server and `ooo/testmicros3` runs the
GoogleTest suite. On Windows, append `.exe` to the executable names.

On Linux and other Unix systems except macOS, `micros3` is linked statically
(`-static`). Pass `-DMICROS3_STATIC=OFF` to link it dynamically. On a glibc
host the static link warns about `getaddrinfo`, which is harmless. A fully
static binary is best built on musl, as the Docker image is.

## Run

```sh
ooo/micros3 --data-dir ./data --port 3923
```

The server listens on `http://localhost:3923/`, without TLS. Clients must use
path-style addressing (`http://localhost:3923/<bucket>/<key>`) and sign their
requests with AWS Signature Version 4 in the `Authorization` header. Any region
is accepted. A second listener, for the web UI that is being built, answers on
`http://localhost:3924/`. It has no authentication, so do not expose it to
untrusted networks.

| Setting | Flag | Environment variable | Default |
| --- | --- | --- | --- |
| Data directory | `--data-dir <path>` | `MICROS3_DATA_DIR` | `./data` |
| S3 port | `--port <n>` | `MICROS3_PORT` | `3923` |
| UI port (must differ from the S3 port) | `--ui-port <n>` | `MICROS3_UI_PORT` | `3924` |
| Access key ID | | `MICROS3_ACCESS_KEY_ID` | `test` |
| Secret access key | | `MICROS3_SECRET_ACCESS_KEY` | `test` |

Flags take precedence over environment variables, which take precedence over
the defaults. The credentials have no flags, so they do not appear in process
listings. The data directory holds `micros3.db` (SQLite), `blobs/` and
`staging/`. At startup, unfinished uploads in `staging/` and unreferenced files
in `blobs/` are removed.

For example, with the AWS CLI:

```sh
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1
aws --endpoint-url http://localhost:3923 s3 mb s3://my-bucket
aws --endpoint-url http://localhost:3923 s3 cp README.md s3://my-bucket/
```

## Docker

The image is built from scratch with only the static binary. It runs as user
`65532:65532` and keeps its data in the `/data` volume.

```sh
docker build -t micros3 .
docker run --rm -p 3923:3923 -v micros3-data:/data \
    -e MICROS3_ACCESS_KEY_ID=test -e MICROS3_SECRET_ACCESS_KEY=test micros3
```

A bind-mounted data directory must be writable by user 65532.

## Tests

- `ooo/testmicros3` runs the unit and server tests.
- `test/persistence.sh [binary]` checks that objects survive a restart, and
  `test/crash.sh [binary]` checks that a killed upload leaves nothing partial
  behind. Both start the built server on a temporary data directory and need
  curl 7.75 or newer.
- `test/static-check.sh [binary]` checks that the binary is static.
- `test/ui-check.sh [binary]` starts the server and checks the web UI port
  with curl: the page, its assets, the API, and the request guards.
- `cd ui && pnpm test` runs the web UI's unit tests.
- `test/docker-check.sh [image]` checks the Docker image.
- [verify/](verify/README.md) is a separate Node.js program that checks S3
  compatibility against a running endpoint:

  ```sh
  cd verify && pnpm install
  AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1 \
      pnpm test --endpoint http://localhost:3923
  ```
