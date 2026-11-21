// Typed client for the micros3 UI JSON API under /api/ (docs/UI.md,
// "Backend: the JSON API"). Every call goes through `request`, which
// turns the JSON error shape {"error": {code, message}} into an ApiError.
// Object keys are always sent in a `key` query parameter, never in the path.

/** An error answered by the API, or a failure to reach it. */
export class ApiError extends Error {
  /** The S3 error code, e.g. "NoSuchBucket". "NetworkError" if the request never got a reply. */
  readonly code: string
  /** The HTTP status, or 0 if the request never got a reply. */
  readonly status: number

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
  }
}

/** True if `error` is an ApiError with the given S3 code. */
export function isApiError(error: unknown, code?: string): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code)
}

/** A one-line description of any error, for the detail line of an error state or toast. */
export function errorDetail(error: unknown): string {
  if (isApiError(error)) return `${error.message} (${error.code})`
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

// ---------------------------------------------------------------------------
// URL helpers

export type Query = Record<string, string | number | boolean | undefined | null>

/**
 * Builds an /api/ path from literal segments and named values. Each value
 * in `segments` is encoded as one path segment. Query values that are
 * undefined or null are left out; the rest are encoded with
 * URLSearchParams, so keys with spaces, `%`, `/`, `&`, `#` or UTF-8 survive.
 */
export function apiUrl(segments: readonly string[], query?: Query): string {
  const path = "/api/" + segments.map((s) => encodeURIComponent(s)).join("/")
  if (!query) return path
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    params.append(name, String(value))
  }
  const search = params.toString()
  return search ? `${path}?${search}` : path
}

/** The path of a bucket, or of something under it: /api/buckets/{bucket}/... */
export function bucketUrl(bucket: string, sub?: string, query?: Query): string {
  return apiUrl(sub ? ["buckets", bucket, sub] : ["buckets", bucket], query)
}

/** The path of an object's content or metadata. The key goes in `key=`. */
export function objectUrl(bucket: string, key: string, sub: "object" | "meta" = "object"): string {
  return bucketUrl(bucket, sub, { key })
}

// ---------------------------------------------------------------------------
// Request core

export interface RequestOptions {
  method?: string
  /** A JSON body. Sent with Content-Type: application/json. */
  json?: unknown
  /** A raw body, sent as given. Use `headers` to set its Content-Type. */
  body?: BodyInit
  headers?: Record<string, string>
  signal?: AbortSignal
}

/** Reads an error reply into an ApiError, whatever its body holds. */
export async function errorFrom(response: Response): Promise<ApiError> {
  let text = ""
  try {
    text = await response.text()
  } catch {
    // Fall through to the status-only error below.
  }
  return parseError(response.status, text, response.statusText)
}

/** Parses the JSON error shape. Falls back to the status if the body is not that shape. */
export function parseError(status: number, text: string, statusText = ""): ApiError {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const error = (parsed as { error: unknown }).error
      if (error && typeof error === "object") {
        const { code, message } = error as { code?: unknown; message?: unknown }
        if (typeof code === "string") {
          return new ApiError(status, code, typeof message === "string" ? message : code)
        }
      }
    }
  } catch {
    // Not JSON.
  }
  const message = statusText || `Request failed with status ${status}`
  return new ApiError(status, `Http${status}`, message)
}

/** Sends a request and returns the raw Response if its status is 2xx. Throws ApiError otherwise. */
export async function send(url: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers }
  let body = options.body
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json"
    body = JSON.stringify(options.json)
  }
  let response: Response
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body,
      signal: options.signal,
      credentials: "same-origin",
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new ApiError(0, "NetworkError", message || "The server could not be reached.")
  }
  if (!response.ok) throw await errorFrom(response)
  return response
}

/** Sends a request and parses a JSON reply. An empty reply (204 or no body) gives undefined. */
export async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(url, options)
  const text = await response.text()
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError(response.status, "InvalidResponse", "The server sent a reply that is not JSON.")
  }
}

// ---------------------------------------------------------------------------
// Types of the API's replies

export interface Bucket {
  name: string
  region: string
  /** ISO 8601 time. */
  created: string
}

export interface BucketDetails extends Bucket {
  /** Default encryption algorithm, e.g. "AES256". */
  encryption: string
  cors: boolean
}

export interface ObjectSummary {
  key: string
  size: number
  etag: string
  /** ISO 8601 time. */
  lastModified: string
}

export interface ObjectListing {
  /** Common prefixes one level down, each ending in the delimiter. */
  folders: string[]
  objects: ObjectSummary[]
  /** Pass as `after` to get the next page. Absent on the last page. */
  next?: string
}

export interface ObjectMeta extends ObjectSummary {
  /** Stored headers: Content-Type, Cache-Control, x-amz-meta-*, and so on. */
  headers: Record<string, string>
}

export interface DeleteResult {
  deleted: string[]
  errors: { key: string; code: string; message: string }[]
}

export interface Upload {
  key: string
  uploadId: string
  /** ISO 8601 time. */
  initiated: string
}

