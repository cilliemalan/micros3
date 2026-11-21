# MicroS3 UI

The UI is a browser console for the emulator. It lets a developer browse and administer buckets and objects: create and delete buckets, browse and upload objects, edit metadata, copy and move, manage CORS, and abort uploads in progress.

It runs in the same process as the S3 API, on its own port, and is compiled into the single static executable. Its frontend is React with the Vercel UI SDK, built with pnpm and Vite. Its backend is a JSON API written in C++ that calls the store directly.

## Decisions

| # | Decision |
| --- | --- |
| UI1 | The UI listens on its own port, default `3924`. It is set by `--ui-port <n>` or `MICROS3_UI_PORT`. It must differ from the S3 port. It is not served on the S3 port. |
| UI2 | The UI has no authentication and no access control. It does not sign requests. It has its own JSON API under `/api/`, which does what the UI needs. The request guards in UI6 still apply. |
| UI3 | The UI is served over plain HTTP. TLS and any reverse proxy are the user's responsibility. |
| UI4 | The frontend is a Vite and React project, built with pnpm during the CMake build and embedded in the executable. The binary stays one static file with no runtime files. |
| UI5 | The UI is always on and always listening. To run without it, do not publish its port. For example, `docker run -p 3923:3923` publishes only the S3 port. |
| UI6 | Guards on every request to the UI port. The `Host` header must name `localhost` or an IP address. Changing requests (`POST`, `PUT`, `DELETE`) must carry no `Origin` other than the UI's own. These stop DNS rebinding and requests from other web pages. They are not authentication. See **Request guards**. |
| UI7 | A metadata edit changes the stored headers of the object row in place. It does not copy the blob, so the ETag and last-modified time stay the same. This differs from S3 on purpose. |
| UI8 | Node.js and pnpm are required to build the executable, in the same way the verifier already requires them. The CMake build runs pnpm itself. |

## Risks accepted with UI2 and UI5

- **Anyone who can reach the UI port can read and delete all data.** The UI port listens on all interfaces, as the S3 port does. Its protection is network reach and the guards in UI6. S3 signatures do not protect it.
- **Traffic is not encrypted.** UI3 says so. Do not expose the port to untrusted networks.
- **The guards are not authentication.** UI6 stops other sites in the user's browser from driving the API, and stops DNS rebinding. A client outside a browser can still send any request without an `Origin` header.
- **A reverse proxy must keep `Host` unchanged.** The guards compare `Host` and `Origin`. A proxy that rewrites `Host`, or that serves the UI over HTTPS, will have its requests refused. The README says so.
- **The Vercel UI SDK is in beta.** Its own documentation says its APIs may still change. Pin exact versions, and keep UI code that uses it in few places.

## Architecture

```
  Browser (developer)                       S3 clients (AWS SDK, verify, aws cli)
        |                                             |
        | http://host:3924/                           | http://host:3923/
        v                                             v
  +------------------------+              +------------------------+
  | UI listener (3924)     |              | S3 listener (3923)     |
  | guards (UI6)           |              | SigV4, router, S3      |
  | embedded static files  |              | handlers (XML)         |
  | /api/* JSON routes     |              |                        |
  +------------------------+              +------------------------+
        |                                             |
        +----------------------+----------------------+
                               v
                    +---------------------+
                    | Store               |
                    | micros3.db, blobs/, |
                    | staging/            |
                    +---------------------+
```

Both listeners run on the same uWebSockets event loop, on one thread. The store is therefore used from one thread, as it is now. A slow request on either port delays the other, as today's copies already delay S3 requests.

### Server changes

`Server::run` currently owns one uWebSockets app with one service. It needs to host two listeners, each with its own service: the S3 service on `--port` and the UI service on `--ui-port`.

**Checked (U2):** uWebSockets 20.81 runs two listening apps on one loop. The loop is per thread (`uWS::Loop::get()`), and each `uWS::App` adds its own socket context to it. `Server` now takes one service per listener, creates one app per listener, and runs the shared loop. Listening uses `LIBUS_LISTEN_EXCLUSIVE_PORT`, because uSockets otherwise sets `SO_REUSEPORT` and a second process could share a port in use instead of failing to bind.

Startup binds both ports. If either fails to bind, the server logs the error and exits with status 1. Equal ports are a usage error with status 2.

