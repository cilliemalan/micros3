import { describe, expect, it } from "vitest"
import { bucketNameProblem } from "./bucketName"

// The same cases as the valid_name tests in the C++ suite.
describe("bucketNameProblem", () => {
  it("accepts valid names", () => {
    for (const name of ["abc", "my-bucket", "my.bucket.1", "a".repeat(63), "1.2.3", "1.2.3.4a", "xn-a"]) {
      expect(bucketNameProblem(name), name).toBeNull()
    }
  })

  it("refuses names that are too short or too long", () => {
    expect(bucketNameProblem("ab")).toMatch(/3 to 63/)
    expect(bucketNameProblem("a".repeat(64))).toMatch(/3 to 63/)
  })

  it("refuses other characters", () => {
    for (const name of ["MyBucket", "my_bucket", "my bucket", "bücket"]) {
      expect(bucketNameProblem(name), name).toMatch(/lowercase/)
    }
  })

  it("refuses names that begin or end with a dot or hyphen", () => {
    for (const name of ["-abc", "abc-", ".abc", "abc."]) {
      expect(bucketNameProblem(name), name).toMatch(/Begin and end/)
    }
  })

  it("refuses two dots, IP addresses, and reserved prefixes and suffixes", () => {
    expect(bucketNameProblem("a..b")).toMatch(/two dots/)
    expect(bucketNameProblem("192.168.5.4")).toMatch(/IP address/)
    expect(bucketNameProblem("xn--abc")).toMatch(/xn--/)
    expect(bucketNameProblem("sthree-abc")).toMatch(/sthree-/)
    expect(bucketNameProblem("amzn-s3-demo-x")).toMatch(/amzn-s3-demo-/)
    for (const suffix of ["-s3alias", "--ol-s3", ".mrap", "--x-s3", "--table-s3"]) {
      expect(bucketNameProblem(`abc${suffix}`), suffix).toContain(suffix)
    }
  })
})
