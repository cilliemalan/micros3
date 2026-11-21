# MicroS3

MicroS3 is a microminimal S3 emulator. It is a single executable that serves
the S3 REST API over plain HTTP. See [lib/README.md](lib/README.md) for the
supported operations and [docs/design.md](docs/design.md) for the design.

## Docker

Pull and run the latest image. The `micros3-data` volume keeps your data when
the container is removed or upgraded.

```sh
docker pull ghcr.io/cilliemalan/micros3:latest
docker run -d --name micros3 \
    -p 3923:3923 -p 3924:3924 \
    -v micros3-data:/data \
    ghcr.io/cilliemalan/micros3:latest
```

- S3 API: `http://localhost:3923/` (path-style addressing, AWS Signature
  Version 4, any region). Use the default credentials.
- Web UI: `http://localhost:3924/`

Stop and remove the container with `docker rm -f micros3`. The volume stays,
so running the image again picks up the same data.

Tags are `latest` and each release, such as `v0.1`.

> The UI has no authentication and is not encrypted. Anyone who can reach
> port 3924 can read and delete all data, so do not expose it to untrusted
> networks.

## Build from source

Install CMake 3.20 or newer, Git, a C/C++17 compiler, and Node.js with pnpm
(run `corepack enable` once). The build also compiles the web UI in `ui/`. The
first configure downloads the third-party libraries with CMake `FetchContent`.

```sh
cmake -B ooo -DCMAKE_BUILD_TYPE=Release
cmake --build ooo
```

The executables are placed in `ooo`: `ooo/micros3` is the server and
`ooo/testmicros3` runs the unit tests. On Windows, add `.exe` to the names.

To build the Docker image yourself, run `docker build -t micros3 .`.

## Run

```sh
ooo/micros3 --data-dir ./data --port 3923
```

| Setting | Flag | Environment variable | Default |
| --- | --- | --- | --- |
| Data directory | `--data-dir <path>` | `MICROS3_DATA_DIR` | `./data` |
| S3 port | `--port <n>` | `MICROS3_PORT` | `3923` |
| UI port | `--ui-port <n>` | `MICROS3_UI_PORT` | `3924` |

Flags take precedence over environment variables. The data directory holds
`micros3.db` (SQLite), `blobs/` and `staging/`.

## Tests

- `ooo/testmicros3` runs the unit and server tests.
- `test/persistence.sh [binary]`, `test/crash.sh [binary]`,
  `test/static-check.sh [binary]`, `test/ui-check.sh [binary]` and
  `test/docker-check.sh [image]` check a built binary or image.
- `cd ui && pnpm test` runs the web UI tests.
- [verify/](verify/README.md) checks S3 compatibility against a running server:

  ```sh
  cd verify && pnpm install
  AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1 \
      pnpm test --endpoint http://localhost:3923
  ```
