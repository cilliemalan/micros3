import { describe, expect, it } from "vitest"
import { formatRelative, formatSize } from "./format"

describe("formatSize", () => {
  it("formats bytes and binary units", () => {
    expect(formatSize(0)).toBe("0 B")
    expect(formatSize(1023)).toBe("1023 B")
    expect(formatSize(1024)).toBe("1 KB")
    expect(formatSize(1536)).toBe("1.5 KB")
    expect(formatSize(12 * 1024 * 1024)).toBe("12 MB")
    expect(formatSize(5 * 1024 ** 3)).toBe("5 GB")
    expect(formatSize(2048 * 1024 ** 4)).toBe("2048 TB")
  })
})

describe("formatRelative", () => {
  const now = Date.parse("2026-11-21T12:00:00Z")
  it("formats past and future times", () => {
    expect(formatRelative("2026-11-21T11:59:55Z", now)).toBe("just now")
    expect(formatRelative("2026-11-21T11:59:30Z", now)).toBe("30 seconds ago")
    expect(formatRelative("2026-11-21T11:55:00Z", now)).toBe("5 minutes ago")
    expect(formatRelative("2026-11-21T09:00:00Z", now)).toBe("3 hours ago")
    expect(formatRelative("2026-11-20T12:00:00Z", now)).toBe("yesterday")
    expect(formatRelative("2026-11-23T12:00:00Z", now)).toBe("in 2 days")
    expect(formatRelative("2024-11-21T12:00:00Z", now)).toBe("2 years ago")
  })

  it("returns text it cannot read unchanged", () => {
    expect(formatRelative("not a date", now)).toBe("not a date")
  })
})
