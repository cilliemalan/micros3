// Hash routes (docs/UI.md, "Stack"). The app has no router library: the
// place is kept in location.hash, so a reload keeps it and the static
// server needs no fallback rules.
//
//   #/                                  the bucket list
//   #/buckets/{bucket}/objects?prefix=  a bucket's objects, one level
//   #/buckets/{bucket}/uploads          its multipart uploads
//   #/buckets/{bucket}/settings         its settings

import { useEffect, useState } from "react"

export const TABS = ["objects", "uploads", "settings"] as const
export type Tab = (typeof TABS)[number]

export type Route =
  | { page: "buckets" }
  | { page: "bucket"; bucket: string; tab: Tab; prefix: string }

function isTab(value: string): value is Tab {
  return (TABS as readonly string[]).includes(value)
}

/** Reads a route from a location hash. Anything unknown is the bucket list. */
export function parseRoute(hash: string): Route {
  const text = hash.startsWith("#") ? hash.slice(1) : hash
  const query = text.indexOf("?")
  const path = query < 0 ? text : text.slice(0, query)
  const params = new URLSearchParams(query < 0 ? "" : text.slice(query + 1))
  const segments = path.split("/").filter((s) => s !== "")
  if (segments[0] !== "buckets" || segments.length < 2 || segments.length > 3) {
    return { page: "buckets" }
  }
  let bucket: string
  try {
    bucket = decodeURIComponent(segments[1])
  } catch {
    return { page: "buckets" }
  }
  const tab = segments[2] ?? "objects"
  if (!bucket || !isTab(tab)) return { page: "buckets" }
  return { page: "bucket", bucket, tab, prefix: tab === "objects" ? (params.get("prefix") ?? "") : "" }
}

/** The hash for a route, starting with "#". */
export function routeHash(route: Route): string {
  if (route.page === "buckets") return "#/"
  const base = `#/buckets/${encodeURIComponent(route.bucket)}/${route.tab}`
  if (route.tab !== "objects" || !route.prefix) return base
  return `${base}?${new URLSearchParams({ prefix: route.prefix })}`
}

/** Shorthand for the route of a bucket's page. */
export function bucketRoute(bucket: string, tab: Tab = "objects", prefix = ""): Route {
  return { page: "bucket", bucket, tab, prefix }
}

/** Goes to a route by setting location.hash, which adds a history entry. */
export function navigate(route: Route): void {
  window.location.hash = routeHash(route)
}

/** The current route, updated on every hashchange. */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash))
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.hash))
    window.addEventListener("hashchange", update)
    return () => window.removeEventListener("hashchange", update)
  }, [])
  return route
}

export interface Crumb {
  /** The text shown: the folder name, or the bucket name for the root. */
  label: string
  /** The prefix this crumb opens, "" for the bucket root. */
  prefix: string
}

/**
 * The breadcrumb for a prefix in a bucket. The first crumb is the bucket
 * root, then one per folder. "a/b/" gives bucket, "a", "b". A prefix that
 * does not end in "/" still gives its last part as a crumb.
 */
export function crumbs(bucket: string, prefix: string): Crumb[] {
  const result: Crumb[] = [{ label: bucket, prefix: "" }]
  let start = 0
  while (start < prefix.length) {
    const slash = prefix.indexOf("/", start)
    const end = slash < 0 ? prefix.length : slash + 1
    const label = prefix.slice(start, slash < 0 ? prefix.length : slash)
    result.push({ label: label || "/", prefix: prefix.slice(0, end) })
    start = end
  }
  return result
}
