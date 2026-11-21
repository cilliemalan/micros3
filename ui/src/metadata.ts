// The object drawer's metadata form and preview rules (U19). The form maps
// to and from the stored headers that GET and PUT .../meta carry, and its
// checks mirror the server's (`headers_from_body` in lib/ui_api.cpp), so
// most mistakes are caught before Save.

import { utf8Length } from "./objectActions"

/** The standard headers the form edits, with their stored names. */
export const STANDARD_HEADERS = [
  "Content-Type",
  "Cache-Control",
  "Content-Disposition",
  "Content-Encoding",
  "Content-Language",
  "Expires",
] as const

export type StandardHeader = (typeof STANDARD_HEADERS)[number]

/** The prefix of user metadata headers. */
export const USER_PREFIX = "x-amz-meta-"

/** S3's limit on user metadata: names (without the prefix) and values, in UTF-8 bytes. */
export const MAX_USER_METADATA_BYTES = 2048

export interface UserRow {
  /** A stable id for React keys. */
  id: number
  /** The name without `x-amz-meta-`. */
  name: string
  value: string
}

export interface MetaForm {
  standard: Record<StandardHeader, string>
  user: UserRow[]
}

let nextId = 1

/** A blank user metadata row. */
export function newUserRow(name = "", value = ""): UserRow {
  return { id: nextId++, name, value }
}

/** The form for an object's stored headers. Names match in any case. */
export function formFromHeaders(headers: Record<string, string>): MetaForm {
  const standard = Object.fromEntries(STANDARD_HEADERS.map((h) => [h, ""])) as Record<StandardHeader, string>
  const user: UserRow[] = []
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    const known = STANDARD_HEADERS.find((h) => h.toLowerCase() === lower)
    if (known) {
      standard[known] = value
    } else if (lower.startsWith(USER_PREFIX) && lower.length > USER_PREFIX.length) {
      user.push(newUserRow(lower.slice(USER_PREFIX.length), value))
    }
  }
  user.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { standard, user }
}

/** A user row left wholly blank is ignored, so an added row can stay empty. */
function blank(row: UserRow): boolean {
  return row.name.trim() === "" && row.value === ""
}

/**
 * The headers to send with PUT .../meta. Empty standard values are left
 * out, which removes them. User names are trimmed and lower-cased, as S3
 * stores them, and get the `x-amz-meta-` prefix.
 */
export function headersFromForm(form: MetaForm): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const name of STANDARD_HEADERS) {
    const value = form.standard[name]
    if (value !== "") headers[name] = value
  }
  for (const row of form.user) {
    if (blank(row)) continue
    headers[USER_PREFIX + row.name.trim().toLowerCase()] = row.value
  }
  return headers
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** True if `value` holds a byte a header value may not: a control character other than tab, or DEL. */
export function hasControl(value: string): boolean {
  return /[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)
}

export interface FormProblems {
  /** Per standard header. */
  standard: Partial<Record<StandardHeader, string>>
  /** Per user row id: a problem with its name or its value. */
  userName: Record<number, string>
  userValue: Record<number, string>
  /** A problem with the user metadata as a whole, such as its size. */
  user?: string
  /** True if any problem is set. */
  any: boolean
}

/** What would stop the form from saving, as the server would see it. */
export function formProblems(form: MetaForm): FormProblems {
  const problems: FormProblems = { standard: {}, userName: {}, userValue: {}, any: false }
  for (const name of STANDARD_HEADERS) {
    if (hasControl(form.standard[name])) problems.standard[name] = "Control characters are not allowed."
  }
  const seen = new Set<string>()
  let bytes = 0
  for (const row of form.user) {
    if (blank(row)) continue
    const name = row.name.trim().toLowerCase()
    if (name === "") {
      problems.userName[row.id] = "Enter a name."
    } else if (!TOKEN.test(name)) {
      problems.userName[row.id] = "Use letters, digits, - and _, with no spaces."
    } else if (seen.has(name)) {
      problems.userName[row.id] = "This name is used twice."
    }
    seen.add(name)
    if (hasControl(row.value)) problems.userValue[row.id] = "Control characters are not allowed."
    bytes += utf8Length(name) + utf8Length(row.value)
  }
  if (bytes > MAX_USER_METADATA_BYTES) {
    problems.user = `User metadata is ${bytes.toLocaleString("en")} bytes; at most ${MAX_USER_METADATA_BYTES.toLocaleString("en")} are allowed.`
  }
  problems.any =
    Object.keys(problems.standard).length > 0 ||
    Object.keys(problems.userName).length > 0 ||
    Object.keys(problems.userValue).length > 0 ||
    problems.user !== undefined
  return problems
}

/** True if the two header sets are the same, ignoring order and name case. */
export function sameHeaders(a: Record<string, string>, b: Record<string, string>): boolean {
  const norm = (h: Record<string, string>) =>
    Object.entries(h)
      .map(([n, v]) => [n.toLowerCase(), v] as const)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
}

// ---------------------------------------------------------------------------
// Preview

/** Text is previewed up to this size. */
export const MAX_TEXT_PREVIEW = 1024 * 1024
/** Images are previewed up to this size, so opening the drawer never pulls a huge file. */
export const MAX_IMAGE_PREVIEW = 20 * 1024 * 1024

export type Preview =
  | { kind: "image" }
  | { kind: "text" }
  | { kind: "none"; reason: string }

/** The media type of a Content-Type value, lower-cased and without parameters. */
export function mediaType(contentType: string | undefined): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase()
}

/**
 * How an object is previewed: images through a `blob:` URL, text as text
 * (never as HTML), and nothing else. Text is `text/*`, JSON (`+json`
 * included) and XML; HTML among them is shown as its source.
 */
export function previewFor(contentType: string | undefined, size: number): Preview {
  const type = mediaType(contentType)
  if (type.startsWith("image/")) {
    if (size > MAX_IMAGE_PREVIEW) return { kind: "none", reason: "The image is too large to preview." }
    return { kind: "image" }
  }
  const text =
    type.startsWith("text/") ||
    type === "application/json" ||
    type.endsWith("+json") ||
    type === "application/xml" ||
    type.endsWith("+xml")
  if (text) {
    if (size > MAX_TEXT_PREVIEW) return { kind: "none", reason: "Text over 1 MiB is not previewed." }
    return { kind: "text" }
  }
  return { kind: "none", reason: type ? `No preview for ${type}.` : "No preview without a Content-Type." }
}
