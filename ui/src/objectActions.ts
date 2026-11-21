// Pure helpers for the object actions (U18): upload keys, new folders,
// download names, delete batches and copy or move targets.

import { MAX_BATCH, type DeleteResult } from "./api"

/** S3's limit on a key: 1,024 bytes of UTF-8. */
export const MAX_KEY_BYTES = 1024

/** The length of `text` in UTF-8 bytes. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

/** Why `key` cannot be an object key, or null if it can. */
export function keyProblem(key: string): string | null {
  if (key === "") return "Enter a key."
  if (utf8Length(key) > MAX_KEY_BYTES) return `Keys are at most ${MAX_KEY_BYTES} bytes of UTF-8.`
  return null
}

/**
 * The key a file is uploaded as: the current folder's prefix and the
 * file's path. A file from a dropped folder keeps its path inside it.
 */
export function uploadKey(prefix: string, file: { name: string }, path?: string): string {
  const name = path && path !== "" ? path.replace(/^\/+/, "") : file.name
  return prefix + name
}

/**
 * The key of a new folder: a zero-byte object whose key is the prefix,
 * the name, and a `/`. The name may hold `/` to make nested folders, but
 * not start with one or have an empty part.
 */
export function folderKey(prefix: string, name: string): { key: string } | { error: string } {
  const trimmed = name.replace(/\/+$/, "")
  if (trimmed.trim() === "") return { error: "Enter a folder name." }
  if (trimmed.startsWith("/")) return { error: "A folder name cannot start with /." }
  if (trimmed.split("/").some((part) => part === "")) return { error: "A folder name cannot hold //." }
  const key = prefix + trimmed + "/"
  const problem = keyProblem(key)
  return problem ? { error: problem } : { key }
}

/** The file name a download is saved as: the last part of the key. */
export function downloadName(key: string): string {
  const parts = key.split("/").filter((p) => p !== "")
  return parts.length > 0 ? parts[parts.length - 1] : "download"
}

/** Splits `items` into batches of at most `size`, in order. */
export function batches<T>(items: readonly T[], size: number = MAX_BATCH): T[][] {
  if (size < 1) throw new RangeError("size must be at least 1")
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Joins the results of several delete batches into one. */
export function mergeDeleteResults(results: readonly DeleteResult[]): DeleteResult {
  return {
    deleted: results.flatMap((r) => r.deleted),
    errors: results.flatMap((r) => r.errors),
  }
}

/** Why a copy from `source` to `destination` cannot run, or null if it can. */
export function copyProblem(
  source: { bucket: string; key: string },
  destination: { bucket: string; key: string },
): string | null {
  if (destination.bucket === "") return "Choose a bucket."
  const problem = keyProblem(destination.key)
  if (problem) return problem
  if (destination.bucket === source.bucket && destination.key === source.key) {
    return "Choose another key or bucket; an object cannot be copied onto itself."
  }
  return null
}

/** The state of one file in the upload list. */
export type UploadStatus = "queued" | "uploading" | "done" | "failed" | "canceled"

export interface UploadItem {
  id: number
  file: File
  key: string
  status: UploadStatus
  loaded: number
  error?: string
}

/** Percent done of an item, 0 to 100. A zero-byte file is 100 once done. */
export function uploadPercent(item: Pick<UploadItem, "loaded" | "status"> & { file: { size: number } }): number {
  if (item.status === "done") return 100
  if (item.file.size === 0) return 0
  return Math.min(100, Math.round((item.loaded / item.file.size) * 100))
}

/** A summary of the upload list for its heading: "2 of 5 uploaded, 1 failed". */
export function uploadSummary(items: readonly Pick<UploadItem, "status">[]): string {
  const done = items.filter((i) => i.status === "done").length
  const failed = items.filter((i) => i.status === "failed").length
  const canceled = items.filter((i) => i.status === "canceled").length
  const parts = [`${done} of ${items.length} uploaded`]
  if (failed > 0) parts.push(`${failed} failed`)
  if (canceled > 0) parts.push(`${canceled} canceled`)
  return parts.join(", ")
}
