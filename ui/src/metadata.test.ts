import { describe, expect, it } from "vitest"
import {
  MAX_TEXT_PREVIEW,
  MAX_USER_METADATA_BYTES,
  formFromHeaders,
  formProblems,
  hasControl,
  headersFromForm,
  mediaType,
  newUserRow,
  previewFor,
  sameHeaders,
  type MetaForm,
} from "./metadata"

function form(user: [string, string][] = [], standard: Partial<MetaForm["standard"]> = {}): MetaForm {
  const base = formFromHeaders({})
  return { standard: { ...base.standard, ...standard }, user: user.map(([n, v]) => newUserRow(n, v)) }
}

describe("formFromHeaders", () => {
  it("maps standard headers in any case and user metadata without the prefix", () => {
    const f = formFromHeaders({
      "content-type": "text/plain",
      "Cache-Control": "no-cache",
      EXPIRES: "Wed, 21 Oct 2026 07:28:00 GMT",
      "x-amz-meta-zeta": "z",
      "X-Amz-Meta-Alpha": "a",
    })
    expect(f.standard["Content-Type"]).toBe("text/plain")
    expect(f.standard["Cache-Control"]).toBe("no-cache")
    expect(f.standard.Expires).toBe("Wed, 21 Oct 2026 07:28:00 GMT")
    expect(f.standard["Content-Disposition"]).toBe("")
    expect(f.user.map((r) => [r.name, r.value])).toEqual([
      ["alpha", "a"],
      ["zeta", "z"],
    ])
  })
  it("gives each row its own id", () => {
    const f = formFromHeaders({ "x-amz-meta-a": "1", "x-amz-meta-b": "2" })
    expect(f.user[0].id).not.toBe(f.user[1].id)
  })
  it("ignores headers it cannot store", () => {
    const f = formFromHeaders({ "x-amz-meta-": "x", ETag: "y" })
    expect(f.user).toEqual([])
  })
})

describe("headersFromForm", () => {
  it("leaves out empty standard values and blank rows", () => {
    const f = form([["", ""]], { "Content-Type": "image/png", "Content-Language": "" })
    expect(headersFromForm(f)).toEqual({ "Content-Type": "image/png" })
  })
  it("trims and lower-cases user names and adds the prefix", () => {
    const f = form([[" Owner ", "Ann Lee"], ["empty", ""]])
    expect(headersFromForm(f)).toEqual({ "x-amz-meta-owner": "Ann Lee", "x-amz-meta-empty": "" })
  })
  it("round-trips the stored headers", () => {
    const stored = {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": 'attachment; filename="a b.txt"',
      "Content-Encoding": "gzip",
      "x-amz-meta-note": "<script>alert(1)</script> ünïcode",
    }
    expect(headersFromForm(formFromHeaders(stored))).toEqual(stored)
  })
})

describe("formProblems", () => {
  it("accepts a valid form", () => {
    expect(formProblems(form([["owner", "ann"]], { "Cache-Control": "max-age=60" })).any).toBe(false)
  })
  it("refuses control characters in values, but allows tabs", () => {
    expect(hasControl("a\tb")).toBe(false)
    expect(hasControl("a\nb")).toBe(true)
    expect(hasControl("a\u007fb")).toBe(true)
    const p = formProblems(form([["x", "a\rb"]], { "Content-Type": "text/plain\n" }))
    expect(p.any).toBe(true)
    expect(p.standard["Content-Type"]).toMatch(/Control/)
    expect(Object.values(p.userValue)[0]).toMatch(/Control/)
  })
  it("refuses a value with no name, a bad name and a repeated name", () => {
    const f = form([
      ["", "orphan"],
      ["has space", "1"],
      ["Dup", "1"],
      ["dup", "2"],
    ])
    const p = formProblems(f)
    expect(p.userName[f.user[0].id]).toMatch(/Enter a name/)
    expect(p.userName[f.user[1].id]).toMatch(/letters/)
    expect(p.userName[f.user[2].id]).toBeUndefined()
    expect(p.userName[f.user[3].id]).toMatch(/twice/)
  })
  it("refuses user metadata over 2 KB, counted in UTF-8 without the prefix", () => {
    expect(formProblems(form([["k", "v".repeat(MAX_USER_METADATA_BYTES - 1)]])).user).toBeUndefined()
    expect(formProblems(form([["k", "v".repeat(MAX_USER_METADATA_BYTES)]])).user).toMatch(/2,048/)
    expect(formProblems(form([["k", "é".repeat(1024)]])).user).toMatch(/2,049 bytes/)
  })
})

describe("sameHeaders", () => {
  it("ignores order and name case", () => {
    expect(sameHeaders({ A: "1", "x-amz-meta-b": "2" }, { "x-amz-meta-b": "2", a: "1" })).toBe(true)
    expect(sameHeaders({ A: "1" }, { A: "2" })).toBe(false)
    expect(sameHeaders({ A: "1" }, { A: "1", B: "" })).toBe(false)
  })
})

describe("previewFor", () => {
  it("reads the media type without parameters", () => {
    expect(mediaType(" Text/Plain; charset=UTF-8")).toBe("text/plain")
    expect(mediaType(undefined)).toBe("")
  })
  it("previews images", () => {
    expect(previewFor("image/png", 10).kind).toBe("image")
    expect(previewFor("image/svg+xml", 10).kind).toBe("image")
  })
  it("previews text, JSON and XML up to 1 MiB", () => {
    for (const type of ["text/plain", "text/html", "application/json", "application/ld+json", "application/xml"]) {
      expect(previewFor(type, MAX_TEXT_PREVIEW).kind).toBe("text")
    }
    const big = previewFor("text/plain", MAX_TEXT_PREVIEW + 1)
    expect(big.kind).toBe("none")
  })
  it("previews nothing else", () => {
    expect(previewFor("application/octet-stream", 1)).toEqual({
      kind: "none",
      reason: "No preview for application/octet-stream.",
    })
    expect(previewFor(undefined, 1).kind).toBe("none")
    expect(previewFor("application/pdf", 1).kind).toBe("none")
  })
})