### Configuration

| Setting | Flag | Environment variable | Default |
| --- | --- | --- | --- |
| S3 port | `--port <n>` | `MICROS3_PORT` | `3923` |
| UI port | `--ui-port <n>` | `MICROS3_UI_PORT` | `3924` |

Flags beat environment variables, which beat defaults, as they do now.

## Request guards (UI6)

The guards run on every request to the UI port, before routing. A refused request gets 403 `AccessForbidden` in the JSON error shape.

1. **Host.** The `Host` header must be `localhost` (any case), or an IPv4 address, or a bracketed IPv6 address. It may have a port, which must equal the UI port. A missing `Host` is refused. A name for any other host is refused. A page on another site cannot make its own name point at this server and still pass this check, which stops DNS rebinding.
2. **Origin.** For `POST`, `PUT` and `DELETE` (in the code, every method other than `GET` and `HEAD`): if an `Origin` header is present, it must equal `http://` followed by the `Host` header value. Requests with no `Origin` (curl, scripts) pass. `GET` and `HEAD` are not checked. They change nothing, and CORS already hides their replies from other sites.

These guards are part of the design, so the verifier and the S3 port are unaffected.

## Backend: the JSON API

The UI service is an `http::Service`, like the S3 service. It reuses the same request and exchange types, so streaming works the same way.

### Conventions

- Bodies and responses are JSON, except object content and the CORS XML body.
- Errors are a JSON object, `{"error": {"code": "NoSuchBucket", "message": "..."}}`, with the HTTP status the S3 API uses for that code. The codes are the S3 codes, so the UI can reuse S3 error vocabulary. Three codes are the UI API's own: `MalformedJSON` (400) for a body that is not the JSON the route expects, `MethodNotAllowed` (405) for a known path with another method, and `NotFound` (404) for an unknown path. `HEAD` is allowed wherever `GET` is.
- Path segments, such as the bucket name, are percent-decoded. A malformed escape is 400 `InvalidURI`.
- `POST /api/buckets` answers 409 `BucketAlreadyOwnedByYou` when the bucket exists, in any region.
- An object key is always passed in a `key` query parameter, never in the path. Keys can contain `/`, spaces, and any UTF-8, and a query parameter avoids path-encoding rules.
- A batch takes at most 1,000 keys, as S3 does.
- `POST .../copy`: a `bucket` left out of `source` or `destination` is the bucket in the path. Copying an object onto itself is 400 `InvalidRequest`. The copy keeps the source's stored headers. With `move`, the source is deleted after the copy succeeds; if that delete fails the copy stays and the reply is 409 `MoveIncomplete`.
- `PUT .../meta` takes only the stored headers (`Content-Type`, `Cache-Control`, `Content-Disposition`, `Content-Encoding`, `Content-Language`, `Expires`, `x-amz-meta-*`), with names in any case. Others, repeated names, and values with control characters are 400 `InvalidArgument`. User metadata over 2 KB is 400 `MetadataTooLarge`.
- `POST .../delete` reports an empty or too-long key in `errors` and deletes the rest. Missing keys count as deleted.
- Requests with a body larger than the store's maximum are refused with `EntityTooLarge`.

### Routes

