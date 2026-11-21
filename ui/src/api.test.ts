import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ApiError,
  MAX_BATCH,
  api,
  apiUrl,
  bucketUrl,
  isApiError,
  objectUrl,
  parseError,
  request,
  uploadObject,
} from "./api"

type Call = { url: string; init: RequestInit }

function stubFetch(...responses: (Response | Error)[]): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      const next = responses.shift()
      if (!next) throw new Error("unexpected fetch")
      if (next instanceof Error) throw next
      return next
    }),
  )
  return calls
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** Decodes the `key` query parameter the way the server will. */
function keyOf(url: string): string | null {
  return new URL(url, "http://localhost:3924").searchParams.get("key")
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("URL helpers", () => {
  it("encodes each path segment", () => {
    expect(apiUrl(["buckets"])).toBe("/api/buckets")
    expect(bucketUrl("my-bucket")).toBe("/api/buckets/my-bucket")
    expect(bucketUrl("my-bucket", "objects")).toBe("/api/buckets/my-bucket/objects")
    expect(apiUrl(["buckets", "a/b?c"])).toBe("/api/buckets/a%2Fb%3Fc")
  })

  it("leaves out undefined and null query values", () => {
    expect(apiUrl(["x"], { a: "1", b: undefined, c: null, d: 0, e: false })).toBe(
      "/api/x?a=1&d=0&e=false",
    )
    expect(apiUrl(["x"], { a: undefined })).toBe("/api/x")
  })

  it.each([
    "plain.txt",
    "with space.txt",
    "100%.txt",
    "%2F",
    "a/b/c/",
    "/leading",
    "a+b=c&d#e?f",
    "ünïcødé/文件.txt",
    "<script>alert(1)</script>",
    " ",
  ])("puts key %j in the key parameter, never the path", (key) => {
    const url = objectUrl("b", key)
    expect(url.startsWith("/api/buckets/b/object?key=")).toBe(true)
    expect(keyOf(url)).toBe(key)
    expect(new URL(url, "http://localhost").pathname).toBe("/api/buckets/b/object")
    expect(keyOf(objectUrl("b", key, "meta"))).toBe(key)
  })
})

describe("parseError", () => {
  it("reads the JSON error shape", () => {
    const error = parseError(404, '{"error":{"code":"NoSuchBucket","message":"Gone."}}')
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 404, code: "NoSuchBucket", message: "Gone." })
  })

  it("uses the code as the message if there is none", () => {
    expect(parseError(409, '{"error":{"code":"BucketNotEmpty"}}').message).toBe("BucketNotEmpty")
  })

  it.each(["", "<html>oops</html>", "null", '{"error":"x"}', '{"error":{"message":"m"}}'])(
    "falls back to the status for body %j",
    (body) => {
      const error = parseError(502, body, "Bad Gateway")
      expect(error).toMatchObject({ status: 502, code: "Http502", message: "Bad Gateway" })
    },
  )

  it("has a message without a status text", () => {
    expect(parseError(500, "").message).toBe("Request failed with status 500")
  })
})

describe("request", () => {
  it("parses a JSON reply", async () => {
    const calls = stubFetch(json(200, { status: "ok" }))
    await expect(api.health()).resolves.toEqual({ status: "ok" })
    expect(calls[0].url).toBe("/api/health")
    expect(calls[0].init.method).toBe("GET")
  })

  it("gives undefined for an empty reply", async () => {
    stubFetch(new Response(null, { status: 204 }))
    await expect(request("/api/x")).resolves.toBeUndefined()
  })

  it("sends JSON bodies with a content type", async () => {
    const calls = stubFetch(json(200, { name: "b", region: "us-east-1", created: "t" }))
    await api.createBucket("b", "us-east-1")
    expect(calls[0].url).toBe("/api/buckets")
    expect(calls[0].init.method).toBe("POST")
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    )
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ name: "b", region: "us-east-1" })
  })

  it("throws a typed error for an error reply", async () => {
    stubFetch(json(409, { error: { code: "BucketNotEmpty", message: "Not empty." } }))
    const error = await api.deleteBucket("b").catch((e: unknown) => e)
    expect(isApiError(error)).toBe(true)
    expect(isApiError(error, "BucketNotEmpty")).toBe(true)
    expect(isApiError(error, "NoSuchBucket")).toBe(false)
    expect(error).toMatchObject({ status: 409, code: "BucketNotEmpty", message: "Not empty." })
  })

  it("throws NetworkError when the server cannot be reached", async () => {
    stubFetch(new TypeError("Failed to fetch"))
    await expect(api.health()).rejects.toMatchObject({ status: 0, code: "NetworkError" })
  })

  it("passes an abort through unchanged", async () => {
    stubFetch(new DOMException("aborted", "AbortError"))
    await expect(api.health()).rejects.toMatchObject({ name: "AbortError" })
  })

  it("throws InvalidResponse for a 2xx reply that is not JSON", async () => {
    stubFetch(new Response("<html>", { status: 200 }))
    await expect(api.health()).rejects.toMatchObject({ code: "InvalidResponse" })
  })

  it("is not fooled by isApiError on other errors", () => {
    expect(isApiError(new Error("x"))).toBe(false)
    expect(isApiError({ code: "NoSuchBucket" })).toBe(false)
  })
})

