// Frontend safety checks (docs/todo.md U21, docs/UI.md "Security of the
// frontend"). CMake runs this after `vite build`, so either failure stops
// the build:
//
//   node scripts/check-safety.mjs <ui source dir> <dist dir>
//
// 1. The source under src/ (and index.html) never writes HTML into the page,
//    evaluates strings as code, or navigates the page away (object content
//    must never be opened on the UI origin).
// 2. The built files name no external URL, so the page loads nothing from
//    anywhere but the binary. A few URL strings are allowed because they are
//    identifiers, never fetched: XML namespace URIs and React's error text.
//
// The functions are exported for the Vitest tests in check-safety.test.ts.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { argv, exit } from "node:process"
import { fileURLToPath } from "node:url"

/** Constructs the source may not use, with the reason shown on a failure. */
export const forbiddenPatterns = [
  { pattern: /dangerouslySetInnerHTML/, reason: "renders a string as HTML" },
  { pattern: /\.(inner|outer)HTML\b/, reason: "renders a string as HTML" },
  { pattern: /\binsertAdjacentHTML\b/, reason: "renders a string as HTML" },
  { pattern: /\bcreateContextualFragment\b/, reason: "renders a string as HTML" },
  { pattern: /\bDOMParser\b/, reason: "parses a string as HTML" },
  { pattern: /\bdocument\.write(ln)?\b/, reason: "writes HTML into the page" },
  { pattern: /(?<![\w$.])eval\s*\(/, reason: "evaluates a string as code" },
  { pattern: /\bnew\s+Function\s*\(/, reason: "evaluates a string as code" },
  { pattern: /\bset(Timeout|Interval)\s*\(\s*["'`]/, reason: "evaluates a string as code" },
  { pattern: /\bwindow\.open\s*\(/, reason: "opens a URL in a window" },
  { pattern: /\blocation\.(assign|replace)\s*\(/, reason: "navigates the page" },
  { pattern: /\blocation(\.href)?\s*=(?!=)/, reason: "navigates the page" },
  { pattern: /target\s*=\s*\{?\s*["']_blank["']/, reason: "opens a link in a new window" },
  { pattern: /\b(href|src|action)=\{\s*objectUrl\b/, reason: "links the page to object content (use downloadObject)" },
]

/**
 * URL strings the built files may contain, matched exactly: identifiers and
 * text that are never fetched. The localhost and example.com origins are
 * examples shown in the CORS form.
 */
export const allowedUrls = [
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/1999/xhtml",
  "http://www.w3.org/XML/1998/namespace",
  "http://www.w3.org/1998/Math/MathML",
  "http://s3.amazonaws.com/doc/2006-03-01/",
  "https://react.dev/errors/",
  "http://localhost:5173",
  "https://*.example.com",
]

const sourceExtensions = /\.(ts|tsx|js|jsx|mjs|cjs|html|css)$/

/** Every file under `dir`, recursively, skipping node_modules. */
export function walk(dir) {
  const files = []
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules") continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) files.push(...walk(path))
    else files.push(path)
  }
  return files
}

/** The forbidden constructs in one file's text: [{line, text, reason}]. */
export function findForbidden(text) {
  const found = []
  text.split("\n").forEach((line, index) => {
    for (const { pattern, reason } of forbiddenPatterns) {
      if (pattern.test(line)) found.push({ line: index + 1, text: line.trim(), reason })
    }
  })
  return found
}

/**
 * The external URLs in one built file's text that are not allowed: absolute
 * http(s) URLs, and protocol-relative or absolute URLs in HTML src and href
 * attributes and in CSS url() and @import.
 */
export function findExternalUrls(text) {
  const found = new Set()
  for (const match of text.matchAll(/https?:\/\/[^\s"'`()<>\\]*/gi)) {
    const url = match[0]
    if (!allowedUrls.includes(url)) found.add(url)
  }
  const references = [
    /\b(?:src|href|action|srcset|poster)\s*=\s*["']?\s*(\/\/[^"'\s>]*)/gi,
    /url\(\s*["']?\s*(\/\/[^"')\s]*)/gi,
    /@import\s+(?:url\()?\s*["']?\s*(\/\/[^"')\s;]*)/gi,
  ]
  for (const pattern of references) {
    for (const match of text.matchAll(pattern)) found.add(match[1])
  }
  return [...found]
}

/** Problems in the source: index.html and every file under src/. */
export function checkSources(uiDir) {
  const files = [join(uiDir, "index.html"), ...walk(join(uiDir, "src"))]
  const problems = []
  for (const file of files) {
    if (!sourceExtensions.test(file)) continue
    for (const hit of findForbidden(readFileSync(file, "utf8"))) {
      problems.push(`${relative(uiDir, file)}:${hit.line}: ${hit.reason}: ${hit.text}`)
    }
  }
  return problems
}

/** Problems in the built output: any external URL in any file. */
export function checkDist(distDir) {
  const problems = []
  for (const file of walk(distDir)) {
    for (const url of findExternalUrls(readFileSync(file, "latin1"))) {
      problems.push(`${relative(distDir, file)}: names an external URL: ${url}`)
    }
  }
  return problems
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  if (argv.length !== 4) {
    console.error("usage: node check-safety.mjs <ui source dir> <dist dir>")
    exit(2)
  }
  const problems = [...checkSources(argv[2]), ...checkDist(argv[3])]
  if (problems.length > 0) {
    console.error("Frontend safety check failed (docs/UI.md, \"Security of the frontend\"):")
    for (const problem of problems) console.error(`  ${problem}`)
    exit(1)
  }
}
