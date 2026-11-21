import { describe, expect, it } from "vitest"
import {
  MAX_KEY_BYTES,
  batches,
  copyProblem,
  downloadName,
  folderKey,
  keyProblem,
  mergeDeleteResults,
  uploadKey,
  uploadPercent,
  uploadSummary,
  utf8Length,
} from "./objectActions"

describe("keyProblem", () => {
  it("accepts ordinary and awkward keys", () => {
    for (const key of ["a", "a b/c%20d", "日本/ファイル.txt", "<script>x</script>", "/lead"]) {
      expect(keyProblem(key)).toBeNull()
    }
  })
  it("refuses an empty key", () => {
    expect(keyProblem("")).toMatch(/Enter/)
  })
  it("counts UTF-8 bytes, not characters", () => {
    expect(utf8Length("é")).toBe(2)
    expect(keyProblem("a".repeat(MAX_KEY_BYTES))).toBeNull()
    expect(keyProblem("a".repeat(MAX_KEY_BYTES + 1))).toMatch(/1024 bytes/)
    expect(keyProblem("é".repeat(513))).toMatch(/bytes/)
  })
})

describe("uploadKey", () => {
  it("puts the file name under the prefix", () => {
    expect(uploadKey("", { name: "a.txt" })).toBe("a.txt")
    expect(uploadKey("photos/2026/", { name: "my cat.jpg" })).toBe("photos/2026/my cat.jpg")
  })
  it("keeps a dropped folder's path", () => {
    expect(uploadKey("p/", { name: "x.txt" }, "dir/sub/x.txt")).toBe("p/dir/sub/x.txt")
    expect(uploadKey("p/", { name: "x.txt" }, "/dir/x.txt")).toBe("p/dir/x.txt")
    expect(uploadKey("p/", { name: "x.txt" }, "")).toBe("p/x.txt")
  })
})

describe("folderKey", () => {
  it("makes a key ending in /", () => {
    expect(folderKey("", "docs")).toEqual({ key: "docs/" })
    expect(folderKey("a/", "b c")).toEqual({ key: "a/b c/" })
    expect(folderKey("a/", "b/")).toEqual({ key: "a/b/" })
    expect(folderKey("", "x/y")).toEqual({ key: "x/y/" })
  })
  it("refuses empty, leading-slash and empty-part names", () => {
    expect(folderKey("", "")).toHaveProperty("error")
    expect(folderKey("", "  ")).toHaveProperty("error")
    expect(folderKey("", "/")).toHaveProperty("error")
    expect(folderKey("", "/x")).toHaveProperty("error")
    expect(folderKey("", "x//y")).toHaveProperty("error")
  })
  it("refuses a key that is too long", () => {
    expect(folderKey("a/", "b".repeat(MAX_KEY_BYTES))).toHaveProperty("error")
  })
})

describe("downloadName", () => {
  it("is the last part of the key", () => {
    expect(downloadName("a/b/c.txt")).toBe("c.txt")
    expect(downloadName("plain")).toBe("plain")
    expect(downloadName("dir/")).toBe("dir")
    expect(downloadName("日本/ファイル.txt")).toBe("ファイル.txt")
    expect(downloadName("/")).toBe("download")
  })
})

describe("batches", () => {
  it("splits into batches of 1,000 by default", () => {
    const keys = Array.from({ length: 2500 }, (_, i) => `k${i}`)
    const out = batches(keys)
    expect(out.map((b) => b.length)).toEqual([1000, 1000, 500])
    expect(out.flat()).toEqual(keys)
  })
  it("gives no batches for no items, one for exactly the size", () => {
    expect(batches([])).toEqual([])
    expect(batches([1, 2, 3], 3)).toEqual([[1, 2, 3]])
  })
  it("refuses a size below 1", () => {
    expect(() => batches([1], 0)).toThrow(RangeError)
  })
})

describe("mergeDeleteResults", () => {
  it("joins deleted keys and errors in order", () => {
    expect(
      mergeDeleteResults([
        { deleted: ["a"], errors: [] },
        { deleted: ["b"], errors: [{ key: "", code: "InvalidArgument", message: "empty" }] },
      ]),
    ).toEqual({ deleted: ["a", "b"], errors: [{ key: "", code: "InvalidArgument", message: "empty" }] })
  })
})

describe("copyProblem", () => {
  const source = { bucket: "b", key: "k" }
  it("allows another key or another bucket", () => {
    expect(copyProblem(source, { bucket: "b", key: "k2" })).toBeNull()
    expect(copyProblem(source, { bucket: "c", key: "k" })).toBeNull()
  })
  it("refuses a copy onto itself, no bucket, or a bad key", () => {
    expect(copyProblem(source, { bucket: "b", key: "k" })).toMatch(/itself/)
    expect(copyProblem(source, { bucket: "", key: "k" })).toMatch(/bucket/)
    expect(copyProblem(source, { bucket: "c", key: "" })).toMatch(/key/)
  })
})

describe("upload progress", () => {
  it("gives a percent from bytes sent", () => {
    expect(uploadPercent({ loaded: 50, status: "uploading", file: { size: 200 } })).toBe(25)
    expect(uploadPercent({ loaded: 300, status: "uploading", file: { size: 200 } })).toBe(100)
    expect(uploadPercent({ loaded: 0, status: "uploading", file: { size: 0 } })).toBe(0)
    expect(uploadPercent({ loaded: 0, status: "done", file: { size: 0 } })).toBe(100)
  })
  it("summarises the list", () => {
    expect(uploadSummary([{ status: "done" }, { status: "uploading" }])).toBe("1 of 2 uploaded")
    expect(
      uploadSummary([{ status: "done" }, { status: "failed" }, { status: "canceled" }, { status: "queued" }]),
    ).toBe("1 of 4 uploaded, 1 failed, 1 canceled")
  })
})
