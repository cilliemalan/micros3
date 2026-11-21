// Tests for the frontend safety checks (U21). The source scan runs on the
// real src/, so `pnpm test` fails as soon as a forbidden construct appears,
// as the build does.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { checkDist, checkSources, findExternalUrls, findForbidden } from "./check-safety.mjs"

const uiDir = join(dirname(fileURLToPath(import.meta.url)), "..")

describe("checkSources", () => {
  it("finds nothing forbidden in the UI's own source", () => {
    expect(checkSources(uiDir)).toEqual([])
  })
})

describe("findForbidden", () => {
  it.each([
    "<div dangerouslySetInnerHTML={{ __html: text }} />",
    "element.innerHTML = text",
    "element.outerHTML = text",
    "element.insertAdjacentHTML('beforeend', text)",
    "range.createContextualFragment(text)",
    "new DOMParser().parseFromString(text, 'text/html')",
    "document.write(text)",
    "eval(code)",
    "const run = eval (code)",
    "new Function('return 1')",
    'setTimeout("go()", 10)',
    "window.open(url)",
    "window.location.assign(url)",
    "location.replace(url)",
    "window.location.href = url",
    "location = url",
    '<a href={url} target="_blank">',
    "<a target={'_blank'}>",
    "<a href={objectUrl(bucket, key)}>",
    "<iframe src={ objectUrl(bucket, key)} />",
  ])("refuses %s", (line) => {
    expect(findForbidden(line)).toHaveLength(1)
  })

  it.each([
    "window.location.hash = routeHash(route)",
    "parseRoute(window.location.hash)",
    "link.href = objectUrl(bucket, key)",
    "if (location.hash === '#/') go()",
    "const text = element.textContent",
    "retrieval(code)",
    "medieval(code)",
    "setTimeout(() => go(), 10)",
    "<pre>{text}</pre>",
  ])("allows %s", (line) => {
    expect(findForbidden(line)).toEqual([])
  })

  it("reports the line number and reason", () => {
    expect(findForbidden("const a = 1\nnode.innerHTML = a\n")).toEqual([
      { line: 2, text: "node.innerHTML = a", reason: "renders a string as HTML" },
    ])
  })
})

describe("findExternalUrls", () => {
  it("allows the namespace and message URLs that are never fetched", () => {
    const text = [
      '"http://www.w3.org/2000/svg"',
      '"http://www.w3.org/1999/xlink"',
      '"http://www.w3.org/XML/1998/namespace"',
      '"http://www.w3.org/1998/Math/MathML"',
      '"http://s3.amazonaws.com/doc/2006-03-01/"',
      '"https://react.dev/errors/"+e',
      '"http://localhost:5173\\nhttps://*.example.com"',
    ].join(";")
    expect(findExternalUrls(text)).toEqual([])
  })

  it("finds absolute URLs", () => {
    expect(findExternalUrls('fetch("https://cdn.example.net/x.js")')).toEqual(["https://cdn.example.net/x.js"])
    expect(findExternalUrls("a{background:url(http://evil.test/a.png)}")).toEqual(["http://evil.test/a.png"])
    // An allowed URL is matched exactly, not as a prefix.
    expect(findExternalUrls('"http://www.w3.org/2000/svg.evil.test/x"')).toEqual([
      "http://www.w3.org/2000/svg.evil.test/x",
    ])
  })

  it("finds protocol-relative references", () => {
    expect(findExternalUrls('<script src="//cdn.test/a.js"></script>')).toEqual(["//cdn.test/a.js"])
    expect(findExternalUrls("<link href='//cdn.test/a.css'>")).toEqual(["//cdn.test/a.css"])
    expect(findExternalUrls("a{background:url('//cdn.test/a.png')}")).toEqual(["//cdn.test/a.png"])
    expect(findExternalUrls('@import "//cdn.test/a.css";')).toEqual(["//cdn.test/a.css"])
  })

  it("allows same-origin references and data: icons", () => {
    expect(findExternalUrls('<script type="module" src="/assets/index-abc.js"></script>')).toEqual([])
    expect(findExternalUrls("a{mask:url(\"data:image/svg+xml,%3Csvg%3E\")}")).toEqual([])
    expect(findExternalUrls("// a comment")).toEqual([])
  })
})

describe("checkDist", () => {
  let dir = ""
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ""
  })

  it("names each file with an external URL", () => {
    dir = mkdtempSync(join(tmpdir(), "micros3-dist-"))
    mkdirSync(join(dir, "assets"))
    writeFileSync(join(dir, "index.html"), '<script src="/assets/a.js"></script>')
    writeFileSync(join(dir, "assets", "a.js"), 'import("https://cdn.test/b.js")')
    expect(checkDist(dir)).toEqual([join("assets", "a.js") + ": names an external URL: https://cdn.test/b.js"])
  })
})
