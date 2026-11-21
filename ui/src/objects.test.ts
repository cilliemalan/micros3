import { describe, expect, it } from "vitest"
import type { ObjectSummary } from "./api"
import { countText, displayEtag, emptyText, entryName, listPrefix, mergeRows, pageRows } from "./objects"

const obj = (key: string): ObjectSummary => ({ key, size: 1, etag: '"e"', lastModified: "2026-01-01T00:00:00.000Z" })

describe("listPrefix", () => {
  it("adds the filter to the folder prefix", () => {
    expect(listPrefix("", "")).toBe("")
    expect(listPrefix("a/b/", "")).toBe("a/b/")
    expect(listPrefix("a/b/", "rep")).toBe("a/b/rep")
    expect(listPrefix("", "100% <script>")).toBe("100% <script>")
  })
})

describe("entryName", () => {
  it("drops the folder prefix", () => {
    expect(entryName("a/b/c.txt", "a/b/")).toBe("c.txt")
    expect(entryName("a/b/c/", "a/b/")).toBe("c/")
    expect(entryName("top.txt", "")).toBe("top.txt")
    expect(entryName("ünï/cödé", "ünï/")).toBe("cödé")
  })

  it("keeps a key outside the prefix whole", () => {
    expect(entryName("x/y", "a/")).toBe("x/y")
  })
})

describe("pageRows", () => {
  it("hides the folder's own marker object", () => {
    const rows = pageRows({ folders: ["a/b/"], objects: [obj("a/"), obj("a/x")] }, "a/")
    expect(rows.folders).toEqual(["a/b/"])
    expect(rows.objects.map((o) => o.key)).toEqual(["a/x"])
  })

  it("keeps everything at the bucket root", () => {
    expect(pageRows({ folders: [], objects: [obj("x")] }, "").objects).toHaveLength(1)
  })
})

describe("mergeRows", () => {
  it("appends a page and drops repeats", () => {
    const merged = mergeRows(
      { folders: ["a/"], objects: [obj("b")] },
      { folders: ["a/", "c/"], objects: [obj("b"), obj("d")] },
    )
    expect(merged.folders).toEqual(["a/", "c/"])
    expect(merged.objects.map((o) => o.key)).toEqual(["b", "d"])
  })
})

describe("countText", () => {
  it("counts folders and objects", () => {
    expect(countText({ folders: [], objects: [] }, false)).toBe("0 objects")
    expect(countText({ folders: [], objects: [obj("a")] }, false)).toBe("1 object")
    expect(countText({ folders: ["a/"], objects: [] }, false)).toBe("1 folder")
    expect(countText({ folders: ["a/", "b/"], objects: [obj("a"), obj("b")] }, false)).toBe("2 folders, 2 objects")
  })

  it("marks that more pages remain", () => {
    expect(countText({ folders: [], objects: [obj("a")] }, true)).toBe("1+ objects")
  })
})

describe("displayEtag", () => {
  it("drops surrounding quotes only", () => {
    expect(displayEtag('"abc"')).toBe("abc")
    expect(displayEtag('"abc-3"')).toBe("abc-3")
    expect(displayEtag("abc")).toBe("abc")
    expect(displayEtag('"')).toBe('"')
  })
})

describe("emptyText", () => {
  it("names the bucket, the folder, or the filter", () => {
    expect(emptyText("", "")).toBe("This bucket is empty.")
    expect(emptyText("a/", "")).toBe("This folder is empty.")
    expect(emptyText("a/", "x")).toBe('No names in this folder start with "x".')
    expect(emptyText("", "x")).toBe('No names in this bucket start with "x".')
  })
})
