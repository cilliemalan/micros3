// Pure helpers for the object browser (U17): one level of a bucket,
// listed with delimiter "/", filtered by a key prefix typed by the user,
// and paged with "Load more".

import type { ObjectListing, ObjectSummary } from "./api"

/** Rows shown at a time; "Load more" asks for the next page of this size. */
export const PAGE_SIZE = 200

/**
 * The prefix sent to the server: the folder's prefix and the filter text.
 * The filter matches the start of names in the folder, as in S3 consoles,
 * so it works across pages instead of only on the rows already loaded.
 */
export function listPrefix(prefix: string, filter: string): string {
  return prefix + filter
}

/** A key or folder prefix as shown inside the folder `prefix`: the part after it. */
export function entryName(key: string, prefix: string): string {
  return key.startsWith(prefix) ? key.slice(prefix.length) : key
}

export interface Rows {
  folders: string[]
  objects: ObjectSummary[]
}

/**
 * The rows of one listed page in the folder `prefix`. The folder's own
 * marker object (a zero-byte key equal to the prefix, as made by
 * "New folder") is not shown, since it would have an empty name.
 */
export function pageRows(page: ObjectListing, prefix: string): Rows {
  return {
    folders: page.folders,
    objects: prefix ? page.objects.filter((o) => o.key !== prefix) : page.objects,
  }
}

/** Appends a further page, dropping any row already shown. */
export function mergeRows(shown: Rows, page: Rows): Rows {
  const folders = new Set(shown.folders)
  const keys = new Set(shown.objects.map((o) => o.key))
  return {
    folders: [...shown.folders, ...page.folders.filter((f) => !folders.has(f))],
    objects: [...shown.objects, ...page.objects.filter((o) => !keys.has(o.key))],
  }
}

/** The text above the table: "3 folders, 12 objects", with "+" while more pages remain. */
export function countText(rows: Rows, more: boolean): string {
  const plus = more ? "+" : ""
  const parts: string[] = []
  if (rows.folders.length > 0) {
    parts.push(`${rows.folders.length}${plus} ${rows.folders.length === 1 && !more ? "folder" : "folders"}`)
  }
  if (rows.objects.length > 0 || parts.length === 0) {
    parts.push(`${rows.objects.length}${plus} ${rows.objects.length === 1 && !more ? "object" : "objects"}`)
  }
  return parts.join(", ")
}

/** The ETag as shown: without the quotes S3 keeps around it. */
export function displayEtag(etag: string): string {
  return etag.length >= 2 && etag.startsWith('"') && etag.endsWith('"') ? etag.slice(1, -1) : etag
}

/** The message for an empty listing. */
export function emptyText(prefix: string, filter: string): string {
  if (filter) return `No names in this ${prefix ? "folder" : "bucket"} start with "${filter}".`
  return prefix ? "This folder is empty." : "This bucket is empty."
}