| Method | Path | Purpose | Reuses |
| --- | --- | --- | --- |
| GET | `/api/health` | Liveness check for scripts | none |
| GET | `/api/buckets` | List buckets: name, region, creation time | `buckets::list` |
| POST | `/api/buckets` | Create a bucket, body `{name, region}` | `buckets::valid_name`, `buckets::create` |
| GET | `/api/buckets/{bucket}` | Bucket details: region, creation time, default encryption, whether CORS is set | `buckets::find`, `cors::load` |
| DELETE | `/api/buckets/{bucket}` | Delete an empty bucket. Answers 409 `BucketNotEmpty` otherwise | `buckets::remove` |
| POST | `/api/buckets/{bucket}/empty` | Delete all objects and uploads, in batches | `buckets::empty` |
| GET | `/api/buckets/{bucket}/objects` | List one level: `prefix`, `delimiter=/`, `after`, `limit`. Returns folders, objects and a continuation value | `listing::list` |
| PUT | `/api/buckets/{bucket}/object?key=` | Upload a file. The raw body is the content. Headers `Content-Type`, `Cache-Control` and `x-amz-meta-*` are stored | `StagedBlob`, `objects::metadata_from`, `objects::put` |
| GET | `/api/buckets/{bucket}/object?key=` | Download the content, streamed from the blob file | `objects::find`, `FileBody` |
| GET | `/api/buckets/{bucket}/meta?key=` | Object details as JSON: size, ETag, last-modified, stored headers | `objects::find` |
| PUT | `/api/buckets/{bucket}/meta?key=` | Replace stored headers in place, body `{headers: {...}}` (UI7) | `objects::find`, `objects::update_headers` |
| POST | `/api/buckets/{bucket}/delete` | Delete a batch of keys, body `{keys: [...]}` | `objects::remove_many` |
| POST | `/api/buckets/{bucket}/copy` | Copy or move one object, body `{source: {bucket, key}, destination: {bucket, key}, move}` | `objects::copy`, extracted from `copy_object` |
| GET | `/api/buckets/{bucket}/cors` | Stored CORS configuration as XML, or 404 `NoSuchCORSConfiguration` | `cors::load` |
| PUT | `/api/buckets/{bucket}/cors` | Set CORS from the S3 XML body. The UI builds it from a form | `cors::parse`, `cors::save` |
| DELETE | `/api/buckets/{bucket}/cors` | Remove the CORS configuration | `cors::save` |
| GET | `/api/buckets/{bucket}/uploads` | Multipart uploads in progress, paged | `uploads::list` |
| DELETE | `/api/buckets/{bucket}/uploads?key=&uploadId=` | Abort one upload | `uploads::abort` |

### Reply shapes

The client in `ui/src/api.ts` (U6) expects these JSON replies. Field names are camelCase and times are ISO 8601 strings in UTC. Routes not listed answer 204 with no body on success.

| Route | Reply |
| --- | --- |
| `GET /api/health` | `{status: "ok"}` |
| `GET /api/buckets` | `{buckets: [{name, region, created}]}` |
| `POST /api/buckets` | `{name, region, created}` |
| `GET /api/buckets/{bucket}` | `{name, region, created, encryption, cors}`, with `cors` a boolean |
| `GET .../objects` | `{folders: [prefix], objects: [{key, size, etag, lastModified}], next?}`. `next` is the value for `after`, absent on the last page |
| `GET` and `PUT .../meta` | `{key, size, etag, lastModified, headers: {name: value}}` |
| `PUT .../object` | `{key, size, etag, lastModified}` |
| `POST .../delete` | `{deleted: [key], errors: [{key, code, message}]}` |
| `POST .../copy` | `{key, size, etag, lastModified}` of the destination |
| `GET .../object` | The content, streamed, with the stored `Content-Type` (`binary/octet-stream` when none), `ETag`, `Last-Modified`, `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment` naming the last segment of the key (RFC 5987 `filename*`, with an ASCII `filename` fallback) |
| `GET .../cors` | The XML, as `application/xml` |
| `GET .../uploads` | `{uploads: [{key, uploadId, initiated}], next?: {key, uploadId}}`. The next page is asked for with `keyMarker` and `uploadIdMarker`; `prefix` and `limit` (1 to 1,000) are optional |

The UI does not need `ListObjects` v1, multipart upload creation, or part uploads. A large upload uses the single `PUT` above, up to the store's 5 GiB limit. The object row is written only once the whole body has arrived, so an upload that is too large, cut short, or whose bucket is deleted meanwhile leaves no visible object and no staged file.

### Metadata edits (UI7)

`PUT /api/buckets/{bucket}/meta` rewrites the `headers` column of the object's row in one transaction. The blob is not touched, and the ETag and last-modified time stay as they were. S3 would copy the object and change its last-modified time. Callers that compare the two behaviors will see the difference, and it is intended.

### Shared code

Some of the logic the routes need is currently inside the S3 handlers. It moves into library functions that both the S3 handlers and the UI service call, so S3 behavior does not change:

- `objects::copy`, from `copy_object` in `lib/object_handlers.cpp`.
- `buckets::empty`, the "empty bucket" loop. It shares the upload and part removal with `buckets::remove`.
- `objects::update_headers`, a new function for UI7.

After this refactor the full `verify` run must still pass, unchanged.

## Frontend

### Stack

