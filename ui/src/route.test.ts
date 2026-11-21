import { describe, expect, it } from "vitest"
import { bucketRoute, crumbs, parseRoute, routeHash } from "./route"

describe("parseRoute", () => {
  it("reads the bucket list from an empty or unknown hash", () => {
    for (const hash of ["", "#", "#/", "#/nope", "#/buckets", "#/buckets/b/x", "#/buckets/b/objects/extra"]) {
      expect(parseRoute(hash)).toEqual({ page: "buckets" })
    }
  })

  it("reads a bucket page, defaulting to the objects tab", () => {
    expect(parseRoute("#/buckets/photos")).toEqual(bucketRoute("photos"))
    expect(parseRoute("#/buckets/photos/uploads")).toEqual(bucketRoute("photos", "uploads"))
    expect(parseRoute("#/buckets/photos/settings")).toEqual(bucketRoute("photos", "settings"))
  })

  it("reads the prefix on the objects tab only", () => {
    expect(parseRoute("#/buckets/photos/objects?prefix=2026%2F")).toEqual(bucketRoute("photos", "objects", "2026/"))
    expect(parseRoute("#/buckets/photos/uploads?prefix=a")).toEqual(bucketRoute("photos", "uploads"))
  })

  it("refuses a malformed escape in the bucket name", () => {
    expect(parseRoute("#/buckets/%E0/objects")).toEqual({ page: "buckets" })
  })
})

describe("routeHash", () => {
  it("round-trips awkward prefixes", () => {
    for (const prefix of ["", "a/", "with space/", "100%/", "a&b=c#d/", "naïve/日本/", "<script>/"]) {
      const route = bucketRoute("my.bucket-1", "objects", prefix)
      expect(parseRoute(routeHash(route))).toEqual(route)
    }
  })

  it("writes the bucket list and the other tabs without a query", () => {
    expect(routeHash({ page: "buckets" })).toBe("#/")
    expect(routeHash(bucketRoute("b", "settings", "ignored/"))).toBe("#/buckets/b/settings")
    expect(routeHash(bucketRoute("b"))).toBe("#/buckets/b/objects")
  })
})

describe("crumbs", () => {
  it("starts with the bucket root", () => {
    expect(crumbs("b", "")).toEqual([{ label: "b", prefix: "" }])
  })

  it("gives one crumb per folder", () => {
    expect(crumbs("b", "a/b c/")).toEqual([
      { label: "b", prefix: "" },
      { label: "a", prefix: "a/" },
      { label: "b c", prefix: "a/b c/" },
    ])
  })

  it("keeps a trailing part without a slash, and names empty folders", () => {
    expect(crumbs("b", "a//x")).toEqual([
      { label: "b", prefix: "" },
      { label: "a", prefix: "a/" },
      { label: "/", prefix: "a//" },
      { label: "x", prefix: "a//x" },
    ])
  })
})