describe("endpoints", () => {
  it("lists buckets", async () => {
    const buckets = [{ name: "a", region: "us-east-1", created: "2026-01-01T00:00:00Z" }]
    stubFetch(json(200, { buckets }))
    await expect(api.listBuckets()).resolves.toEqual(buckets)
  })

  it("lists one level with a default delimiter", async () => {
    const calls = stubFetch(
      json(200, { folders: [], objects: [] }),
      json(200, { folders: [], objects: [] }),
    )
    await api.listObjects("b")
    await api.listObjects("b", { prefix: "a b/", after: "a b/x", limit: 50 })
    expect(calls[0].url).toBe("/api/buckets/b/objects?delimiter=%2F")
    const params = new URL(calls[1].url, "http://localhost").searchParams
    expect(params.get("prefix")).toBe("a b/")
    expect(params.get("after")).toBe("a b/x")
    expect(params.get("limit")).toBe("50")
    expect(params.get("delimiter")).toBe("/")
  })

  it("puts metadata as {headers}", async () => {
    const calls = stubFetch(json(200, {}))
    await api.putMeta("b", "dir/ä.txt", { "Content-Type": "text/plain" })
    expect(calls[0].init.method).toBe("PUT")
    expect(keyOf(calls[0].url)).toBe("dir/ä.txt")
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      headers: { "Content-Type": "text/plain" },
    })
  })

  it("deletes a batch, and refuses more than MAX_BATCH keys without a request", async () => {
    const calls = stubFetch(json(200, { deleted: ["a"], errors: [] }))
    await expect(api.deleteObjects("b", ["a"])).resolves.toEqual({ deleted: ["a"], errors: [] })
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ keys: ["a"] })
    const keys = Array.from({ length: MAX_BATCH + 1 }, (_, i) => `k${i}`)
    await expect(api.deleteObjects("b", keys)).rejects.toMatchObject({ code: "TooManyKeys" })
    expect(calls).toHaveLength(1)
  })

  it("copies with move", async () => {
    const calls = stubFetch(json(200, {}))
    const copy = { source: { bucket: "a", key: "x" }, destination: { bucket: "b", key: "y" }, move: true }
    await api.copyObject("a", copy)
    expect(calls[0].url).toBe("/api/buckets/a/copy")
    expect(JSON.parse(calls[0].init.body as string)).toEqual(copy)
  })

  it("reads and writes CORS as XML", async () => {
    const xml = "<CORSConfiguration><CORSRule/></CORSConfiguration>"
    const calls = stubFetch(
      new Response(xml, { status: 200, headers: { "Content-Type": "application/xml" } }),
      new Response(null, { status: 204 }),
      json(404, { error: { code: "NoSuchCORSConfiguration", message: "None." } }),
    )
    await expect(api.getCors("b")).resolves.toBe(xml)
    await api.putCors("b", xml)
    expect(calls[1].init.body).toBe(xml)
    expect((calls[1].init.headers as Record<string, string>)["Content-Type"]).toBe("application/xml")
    await expect(api.getCors("b")).rejects.toMatchObject({ code: "NoSuchCORSConfiguration" })
  })

  it("aborts an upload by key and upload ID", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }))
    await api.abortUpload("b", "a&b", "id=1")
    expect(calls[0].init.method).toBe("DELETE")
    const params = new URL(calls[0].url, "http://localhost").searchParams
    expect(params.get("key")).toBe("a&b")
    expect(params.get("uploadId")).toBe("id=1")
  })
})

