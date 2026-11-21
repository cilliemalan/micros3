// Uploading files (U18). A File Input takes dropped or chosen files; each
// starts uploading into the current folder at once, a few at a time,
// through XMLHttpRequest so it can show progress. The list keeps each
// file's state until the dialog is cleared. Toasts report the results.

import { useEffect, useRef, useState } from "react"
import { Button } from "@ui-sdk/react/button"
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ui-sdk/react/dialog"
import {
  FileInput,
  FileInputDropzone,
  FileInputTrigger,
  relativePath,
} from "@ui-sdk/react/file-input"
import { Progress, ProgressIndicator, ProgressTrack } from "@ui-sdk/react/progress"
import { isApiError, uploadObject } from "../api"
import { formatSize } from "../format"
import { keyProblem, uploadKey, uploadPercent, uploadSummary, type UploadItem } from "../objectActions"
import { CheckIcon, UploadIcon, XIcon } from "./Icons"
import { notify } from "./Toasts"

/** Files uploading at the same time. */
const CONCURRENCY = 3

let nextId = 1

export function UploadDialog({
  bucket,
  prefix,
  open,
  onOpenChange,
  onUploaded,
}: {
  bucket: string
  prefix: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called when a run of uploads ends with at least one file stored. */
  onUploaded: () => void
}) {
  const [items, setItems] = useState<UploadItem[]>([])
  const controllers = useRef(new Map<number, AbortController>())
  const storedSinceIdle = useRef(0)
  /** Items already handed to `start`, so no item starts twice. */
  const started = useRef(new Set<number>())

  const active = items.filter((i) => i.status === "uploading").length
  const queued = items.filter((i) => i.status === "queued").length
  const running = active + queued > 0

  function update(id: number, change: Partial<UploadItem>) {
    setItems((list) => list.map((i) => (i.id === id ? { ...i, ...change } : i)))
  }

  async function start(item: UploadItem) {
    const controller = new AbortController()
    controllers.current.set(item.id, controller)
    try {
      await uploadObject(bucket, item.key, item.file, {
        signal: controller.signal,
        onProgress: (loaded) => update(item.id, { loaded }),
      })
      storedSinceIdle.current++
      update(item.id, { status: "done", loaded: item.file.size })
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        update(item.id, { status: "canceled" })
      } else {
        const message = isApiError(error) ? `${error.message} (${error.code})` : String(error)
        update(item.id, { status: "failed", error: message })
        notify.error("Upload failed", { description: `${item.key}: ${message}` })
      }
    } finally {
      controllers.current.delete(item.id)
    }
  }

  // Start queued files while fewer than CONCURRENCY are running.
  useEffect(() => {
    const free = CONCURRENCY - active
    if (free <= 0) return
    const ready = items.filter((i) => i.status === "queued" && !started.current.has(i.id)).slice(0, free)
    if (ready.length === 0) return
    for (const item of ready) started.current.add(item.id)
    setItems((list) => list.map((i) => (ready.some((r) => r.id === i.id) ? { ...i, status: "uploading" } : i)))
    for (const item of ready) void start({ ...item, status: "uploading" })
  }, [items, active])

  // When a run of uploads ends, report it and refresh the listing.
  const wasRunning = useRef(false)
  useEffect(() => {
    if (wasRunning.current && !running) {
      const stored = storedSinceIdle.current
      storedSinceIdle.current = 0
      if (stored > 0) {
        notify.success(stored === 1 ? "1 file uploaded" : `${stored} files uploaded`, {
          description: `To ${bucket}/${prefix}`,
        })
        onUploaded()
      }
    }
    wasRunning.current = running
  }, [running, bucket, prefix, onUploaded])

  function add(files: File[]) {
    const added: UploadItem[] = files.map((file) => {
      const key = uploadKey(prefix, file, relativePath(file))
      const problem = keyProblem(key)
      return {
        id: nextId++,
        file,
        key,
        status: problem ? "failed" : "queued",
        loaded: 0,
        error: problem ?? undefined,
      }
    })
    setItems((list) => [...list, ...added])
  }

  function cancel(id: number) {
    const controller = controllers.current.get(id)
    if (controller) controller.abort()
    else update(id, { status: "canceled" })
  }

  function cancelAll() {
    for (const item of items) if (item.status === "queued" || item.status === "uploading") cancel(item.id)
  }

  function clearFinished() {
    setItems((list) => list.filter((i) => i.status === "queued" || i.status === "uploading"))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBackdrop />
      <DialogContent className="dialog dialog-wide">
        <div className="stack">
          <div className="stack-tight">
            <DialogTitle>Upload files</DialogTitle>
            <DialogDescription>
              Into <span className="mono key-cell">{bucket}/{prefix}</span>. A file with the same key is replaced.
            </DialogDescription>
          </div>
          <FileInput className="upload-input" multiple value={[]} onValueChange={(_, details) => add(details.added)}>
            <FileInputDropzone className="dropzone">
              <UploadIcon />
              <p>Drop files here</p>
              <FileInputTrigger>Choose files</FileInputTrigger>
            </FileInputDropzone>
          </FileInput>
          {items.length > 0 && (
            <>
              <p className="muted small" aria-live="polite">
                {uploadSummary(items)}
              </p>
              <ul className="upload-list" aria-label="Files">
                {items.map((item) => (
                  <UploadRow key={item.id} item={item} prefix={prefix} onCancel={() => cancel(item.id)} />
                ))}
              </ul>
            </>
          )}
          <div className="row end">
            {running ? (
              <Button onClick={cancelAll}>Cancel all</Button>
            ) : (
              items.length > 0 && <Button onClick={clearFinished}>Clear list</Button>
            )}
            <DialogClose>{running ? "Hide" : "Close"}</DialogClose>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

const STATUS_TEXT: Record<UploadItem["status"], string> = {
  queued: "Waiting",
  uploading: "Uploading",
  done: "Uploaded",
  failed: "Failed",
  canceled: "Canceled",
}

function UploadRow({ item, prefix, onCancel }: { item: UploadItem; prefix: string; onCancel: () => void }) {
  const name = item.key.startsWith(prefix) ? item.key.slice(prefix.length) : item.key
  const percent = uploadPercent(item)
  const live = item.status === "queued" || item.status === "uploading"
  return (
    <li className="upload-item" data-status={item.status}>
      <div className="upload-head">
        <span className="mono key-cell truncate" title={item.key}>
          {name}
        </span>
        <span className="muted small nowrap">{formatSize(item.file.size)}</span>
        <span className="upload-status small nowrap">
          {item.status === "done" && <CheckIcon />}
          {STATUS_TEXT[item.status]}
          {item.status === "uploading" && ` ${percent}%`}
        </span>
        {live && (
          <Button data-variant="ghost" data-size="sm" onClick={onCancel} aria-label={`Cancel upload of ${name}`}>
            <XIcon />
          </Button>
        )}
      </div>
      {(item.status === "uploading" || item.status === "queued") && (
        <Progress value={item.status === "queued" ? 0 : percent} aria-label={`Upload of ${name}`}>
          <ProgressTrack>
            <ProgressIndicator />
          </ProgressTrack>
        </Progress>
      )}
      {item.error && <p className="error-text small">{item.error}</p>}
    </li>
  )
}