- **React 19** with **TypeScript**, built with **Vite**, and managed with **pnpm**. The pnpm version is pinned by the `packageManager` field in `ui/package.json`, and the lockfile is committed.
- **Vercel UI SDK**: `@ui-sdk/react` for components and `@ui-sdk/core` for behavior, both at exact pinned versions. The SDK components are unstyled and provide keyboard, focus and ARIA behavior. Each component is imported from its own entry, for example `@ui-sdk/react/dialog`.
- **Styling**: `@ui-sdk/core/web.css` as the base look, then our own design tokens (CSS variables on `:root`) for colors, spacing, radii and type. Light and dark themes both come from the tokens.
- **No router library.** The app uses hash routes such as `#/buckets/photos/objects?prefix=2026/`. A static file server then needs no fallback rules, and a reload keeps the place.
- **No state library.** A small typed `api` module wraps `fetch` and `XMLHttpRequest`, and React state holds the rest.
- **No external resources.** No CDN, no web fonts, no remote images. Icons are inline SVG.

The SDK has no data table, breadcrumbs, or sidebar. Those parts are built in our code on top of its primitives. The SDK's own documentation shows keyboard and ARIA behavior for its components, so the custom parts must follow the same patterns.

### Screens

1. **Buckets.** A list with name, region and creation time. A New bucket dialog with name validation, using the rules in `buckets::valid_name`, and a region select. Delete uses an alert dialog. If the bucket is not empty, the dialog offers "Empty and delete".
2. **Bucket page.** Three tabs.
   - **Objects.** A breadcrumb for the prefix, a filter box, and a table of folders and objects, with checkboxes. Actions: Upload, New folder, Delete selected, and a row menu with Download, Details, Copy or move, and Delete. "Load more" pages through results.
   - **Uploads.** In-progress multipart uploads, with Abort.
   - **Settings.** Region and default encryption, read-only. CORS rules as a form that builds the XML, with Save and Remove.
3. **Object drawer.** Details from `meta`. A metadata form with `Content-Type`, `Cache-Control`, `Content-Disposition`, `Content-Encoding`, `Content-Language`, `Expires`, and rows for `x-amz-meta-*`. Saving changes the stored headers in place (UI7). Preview for images and for text up to 1 MiB.
4. **Uploads.** A File Input accepts a drop or a file choice. Each file has a progress bar, from `XMLHttpRequest` upload events. Toasts report success and failure.

### Layout and style