// A minimal XMLHttpRequest stand-in, enough for uploadObject.
class FakeXhr {
  static last: FakeXhr | undefined
  method = ""
  url = ""
  headers: Record<string, string> = {}
  body: unknown
  status = 0
  statusText = ""
  responseText = ""
  aborted = false
  private listeners: Record<string, (() => void)[]> = {}
  private uploadListeners: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void)[] = []
  upload = {
    addEventListener: (_: string, fn: (typeof this.uploadListeners)[number]) => {
      this.uploadListeners.push(fn)
    },
  }
  constructor() {
    FakeXhr.last = this
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }
  addEventListener(type: string, fn: () => void) {
    ;(this.listeners[type] ??= []).push(fn)
  }
  send(body: unknown) {
    this.body = body
  }
  abort() {
    this.aborted = true
    this.fire("abort")
  }
  progress(loaded: number, total: number) {
    for (const fn of this.uploadListeners) fn({ loaded, total, lengthComputable: true })
  }
  respond(status: number, text: string) {
    this.status = status
    this.responseText = text
    this.fire("load")
  }
  fire(type: string) {
    for (const fn of this.listeners[type] ?? []) fn()
  }
}

describe("uploadObject", () => {
  function setup() {
    FakeXhr.last = undefined
    vi.stubGlobal("XMLHttpRequest", FakeXhr)
  }

  it("PUTs the body to the key with headers and reports progress", async () => {
    setup()
    const progress: [number, number][] = []
    const blob = new Blob(["hello"], { type: "text/plain" })
    const done = uploadObject("b", "dir/a b.txt", blob, {
      headers: { "x-amz-meta-owner": "me" },
      onProgress: (loaded, total) => progress.push([loaded, total]),
    })
    const xhr = FakeXhr.last!
    expect(xhr.method).toBe("PUT")
    expect(keyOf(xhr.url)).toBe("dir/a b.txt")
    expect(xhr.headers["Content-Type"]).toBe("text/plain")
    expect(xhr.headers["x-amz-meta-owner"]).toBe("me")
    expect(xhr.body).toBe(blob)
    xhr.progress(2, 5)
    xhr.respond(200, JSON.stringify({ key: "dir/a b.txt", size: 5, etag: '"e"', lastModified: "t" }))
    await expect(done).resolves.toMatchObject({ key: "dir/a b.txt", size: 5 })
    expect(progress).toEqual([[2, 5]])
  })

  it("defaults the content type to application/octet-stream", () => {
    setup()
    void uploadObject("b", "k", new Blob(["x"]))
    expect(FakeXhr.last!.headers["Content-Type"]).toBe("application/octet-stream")
  })

  it("rejects with the typed error on an error reply", async () => {
    setup()
    const done = uploadObject("b", "k", new Blob(["x"]))
    FakeXhr.last!.respond(400, '{"error":{"code":"EntityTooLarge","message":"Too big."}}')
    await expect(done).rejects.toMatchObject({ status: 400, code: "EntityTooLarge" })
  })

  it("rejects with NetworkError when the request fails", async () => {
    setup()
    const done = uploadObject("b", "k", new Blob(["x"]))
    FakeXhr.last!.fire("error")
    await expect(done).rejects.toMatchObject({ code: "NetworkError" })
  })

  it("aborts through the signal", async () => {
    setup()
    const controller = new AbortController()
    const done = uploadObject("b", "k", new Blob(["x"]), { signal: controller.signal })
    controller.abort()
    await expect(done).rejects.toMatchObject({ name: "AbortError" })
    expect(FakeXhr.last!.aborted).toBe(true)
  })

  it("does not start when the signal is already aborted", async () => {
    setup()
    const controller = new AbortController()
    controller.abort()
    await expect(
      uploadObject("b", "k", new Blob(["x"]), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(FakeXhr.last).toBeUndefined()
  })
})