export interface UploadListing {
  uploads: Upload[]
  /** Pass as `after` to get the next page. Absent on the last page. */
  next?: { key: string; uploadId: string }
}

export interface ListObjectsOptions {
  prefix?: string
  delimiter?: string
  after?: string
  limit?: number
}

export interface CopyRequest {
  source: { bucket: string; key: string }
  destination: { bucket: string; key: string }
  move?: boolean
}

/** At most this many keys go in one delete batch, as in S3. */
export const MAX_BATCH = 1000

// ---------------------------------------------------------------------------
// Endpoints

export const api = {
  health: () => request<{ status: string }>(apiUrl(["health"])),

  listBuckets: () => request<{ buckets: Bucket[] }>(apiUrl(["buckets"])).then((r) => r.buckets),
  createBucket: (name: string, region?: string) =>
    request<Bucket>(apiUrl(["buckets"]), { method: "POST", json: { name, region } }),
  getBucket: (bucket: string) => request<BucketDetails>(bucketUrl(bucket)),
  deleteBucket: (bucket: string) => request<void>(bucketUrl(bucket), { method: "DELETE" }),
  emptyBucket: (bucket: string) => request<void>(bucketUrl(bucket, "empty"), { method: "POST" }),

  listObjects: (bucket: string, options: ListObjectsOptions = {}) =>
    request<ObjectListing>(
      bucketUrl(bucket, "objects", {
        prefix: options.prefix,
        delimiter: options.delimiter ?? "/",
        after: options.after,
        limit: options.limit,
      }),
    ),
  getMeta: (bucket: string, key: string) => request<ObjectMeta>(objectUrl(bucket, key, "meta")),
  putMeta: (bucket: string, key: string, headers: Record<string, string>) =>
    request<ObjectMeta>(objectUrl(bucket, key, "meta"), { method: "PUT", json: { headers } }),
  deleteObjects: (bucket: string, keys: string[]) => {
    if (keys.length > MAX_BATCH) {
      return Promise.reject(
        new ApiError(0, "TooManyKeys", `A batch takes at most ${MAX_BATCH} keys.`),
      )
    }
    return request<DeleteResult>(bucketUrl(bucket, "delete"), { method: "POST", json: { keys } })
  },
  copyObject: (bucket: string, copy: CopyRequest) =>
    request<ObjectSummary>(bucketUrl(bucket, "copy"), { method: "POST", json: copy }),

  getCors: (bucket: string) => send(bucketUrl(bucket, "cors")).then((r) => r.text()),
  putCors: (bucket: string, xml: string) =>
    request<void>(bucketUrl(bucket, "cors"), {
      method: "PUT",
      body: xml,
      headers: { "Content-Type": "application/xml" },
    }),
  deleteCors: (bucket: string) => request<void>(bucketUrl(bucket, "cors"), { method: "DELETE" }),

  listUploads: (bucket: string, after?: { key: string; uploadId: string }) =>
    request<UploadListing>(
      bucketUrl(bucket, "uploads", { keyMarker: after?.key, uploadIdMarker: after?.uploadId }),
    ),
  abortUpload: (bucket: string, key: string, uploadId: string) =>
    request<void>(bucketUrl(bucket, "uploads", { key, uploadId }), { method: "DELETE" }),
}

// ---------------------------------------------------------------------------
// Uploads, through XMLHttpRequest for progress events

export interface UploadOptions {
  /** Stored as the object's Content-Type. Defaults to the file's type. */
  contentType?: string
  /** Extra stored headers: Cache-Control and x-amz-meta-*. */
  headers?: Record<string, string>
  /** Called with bytes sent and total bytes. */
  onProgress?: (loaded: number, total: number) => void
  signal?: AbortSignal
}

/** Uploads `body` as `key` with PUT /api/buckets/{bucket}/object?key=. Resolves with the stored object. */
export function uploadObject(
  bucket: string,
  key: string,
  body: Blob,
  options: UploadOptions = {},
): Promise<ObjectSummary> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException("The upload was aborted.", "AbortError"))
      return
    }
    const xhr = new XMLHttpRequest()
    xhr.open("PUT", objectUrl(bucket, key))
    const contentType = options.contentType || body.type || "application/octet-stream"
    xhr.setRequestHeader("Content-Type", contentType)
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      xhr.setRequestHeader(name, value)
    }
    if (options.onProgress) {
      const onProgress = options.onProgress
      xhr.upload.addEventListener("progress", (event) => {
        onProgress(event.loaded, event.lengthComputable ? event.total : body.size)
      })
    }
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as ObjectSummary)
        } catch {
          reject(new ApiError(xhr.status, "InvalidResponse", "The server sent a reply that is not JSON."))
        }
      } else {
        reject(parseError(xhr.status, xhr.responseText, xhr.statusText))
      }
    })
    xhr.addEventListener("error", () => {
      reject(new ApiError(0, "NetworkError", "The server could not be reached."))
    })
    xhr.addEventListener("abort", () => {
      reject(new DOMException("The upload was aborted.", "AbortError"))
    })
    options.signal?.addEventListener("abort", () => xhr.abort(), { once: true })
    xhr.send(body)
  })
}
