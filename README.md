# MicroS3

MicroS3 is a microminimal S3 emulator.

## Build

Install CMake 3.20 or newer, Git, and a C/C++17 compiler. The first
configuration downloads uWebSockets (including uSockets), GoogleTest, and,
on Windows or Android, libuv.

```sh
cmake -B ooo
cmake --build ooo
```

Executables are placed directly in `ooo`, including with multi-configuration
generators. Run `ooo/testmicros3` for the GoogleTest suite, or `ooo/micros3`
to start the server at
`http://localhost:3923/` (options: `--data-dir <path>` or `MICROS3_DATA_DIR`,
default `./data`; `--port <n>` or `MICROS3_PORT`, default 3923; credentials
from `MICROS3_ACCESS_KEY_ID` and `MICROS3_SECRET_ACCESS_KEY`, default
`test`/`test`). S3 operations are not implemented yet. On Windows, append `.exe` to the executable names.
The initial server uses plain HTTP, without TLS or WebSocket compression.

