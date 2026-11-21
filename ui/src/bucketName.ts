// The bucket name rules of buckets::valid_name in lib/buckets.cpp,
// mirrored so the New bucket dialog can explain a bad name before
// sending it. The server still checks, so the two must agree.

const FORBIDDEN_PREFIXES = ["xn--", "sthree-", "amzn-s3-demo-"]
const FORBIDDEN_SUFFIXES = ["-s3alias", "--ol-s3", ".mrap", "--x-s3", "--table-s3"]

/** Returns why `name` is not a valid bucket name, or null if it is valid. */
export function bucketNameProblem(name: string): string | null {
  if (name.length < 3 || name.length > 63) return "Use 3 to 63 characters."
  if (!/^[a-z0-9.-]*$/.test(name)) {
    return "Use only lowercase letters, digits, dots (.) and hyphens (-)."
  }
  if (!/^[a-z0-9]/.test(name) || !/[a-z0-9]$/.test(name)) {
    return "Begin and end with a lowercase letter or a digit."
  }
  if (name.includes("..")) return "Do not use two dots in a row."
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) return "Do not use the form of an IP address."
  const prefix = FORBIDDEN_PREFIXES.find((p) => name.startsWith(p))
  if (prefix) return `Do not begin with "${prefix}".`
  const suffix = FORBIDDEN_SUFFIXES.find((s) => name.endsWith(s))
  if (suffix) return `Do not end with "${suffix}".`
  return null
}

/** The region a bucket gets when none is chosen, buckets::kDefaultRegion. */
export const DEFAULT_REGION = "us-east-1"

/** Regions offered in the New bucket dialog. The server accepts any valid_region name. */
export const REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ca-central-1",
  "sa-east-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-central-1",
  "eu-north-1",
  "eu-south-1",
  "af-south-1",
  "me-south-1",
  "ap-south-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-southeast-1",
  "ap-southeast-2",
] as const
