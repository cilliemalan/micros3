// CORS rules for the Settings tab (U16): the form's model, its checks,
// and conversion to and from the S3 XML that PUT and GET
// /api/buckets/{bucket}/cors carry. The checks mirror cors::parse in
// lib/cors.cpp, so the form reports a problem before the server would.

/** The methods S3 allows in a CORS rule, in the order the form shows them. */
export const CORS_METHODS = ["GET", "PUT", "HEAD", "POST", "DELETE"] as const
export type CorsMethod = (typeof CORS_METHODS)[number]

/** At most this many rules in one configuration, as in S3. */
export const MAX_CORS_RULES = 100
/** Longest rule ID S3 accepts. */
export const MAX_ID_LENGTH = 255

export interface CorsRule {
  id?: string
  allowedOrigins: string[]
  allowedMethods: string[]
  allowedHeaders: string[]
  exposeHeaders: string[]
  maxAgeSeconds?: number
}

/** A rule as the form edits it: lists are one entry per line, numbers are text. */
export interface CorsRuleForm {
  id: string
  origins: string
  methods: string[]
  allowedHeaders: string
  exposeHeaders: string
  maxAge: string
}

export function emptyRuleForm(): CorsRuleForm {
  return { id: "", origins: "", methods: ["GET"], allowedHeaders: "", exposeHeaders: "", maxAge: "" }
}

/** Splits a text box into its non-empty, trimmed lines. */
export function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
}

export function ruleToForm(rule: CorsRule): CorsRuleForm {
  return {
    id: rule.id ?? "",
    origins: rule.allowedOrigins.join("\n"),
    methods: CORS_METHODS.filter((m) => rule.allowedMethods.includes(m)),
    allowedHeaders: rule.allowedHeaders.join("\n"),
    exposeHeaders: rule.exposeHeaders.join("\n"),
    maxAge: rule.maxAgeSeconds === undefined ? "" : String(rule.maxAgeSeconds),
  }
}

export function formToRule(form: CorsRuleForm): CorsRule {
  const rule: CorsRule = {
    allowedOrigins: lines(form.origins),
    allowedMethods: CORS_METHODS.filter((m) => form.methods.includes(m)),
    allowedHeaders: lines(form.allowedHeaders),
    exposeHeaders: lines(form.exposeHeaders),
  }
  const id = form.id.trim()
  if (id) rule.id = id
  const maxAge = form.maxAge.trim()
  if (maxAge) rule.maxAgeSeconds = Number(maxAge)
  return rule
}

export type RuleField = "id" | "origins" | "methods" | "allowedHeaders" | "maxAge"

/** The form's problems, by field. Empty if the rule can be saved. */
export function ruleProblems(form: CorsRuleForm): Partial<Record<RuleField, string>> {
  const problems: Partial<Record<RuleField, string>> = {}
  if (form.id.trim().length > MAX_ID_LENGTH) {
    problems.id = `An ID has at most ${MAX_ID_LENGTH} characters.`
  }
  const origins = lines(form.origins)
  if (origins.length === 0) {
    problems.origins = "Add at least one origin, such as http://localhost:5173 or *."
  } else {
    const bad = origins.find((o) => wildcards(o) > 1)
    if (bad) problems.origins = `"${bad}" has more than one *.`
  }
  if (form.methods.length === 0) problems.methods = "Choose at least one method."
  const badHeader = lines(form.allowedHeaders).find((h) => wildcards(h) > 1)
  if (badHeader) problems.allowedHeaders = `"${badHeader}" has more than one *.`
  const maxAge = form.maxAge.trim()
  if (maxAge && !/^\d+$/.test(maxAge)) {
    problems.maxAge = "Enter a whole number of seconds."
  } else if (maxAge && !Number.isSafeInteger(Number(maxAge))) {
    problems.maxAge = "That number is too large."
  }
  return problems
}

function wildcards(text: string): number {
  return text.split("*").length - 1
}

// ---------------------------------------------------------------------------
// XML

const NAMESPACE = "http://s3.amazonaws.com/doc/2006-03-01/"

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

export function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (whole, entity: string) => {
    switch (entity) {
      case "amp":
        return "&"
      case "lt":
        return "<"
      case "gt":
        return ">"
      case "quot":
        return '"'
      case "apos":
        return "'"
    }
    const code = entity.startsWith("#x") ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
    try {
      return String.fromCodePoint(code)
    } catch {
      return whole
    }
  })
}

/** Builds the CORSConfiguration XML body for PUT .../cors. */
export function buildCorsXml(rules: readonly CorsRule[]): string {
  const parts = [`<?xml version="1.0" encoding="UTF-8"?>`, `<CORSConfiguration xmlns="${NAMESPACE}">`]
  const element = (name: string, value: string) => parts.push(`    <${name}>${escapeXml(value)}</${name}>`)
  for (const rule of rules) {
    parts.push("  <CORSRule>")
    if (rule.id !== undefined) element("ID", rule.id)
    for (const origin of rule.allowedOrigins) element("AllowedOrigin", origin)
    for (const method of rule.allowedMethods) element("AllowedMethod", method)
    for (const header of rule.allowedHeaders) element("AllowedHeader", header)
    for (const header of rule.exposeHeaders) element("ExposeHeader", header)
    if (rule.maxAgeSeconds !== undefined) element("MaxAgeSeconds", String(rule.maxAgeSeconds))
    parts.push("  </CORSRule>")
  }
  parts.push("</CORSConfiguration>")
  return parts.join("\n") + "\n"
}

/**
 * Reads the CORSConfiguration XML that GET .../cors answers. The server
 * writes it itself (cors::serialize), so this reads that shape: elements
 * with text only, an optional namespace prefix, no CDATA. Unknown elements
 * are skipped.
 */
export function parseCorsXml(xml: string): CorsRule[] {
  const rules: CorsRule[] = []
  const ruleRe = /<(?:[\w.-]+:)?CORSRule\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?CORSRule\s*>/g
  const fieldRe = /<(?:[\w.-]+:)?(\w+)\b[^>]*?(?:\/>|>([^<]*)<\/(?:[\w.-]+:)?\1\s*>)/g
  for (const ruleMatch of xml.matchAll(ruleRe)) {
    const rule: CorsRule = { allowedOrigins: [], allowedMethods: [], allowedHeaders: [], exposeHeaders: [] }
    for (const field of ruleMatch[1].matchAll(fieldRe)) {
      const value = unescapeXml(field[2] ?? "").trim()
      switch (field[1]) {
        case "ID":
          rule.id = value
          break
        case "AllowedOrigin":
          rule.allowedOrigins.push(value)
          break
        case "AllowedMethod":
          rule.allowedMethods.push(value)
          break
        case "AllowedHeader":
          rule.allowedHeaders.push(value)
          break
        case "ExposeHeader":
          rule.exposeHeaders.push(value)
          break
        case "MaxAgeSeconds": {
          const seconds = Number(value)
          if (value !== "" && Number.isSafeInteger(seconds) && seconds >= 0) rule.maxAgeSeconds = seconds
          break
        }
      }
    }
    rules.push(rule)
  }
  return rules
}