- A left sidebar lists the buckets, with a search box and a New bucket button. The main panel has a top bar with the bucket name and tabs.
- The layout works from 900 px wide. The sidebar can collapse below that.
- Every interactive element has a visible focus ring, and every form field has a label.
- The table is sized to read easily: monospace for keys and ETags, right-aligned sizes, relative and absolute times.
- Dark mode follows `prefers-color-scheme` by default, and the user can choose Light or Dark. `web.css` colors use `light-dark()` under `color-scheme: light dark`. The choice comes from the SDK's `createColorScheme` with `global: true`, stored in local storage, applied by `Preferences` as `data-color-scheme` on `<html>`. Our stylesheet maps `[data-color-scheme="light"]` and `[data-color-scheme="dark"]` to `color-scheme`. Checked in the U5 spike.
- **Tokens** (U20). `ui/src/index.css` defines them on `:root`, and the rest of the stylesheet uses only them. Colors: `--color-bg`, `--color-fg`, `--color-surface`, `--color-muted-fg`, `--color-border`, `--color-border-strong`, `--color-hover` and `--color-selected` are aliases for the neutral `--ui-*` colors of `web.css`. `--color-accent` (a blue, for the brand mark, the current bucket, link hover and drag-over), `--color-accent-soft` (selected rows), `--color-danger-soft`, `--color-danger-border` and `--color-success` are ours, written with `light-dark()` so they switch with the theme in the same way. Spacing is `--space-1` to `--space-8` on a 4 px step; radii are `--radius-sm`, `--radius` (also set as `--ui-radius`, which rounds the SDK's components) and `--radius-lg`; type is `--text-xs` to `--text-xl`, `--weight-medium` and `--weight-semibold`, and the SDK's font stacks.
- **States** (U20). Every screen shows loading, empty and error the same way, through `Loading`, `EmptyState` and `ErrorState` in `ui/src/components/States.tsx`: a spinner line (still under `prefers-reduced-motion`); a dashed frame with an icon, a title, a hint and actions; and, for errors, a solid frame tinted with `--color-danger-soft`, an alert icon, the title, the error's message and code (`errorDetail` in `ui/src/api.ts`), and "Try again" where it helps. A form's or dialog's own failure is a tinted box; a field's error stays a line of red text under the field.
- **Tables** (U20). Each table sits in a bordered, rounded frame (`.table-wrap`) that scrolls sideways if it must, with a tinted header row of small muted labels, row hover, and an accent tint on selected rows.
- Checked with screenshots in Chromium, light and dark, at 900 and 1440 px: the bucket list, the object table with a selected row, an empty bucket, a missing bucket, the Settings and Uploads tabs, the object drawer, and the New bucket dialog with a field error.

## Security of the frontend

- React escapes all text. The code never uses `dangerouslySetInnerHTML` or `innerHTML`. A check in the test suite fails the build if it finds either.
- **Object content is never rendered as HTML on the UI origin.** Previews are only for `image/*` (up to 20 MiB), shown through a `blob:` URL, and for text up to 1 MiB (`text/*`, JSON and XML, `+json` and `+xml` included), shown as text in a `<pre>`, so HTML appears as its source. Downloads carry `Content-Disposition: attachment`, with the file name encoded as RFC 5987 says. The UI never navigates to an object URL.
- **Response headers from the UI service**: `Content-Security-Policy: default-src 'self'; img-src 'self' blob: data:; connect-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`. No HSTS, since the UI is plain HTTP.
- **CSP and the SDK.** The SDK adds its CSS when a component mounts. Its docs say that with a `<meta property="csp-nonce">` tag that has no `nonce` attribute, it adds the CSS as constructed style sheets (`document.adoptedStyleSheets`), which `style-src` does not block. `ui/index.html` has that tag, so the policy needs neither a nonce nor `'unsafe-inline'`, and the server needs no per-request rewriting of `index.html`. Scripts stay `'self'`.
- **`data:` in `img-src`.** `web.css` draws its icons (chevron, check, minus, plus, x) as `data:image/svg+xml` URLs in CSS variables, used as masks. `img-src` governs those, and without `data:` they are blocked. `data:` is allowed for images only. Vite is set with `assetsInlineLimit: 0`, so our own assets are never inlined as `data:` URLs.

## Build and embedding

The UI is built by the same CMake project that builds the executable. Nothing is built by hand, and a plain `cmake --build` builds the UI when it needs building.

### Tools

- **Node.js** `^20.19.0 || >=22.12.0`, the range the pinned Vite 8.3.8 requires. `ui/package.json` states it in `engines`. The spike used Node 24.15.
- **pnpm**, the version pinned in `ui/package.json`. It is run through corepack, which ships with Node.js. The verifier already uses pnpm, so developers have it.
- CMake looks for `node` and `pnpm` at configure time. If either is missing, configuration stops with an error that says to install Node.js and run `corepack enable`.

### Layout

- `ui/`: `package.json` (with `packageManager`), `pnpm-lock.yaml`, `index.html`, `vite.config.ts`, `tsconfig.json`, and `src/`.
- `ui/node_modules` is installed by pnpm and is not committed.
- The Vite output is not written into the source tree. It goes to the build directory, so `ui/dist` does not exist.
- `cmake/embed_ui.cmake` is the embedding script.

### Pipeline

The CMake targets form this chain.

1. **`ui_install`**, a custom target that runs on every build: `pnpm install --frozen-lockfile` in `ui/`. When nothing has changed, pnpm finishes in about a second. It covers a fresh clone, a deleted `node_modules`, and a changed lockfile, so no separate stamp can go stale.
2. **`ui_build`**, a custom command that produces `<build>/ui/build.stamp`. It runs `pnpm exec vite build --outDir <build>/ui/dist --emptyOutDir` in `ui/`. Its dependencies are every file under `ui/` except `node_modules`, found with `file(GLOB_RECURSE ... CONFIGURE_DEPENDS)`. It runs only when one of those files is newer than the stamp, so an edit to `ui/src` rebuilds the UI, and a build with no UI edit does not run Vite.
3. **`ui_assets.cpp`**, a custom command that runs `cmake -P cmake/embed_ui.cmake`. The script reads every file in `<build>/ui/dist`, in sorted order, and writes a table: path, content type, bytes and size. It writes to a temporary file and then uses `cmake -E copy_if_different`, so `libmicros3` is not rebuilt when the bytes are the same.
4. **`ui_assets`**, a custom target that depends on `ui_install` and on `ui_assets.cpp`. `libmicros3` depends on it, so the ordering is right: install, then build, then embed, then compile.

The test target links `libmicros3`, so it builds the UI too.

### Packaging

- `ui_assets.cpp` is compiled into `libmicros3`. The UI service serves the entries as the S3 service serves its responses.
- The generated bytes are part of the executable's read-only data. The binary stays static, and the static check in `test/static-check.sh` still applies.
- The Dockerfile's builder stage installs the Alpine `nodejs` and `npm` packages (Node 22.23 on Alpine 3.22, inside the range Vite needs). Alpine has no `corepack` package, so the stage runs `npm install -g corepack` and then `corepack enable`, and sets `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` so corepack fetches the pinned pnpm without asking. It copies `cmake/` and `ui/` before the CMake step. `.dockerignore` does not exclude `ui/`, but excludes `ui/node_modules`. The final image is still `FROM scratch` with only the binary and `/data` (checked from a clean clone: two layers, 7.0 MB, and `test/docker-check.sh` passes).
- Build sizes are recorded before and after the UI, as an input to a later decision about size budgets.

### Spike results (U5)

The scaffold in `ui/` pins React 19.3.1, `@ui-sdk/react` and `@ui-sdk/core` 0.1.0-beta.13, Vite 8.3.8, `@vitejs/plugin-react` 6.3.0, TypeScript 7.0.2 and Vitest 5.1.1, all exact, with pnpm 12.21.0 in `packageManager`. A placeholder page with a Button, a Dialog and a color-scheme switch was built and served with the CSP above, then driven in Chromium.

1. **Client-only build.** `pnpm exec vite build --outDir <dir> --emptyOutDir` works with no server rendering. The output is `index.html` plus hashed files under `assets/` (one JS file of about 314 kB, 103 kB gzipped, two small JS chunks, and one CSS file of about 85 kB). `tsc --noEmit` passes.
2. **Styles under the CSP.** With the nonce-less `csp-nonce` meta tag, the SDK added two constructed style sheets and no `<style>` tags, and opening the Dialog caused no CSP violation under `style-src 'self'`. The one violation found was `img-src` blocking the `data:` icons in `web.css`, so the policy adds `data:` to `img-src`.
3. **Dark mode.** Works. With the choice at System, the page follows the emulated `prefers-color-scheme`. Choosing Dark sets `data-color-scheme="dark"` on `<html>`, the background becomes `oklch(0.145 0 0)`, and the choice survives a reload.

The built JS contains URL strings that are not fetched: XML namespace URIs (`http://www.w3.org/...`) in React DOM, and React's `https://react.dev/errors/` message text. The check in U21 for external URLs must allow those, and fail on anything the page would load.

### Build results (U12)

The pipeline is in `cmake/ui.cmake`, included from the root `CMakeLists.txt`, and `cmake/embed_ui.cmake`. The output goes to `<build>/ui/` (`dist/`, `build.stamp` and `ui_assets.cpp`). Checked by hand: a clean clone configures and builds the UI with the binary; a build with no UI edit runs only `pnpm install`; editing a file in `ui/src` runs Vite and the embed step, and the library is recompiled only when the built bytes change (an edit that minifies away, such as a comment, recompiles nothing); deleting `ui/node_modules` is repaired by the next build (it also re-runs CMake once, since the top level of `ui/` is globbed with its directories); touching or changing the lockfile reinstalls and rebuilds; and with `node` or `pnpm` missing from `PATH` configuration stops with the message above.

The static `micros3` binary grew from 6,081,344 bytes (before the UI) to 6,524,672 bytes with the scaffold page embedded (about 436 KB of assets). The generated `ui_assets.cpp` is about 2.2 MB of source.

The UI service serves `/` as `index.html` with `Cache-Control: no-cache`, the hashed files under `/assets/` with `Cache-Control: public, max-age=31536000, immutable`, and any other embedded file at its own path with `no-cache`. Other paths, including S3-style ones, are a JSON 404 `NotFound`, and a method other than GET or HEAD on a file is 405.

### Development loop

`pnpm dev` in `ui/` starts the Vite dev server. It proxies `/api` to a running `micros3 --ui-port 3924`. The S3 side is separate, and verify still runs against the S3 port.

## Testing

- **C++.** `test/ui_api_test.cpp` tests each route with the same server-test setup as today. It covers both success and error codes, the `key=` parameter with awkward keys (spaces, `%`, `/`, UTF-8, `<script>`), batch limits, and the `BucketNotEmpty` path. `test/ui_test.cpp` covers the guards (Host and Origin, including rebinding names and a proxy-style rewritten Host), static serving, and 404 for S3-style paths. `test/ui_assets_test.cpp` checks that `index.html` is embedded, with the right content types.
- **Build.** Checks for the CMake pipeline: a clean clone builds the UI; editing one `ui/src` file rebuilds the UI and the binary; a build with no UI edit does not run Vite; deleting `ui/node_modules` is repaired by the next build; changing the lockfile reinstalls; a missing pnpm stops configuration with the message above.
- **Frontend unit tests.** Vitest tests the API client, the key and URL helpers, and the metadata form's header mapping.
- **Browser tests.** Playwright, through the playwright-cli skill, drives these flows against a running binary: create a bucket, upload into a folder, browse, download, edit metadata, copy and move, delete, empty and delete the bucket, set and remove CORS, and abort an upload. The run saves screenshots, which are checked by eye for layout and both themes.
- **Scripts.** `test/ui-check.sh` uses curl to check the UI port: `/` and asset types, `/api/health`, that S3 paths on the UI port answer 404, that HEAD has no body, and that a request with a foreign `Host` or `Origin` is refused.
- **Regression.** A full `verify` run against the S3 port must still pass every check, and `testmicros3`, the persistence, crash, static and Docker scripts must pass.

## Known gaps and later work

- Authentication, if the UI is ever exposed beyond a trusted network. Not planned.
- Pagination of very large buckets in the UI beyond "Load more".

## Status

The design is settled: UI1 to UI8, with the guards in UI6. The two listeners and the `--ui-port` setting are in place (U2, U3), the shared operation code is extracted (U4), the frontend scaffold in `ui/` is built and checked by the spike (U5), the typed API client is in `ui/src/api.ts` (U6), and the request guards run on every UI request, in `ui::guard` in `lib/ui_api.cpp` (U7). The bucket routes of the JSON API are in `UiService` (U8): health, list, create, details, delete, empty, and CORS get, set and remove. The object, upload and content routes are in place (U9, U10). Outside `/api/` the service serves the embedded files (U11), and `cmake/ui.cmake` with `cmake/embed_ui.cmake` builds and embeds them in every CMake build (U12). The app shell is in place (U14): the sidebar with the bucket list, search and New bucket, the top bar with the bucket name, tabs and theme choice, the custom breadcrumb, and toasts. Routes are hash routes, parsed in `ui/src/route.ts`. Below 900 px the sidebar starts hidden and lies over the page when shown, closed by Escape or a click outside it. The Buckets screen, the New bucket dialog (with the `valid_name` rules mirrored in `ui/src/bucketName.ts`) and deletion with "Empty and delete" work (U15). The Settings tab shows the region and default encryption, and edits CORS rules in a form that builds the S3 XML (`ui/src/cors.ts`), with Save and Remove; the Uploads tab lists uploads in progress, with "Load more" and Abort (U16). The Objects tab browses one level under the prefix in the route (U17): a breadcrumb, a filter on the start of names that is sent to the server with the prefix, a table of folders and objects with checkboxes on objects, and "Load more" in pages of 200 (`ui/src/components/ObjectsTab.tsx`, helpers in `ui/src/objects.ts`). Its actions are in place (U18): Upload (a File Input, uploads three at a time with progress and cancel), New folder, Delete selected in batches of 1,000 with per-key errors listed, and a row menu with Download, Copy or move (one dialog, with Copy and Move as its actions, reporting `MoveIncomplete`), and Delete (helpers in `ui/src/objectActions.ts`). The object drawer shows details, edits metadata in place and previews images and text (U19). The styling uses design tokens on `:root`, with shared loading, empty and error states and framed tables, in both themes (U20). The steps are in [todo.md](todo.md), under "Web UI".
