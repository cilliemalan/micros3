// The object drawer (U19): details from GET .../meta, a form for the stored
// headers saved in place with PUT .../meta (UI7: the ETag and last-modified
// time stay the same), and a preview. Images are shown through a `blob:`
// URL and text (up to 1 MiB) as text, never as HTML; nothing else is
// previewed. The page never navigates to the object's URL.

import { useEffect, useRef, useState, type FormEvent } from "react"
import { Button } from "@ui-sdk/react/button"
import {
  Drawer,
  DrawerBackdrop,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@ui-sdk/react/drawer"
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from "@ui-sdk/react/field"
import { Input } from "@ui-sdk/react/input"
import { api, isApiError, objectUrl, send, type ObjectMeta } from "../api"
import { downloadObject } from "../download"
import { formatAbsolute, formatSize } from "../format"
import {
  STANDARD_HEADERS,
  formFromHeaders,
  formProblems,
  headersFromForm,
  newUserRow,
  previewFor,
  sameHeaders,
  type MetaForm,
  type StandardHeader,
} from "../metadata"
import { displayEtag } from "../objects"
import { DownloadIcon, PlusIcon, TrashIcon, XIcon } from "./Icons"
import { notify } from "./Toasts"

const PLACEHOLDERS: Record<StandardHeader, string> = {
  "Content-Type": "none: served as binary/octet-stream",
  "Cache-Control": "e.g. max-age=3600",
  "Content-Disposition": 'e.g. attachment; filename="name.ext"',
  "Content-Encoding": "e.g. gzip",
  "Content-Language": "e.g. en",
  Expires: "e.g. Wed, 21 Oct 2026 07:28:00 GMT",
}

function errorText(error: unknown): string {
  return isApiError(error) ? `${error.message} (${error.code})` : String(error)
}

export function ObjectDrawer({
  bucket,
  objectKey,
  onClose,
  onMissing,
}: {
  bucket: string
  /** The key shown; the drawer is open while this is set. */
  objectKey: string | null
  onClose: () => void
  /** Called when the object turns out to be gone. */
  onMissing?: (key: string) => void
}) {
  // The key on screen, kept while the drawer animates closed.
  const [shown, setShown] = useState<string | null>(null)
  const [meta, setMeta] = useState<ObjectMeta | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [form, setForm] = useState<MetaForm | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const open = objectKey !== null
  const onMissingRef = useRef(onMissing)
  useEffect(() => {
    onMissingRef.current = onMissing
  })

  if (objectKey !== null && objectKey !== shown) {
    setShown(objectKey)
    setMeta(null)
    setForm(null)
    setLoadError(null)
    setSaveError(null)
  }

  useEffect(() => {
    if (objectKey === null) return
    let live = true
    api.getMeta(bucket, objectKey).then(
      (m) => {
        if (!live) return
        setMeta(m)
        setForm(formFromHeaders(m.headers))
      },
      (error) => {
        if (!live) return
        setLoadError(error)
        if (isApiError(error, "NoSuchKey")) onMissingRef.current?.(objectKey)
      },
    )
    return () => {
      live = false
    }
  }, [bucket, objectKey])

  const problems = form ? formProblems(form) : null
  const dirty = form && meta ? !sameHeaders(headersFromForm(form), meta.headers) : false

  function setStandard(name: StandardHeader, value: string) {
    setForm((f) => f && { ...f, standard: { ...f.standard, [name]: value } })
    setSaveError(null)
  }

  function setRow(id: number, change: { name?: string; value?: string }) {
    setForm((f) => f && { ...f, user: f.user.map((r) => (r.id === id ? { ...r, ...change } : r)) })
    setSaveError(null)
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!form || !meta || !problems || problems.any || saving || shown === null) return
    setSaving(true)
    setSaveError(null)
    try {
      const updated = await api.putMeta(bucket, shown, headersFromForm(form))
      setMeta(updated)
      setForm(formFromHeaders(updated.headers))
      notify.success("Metadata saved", { description: shown })
    } catch (error) {
      setSaveError(errorText(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer
      side="right"
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) onClose()
      }}
      onOpenChangeComplete={(next) => {
        if (!next) setShown(null)
      }}
    >
      <DrawerBackdrop />
      <DrawerContent className="drawer">
        <div className="drawer-head">
          <div className="stack-tight drawer-heading">
            <DrawerTitle>Object details</DrawerTitle>
            <DrawerDescription className="mono key-cell">
              {bucket}/{shown}
            </DrawerDescription>
          </div>
          <DrawerClose aria-label="Close" data-variant="ghost" data-size="sm">
            <XIcon />
          </DrawerClose>
        </div>
        <div className="drawer-body stack">
          {loadError ? (
            <div className="empty" role="alert">
              <p>{isApiError(loadError, "NoSuchKey") ? "This object no longer exists." : "Could not load the object."}</p>
              <p className="muted">{errorText(loadError)}</p>
            </div>
          ) : !meta || !form || !problems ? (
            <p className="muted">Loading…</p>
          ) : (
            <>
              <section className="panel" aria-labelledby="drawer-details">
                <div className="row">
                  <h3 id="drawer-details">Details</h3>
                  <div className="spacer" />
                  <Button data-size="sm" onClick={() => downloadObject(bucket, meta.key)}>
                    <DownloadIcon /> Download
                  </Button>
                </div>
                <dl className="details">
                  <dt>Size</dt>
                  <dd>
                    {formatSize(meta.size)} <span className="muted">({meta.size.toLocaleString()} bytes)</span>
                  </dd>
                  <dt>Last modified</dt>
                  <dd>
                    <time dateTime={meta.lastModified}>{formatAbsolute(meta.lastModified)}</time>
                  </dd>
                  <dt>ETag</dt>
                  <dd className="mono key-cell">{displayEtag(meta.etag)}</dd>
                  <dt>Content-Type</dt>
                  <dd className="mono key-cell">{meta.headers["Content-Type"] ?? <span className="muted">none</span>}</dd>
                </dl>
              </section>

              <form className="panel" onSubmit={(e) => void save(e)} noValidate aria-labelledby="drawer-meta">
                <h3 id="drawer-meta">Metadata</h3>
                <p className="muted small">
                  Saved in place: the content, ETag and last-modified time do not change. An empty field removes the
                  header.
                </p>
                {STANDARD_HEADERS.map((name) => (
                  <Field key={name} invalid={problems.standard[name] ? true : false}>
                    <FieldLabel>{name}</FieldLabel>
                    <Input
                      className="mono"
                      value={form.standard[name]}
                      placeholder={PLACEHOLDERS[name]}
                      autoComplete="off"
                      spellCheck={false}
                      onValueChange={(value) => setStandard(name, value)}
                    />
                    {problems.standard[name] && <FieldError match>{problems.standard[name]}</FieldError>}
                  </Field>
                ))}

                <FieldSet className="methods">
                  <FieldLegend>User metadata (x-amz-meta-*)</FieldLegend>
                  {form.user.length === 0 && <p className="muted small">No user metadata.</p>}
                  {form.user.map((row, index) => (
                    <div key={row.id} className="meta-row">
                      <Field invalid={problems.userName[row.id] ? true : false}>
                        <FieldLabel className="sr-only">Name {index + 1}</FieldLabel>
                        <Input
                          className="mono"
                          value={row.name}
                          placeholder="name"
                          autoComplete="off"
                          spellCheck={false}
                          onValueChange={(value) => setRow(row.id, { name: value })}
                        />
                        {problems.userName[row.id] && <FieldError match>{problems.userName[row.id]}</FieldError>}
                      </Field>
                      <Field invalid={problems.userValue[row.id] ? true : false}>
                        <FieldLabel className="sr-only">Value {index + 1}</FieldLabel>
                        <Input
                          className="mono"
                          value={row.value}
                          placeholder="value"
                          autoComplete="off"
                          spellCheck={false}
                          onValueChange={(value) => setRow(row.id, { value })}
                        />
                        {problems.userValue[row.id] && <FieldError match>{problems.userValue[row.id]}</FieldError>}
                      </Field>
                      <Button
                        data-variant="ghost"
                        aria-label={`Remove ${row.name || `row ${index + 1}`}`}
                        title="Remove"
                        onClick={() => setForm((f) => f && { ...f, user: f.user.filter((r) => r.id !== row.id) })}
                      >
                        <TrashIcon />
                      </Button>
                    </div>
                  ))}
                  {problems.user && (
                    <p className="error-text small" role="alert">
                      {problems.user}
                    </p>
                  )}
                  <div>
                    <Button
                      data-size="sm"
                      onClick={() => setForm((f) => f && { ...f, user: [...f.user, newUserRow()] })}
                    >
                      <PlusIcon /> Add metadata
                    </Button>
                  </div>
                </FieldSet>

                {saveError && (
                  <p className="error-text" role="alert">
                    {saveError}
                  </p>
                )}
                <div className="row end">
                  <Button
                    disabled={!dirty || saving}
                    onClick={() => {
                      setForm(formFromHeaders(meta.headers))
                      setSaveError(null)
                    }}
                  >
                    Reset
                  </Button>
                  <Button type="submit" data-variant="solid" disabled={!dirty || saving || problems.any}>
                    {saving ? "Saving…" : "Save"}
                  </Button>
                </div>
              </form>

              <section className="panel" aria-labelledby="drawer-preview">
                <h3 id="drawer-preview">Preview</h3>
                <ObjectPreview bucket={bucket} meta={meta} />
              </section>
            </>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  )
}

type PreviewState =
  | { state: "loading" }
  | { state: "image"; url: string }
  | { state: "text"; text: string }
  | { state: "error"; message: string }

function ObjectPreview({ bucket, meta }: { bucket: string; meta: ObjectMeta }) {
  const preview = previewFor(meta.headers["Content-Type"], meta.size)
  const [state, setState] = useState<PreviewState>({ state: "loading" })
  const kind = preview.kind

  useEffect(() => {
    if (kind === "none") return
    const controller = new AbortController()
    let url: string | null = null
    setState({ state: "loading" })
    send(objectUrl(bucket, meta.key), { signal: controller.signal })
      .then((response) => response.blob())
      .then(async (blob) => {
        if (controller.signal.aborted) return
        if (kind === "image") {
          url = URL.createObjectURL(blob)
          setState({ state: "image", url })
        } else {
          setState({ state: "text", text: await blob.text() })
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState({ state: "error", message: errorText(error) })
      })
    return () => {
      controller.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [bucket, meta.key, meta.etag, kind])

  if (preview.kind === "none") return <p className="muted">{preview.reason}</p>
  if (state.state === "loading") return <p className="muted">Loading preview…</p>
  if (state.state === "error") {
    return (
      <p className="error-text" role="alert">
        Could not load the preview: {state.message}
      </p>
    )
  }
  if (state.state === "image") {
    return (
      <div className="preview-image">
        <img src={state.url} alt={`Preview of ${meta.key}`} />
      </div>
    )
  }
  return state.text === "" ? (
    <p className="muted">The object is empty.</p>
  ) : (
    <pre className="preview-text mono" tabIndex={0} aria-label={`Text of ${meta.key}`}>
      {state.text}
    </pre>
  )
}
