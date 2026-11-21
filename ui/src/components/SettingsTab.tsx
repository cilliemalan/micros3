// The Settings tab (U16): region and default encryption, read-only, and
// the bucket's CORS rules as a form. Save builds the S3 XML from the form
// (ui/src/cors.ts) and PUTs it; Remove deletes the configuration.

import { useEffect, useRef, useState, type FormEvent } from "react"
import { Button } from "@ui-sdk/react/button"
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@ui-sdk/react/alert-dialog"
import { Checkbox, CheckboxGroup, CheckboxIndicator } from "@ui-sdk/react/checkbox"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@ui-sdk/react/field"
import { Input } from "@ui-sdk/react/input"
import { Textarea } from "@ui-sdk/react/textarea"
import { api, isApiError, type BucketDetails } from "../api"
import {
  CORS_METHODS,
  MAX_CORS_RULES,
  buildCorsXml,
  emptyRuleForm,
  formToRule,
  parseCorsXml,
  ruleProblems,
  ruleToForm,
  type CorsRuleForm,
} from "../cors"
import { CheckIcon, PlusIcon, TrashIcon } from "./Icons"
import { Time } from "./Time"
import { notify, notifyError } from "./Toasts"

type Keyed = CorsRuleForm & { key: number }

type CorsState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; stored: boolean }

function describe(error: unknown): string {
  return isApiError(error) ? `${error.message} (${error.code})` : String(error)
}

export function SettingsTab({ details }: { details: BucketDetails }) {
  const bucket = details.name
  const nextKey = useRef(0)
  const keyed = (form: CorsRuleForm): Keyed => ({ ...form, key: nextKey.current++ })

  const [cors, setCors] = useState<CorsState>({ status: "loading" })
  const [rules, setRules] = useState<Keyed[]>([])
  const [saved, setSaved] = useState("")
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [reloads, setReloads] = useState(0)

  useEffect(() => {
    let live = true
    setCors({ status: "loading" })
    api.getCors(bucket).then(
      (xml) => {
        if (!live) return
        const forms = parseCorsXml(xml).map(ruleToForm)
        setRules(forms.map(keyed))
        setSaved(JSON.stringify(forms))
        setSubmitted(false)
        setCors({ status: "ready", stored: true })
      },
      (error) => {
        if (!live) return
        if (isApiError(error, "NoSuchCORSConfiguration")) {
          setRules([])
          setSaved("[]")
          setSubmitted(false)
          setCors({ status: "ready", stored: false })
        } else {
          setCors({ status: "error", error })
        }
      },
    )
    return () => {
      live = false
    }
  }, [bucket, reloads])

  const plain = rules.map(({ key: _key, ...form }) => form)
  const dirty = cors.status === "ready" && JSON.stringify(plain) !== saved
  const problems = rules.map(ruleProblems)
  const valid = problems.every((p) => Object.keys(p).length === 0)

  function update(key: number, change: Partial<CorsRuleForm>) {
    setRules((current) => current.map((rule) => (rule.key === key ? { ...rule, ...change } : rule)))
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    setSubmitted(true)
    if (!valid || rules.length === 0 || busy) return
    setBusy(true)
    try {
      await api.putCors(bucket, buildCorsXml(plain.map(formToRule)))
      notify.success("CORS saved", { description: `${rules.length} ${rules.length === 1 ? "rule" : "rules"} on ${bucket}.` })
      setReloads((n) => n + 1)
    } catch (error) {
      notifyError("Could not save CORS", error)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    try {
      await api.deleteCors(bucket)
      notify.success("CORS removed", { description: `${bucket} has no CORS rules now.` })
      setConfirmRemove(false)
      setReloads((n) => n + 1)
    } catch (error) {
      notifyError("Could not remove CORS", error)
    } finally {
      setBusy(false)
    }
  }

  const stored = cors.status === "ready" && cors.stored

  return (
    <div className="stack settings">
      <section className="panel" aria-labelledby="general-title">
        <h2 id="general-title">General</h2>
        <dl className="details">
          <dt>Region</dt>
          <dd className="mono">{details.region}</dd>
          <dt>Default encryption</dt>
          <dd className="mono">{details.encryption || "None"}</dd>
          <dt>Created</dt>
          <dd>
            <Time iso={details.created} />
          </dd>
        </dl>
        <p className="muted small">The region and encryption are set when the bucket is created and cannot change.</p>
      </section>

      <section className="panel" aria-labelledby="cors-title">
        <h2 id="cors-title">CORS</h2>
        <p className="muted">
          Cross-origin rules let web pages on other origins call the S3 port for this bucket. A request is allowed
          by the first rule that matches its origin, method and headers.
        </p>
        {cors.status === "loading" ? (
          <p className="muted">Loading…</p>
        ) : cors.status === "error" ? (
          <div className="empty" role="alert">
            <p>Could not load the CORS configuration.</p>
            <p className="muted">{describe(cors.error)}</p>
            <Button onClick={() => setReloads((n) => n + 1)}>Try again</Button>
          </div>
        ) : (
          <form onSubmit={save} noValidate className="stack">
            {rules.length === 0 ? (
              <div className="empty">
                <p>{stored ? "Every rule is removed. Save needs at least one rule; use Remove CORS instead." : "No CORS configuration is set."}</p>
              </div>
            ) : (
              rules.map((rule, index) => (
                <RuleEditor
                  key={rule.key}
                  index={index}
                  rule={rule}
                  problems={submitted ? problems[index] : {}}
                  onChange={(change) => update(rule.key, change)}
                  onRemove={() => setRules((current) => current.filter((r) => r.key !== rule.key))}
                />
              ))
            )}
            <div className="row">
              <Button
                onClick={() => setRules((current) => [...current, keyed(emptyRuleForm())])}
                disabled={busy || rules.length >= MAX_CORS_RULES}
              >
                <PlusIcon /> Add rule
              </Button>
              <div className="spacer" />
              {dirty && <span className="muted small">Unsaved changes</span>}
              {stored && (
                <Button data-variant="destructive" onClick={() => setConfirmRemove(true)} disabled={busy}>
                  Remove CORS
                </Button>
              )}
              <Button type="submit" data-variant="solid" disabled={busy || !dirty || rules.length === 0}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
            {submitted && !valid && (
              <p role="alert" className="error-text">
                Fix the marked fields before saving.
              </p>
            )}
          </form>
        )}
      </section>

      <AlertDialog
        open={confirmRemove}
        onOpenChange={(next) => {
          if (!busy) setConfirmRemove(next)
        }}
      >
        <AlertDialogBackdrop />
        <AlertDialogContent className="dialog">
          <div className="stack">
            <div className="stack-tight">
              <AlertDialogTitle>Remove CORS?</AlertDialogTitle>
              <AlertDialogDescription>
                Every CORS rule on <strong className="mono">{bucket}</strong> is deleted, and browsers on other
                origins can no longer call it.
              </AlertDialogDescription>
            </div>
            <div className="row end">
              <Button onClick={() => setConfirmRemove(false)} disabled={busy}>
                Cancel
              </Button>
              <Button data-variant="destructive" onClick={() => void remove()} disabled={busy}>
                {busy ? "Removing…" : "Remove"}
              </Button>
            </div>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function RuleEditor({
  index,
  rule,
  problems,
  onChange,
  onRemove,
}: {
  index: number
  rule: CorsRuleForm
  problems: ReturnType<typeof ruleProblems>
  onChange: (change: Partial<CorsRuleForm>) => void
  onRemove: () => void
}) {
  const title = `Rule ${index + 1}${rule.id.trim() ? `: ${rule.id.trim()}` : ""}`
  return (
    <FieldSet className="rule">
      <div className="row">
        <FieldLegend className="rule-title">{title}</FieldLegend>
        <div className="spacer" />
        <Button className="icon-button" aria-label={`Remove rule ${index + 1}`} title="Remove rule" onClick={onRemove}>
          <TrashIcon />
        </Button>
      </div>
      <div className="rule-grid">
        <Field invalid={!!problems.origins}>
          <FieldLabel>Allowed origins</FieldLabel>
          <Textarea
            value={rule.origins}
            onValueChange={(origins) => onChange({ origins })}
            className="mono"
            rows={3}
            spellCheck={false}
            placeholder={"http://localhost:5173\nhttps://*.example.com"}
          />
          {problems.origins ? (
            <FieldError match>{problems.origins}</FieldError>
          ) : (
            <FieldDescription>One per line. One * is allowed, and * alone allows any origin.</FieldDescription>
          )}
        </Field>
        <FieldSet className="methods">
          <FieldLegend>Allowed methods</FieldLegend>
          <CheckboxGroup
            value={rule.methods}
            onValueChange={(methods) => onChange({ methods })}
            aria-invalid={problems.methods ? true : undefined}
            className="row"
          >
            {CORS_METHODS.map((method) => (
              <label key={method} className="check mono">
                <Checkbox value={method}>
                  <CheckboxIndicator>
                    <CheckIcon />
                  </CheckboxIndicator>
                </Checkbox>
                {method}
              </label>
            ))}
          </CheckboxGroup>
          {problems.methods && (
            <p role="alert" className="error-text small">
              {problems.methods}
            </p>
          )}
        </FieldSet>
        <Field invalid={!!problems.allowedHeaders}>
          <FieldLabel>Allowed headers</FieldLabel>
          <Textarea
            value={rule.allowedHeaders}
            onValueChange={(allowedHeaders) => onChange({ allowedHeaders })}
            className="mono"
            rows={2}
            spellCheck={false}
            placeholder="*"
          />
          {problems.allowedHeaders ? (
            <FieldError match>{problems.allowedHeaders}</FieldError>
          ) : (
            <FieldDescription>Request headers a preflight may ask for. One per line.</FieldDescription>
          )}
        </Field>
        <Field>
          <FieldLabel>Exposed headers</FieldLabel>
          <Textarea
            value={rule.exposeHeaders}
            onValueChange={(exposeHeaders) => onChange({ exposeHeaders })}
            className="mono"
            rows={2}
            spellCheck={false}
            placeholder="ETag"
          />
          <FieldDescription>Response headers scripts may read. One per line.</FieldDescription>
        </Field>
        <Field invalid={!!problems.maxAge}>
          <FieldLabel>Max age (seconds)</FieldLabel>
          <Input
            value={rule.maxAge}
            onValueChange={(maxAge) => onChange({ maxAge })}
            inputMode="numeric"
            className="mono"
            placeholder="3000"
          />
          {problems.maxAge ? (
            <FieldError match>{problems.maxAge}</FieldError>
          ) : (
            <FieldDescription>How long browsers may cache a preflight. Optional.</FieldDescription>
          )}
        </Field>
        <Field invalid={!!problems.id}>
          <FieldLabel>ID</FieldLabel>
          <Input
            value={rule.id}
            onValueChange={(id) => onChange({ id })}
            autoComplete="off"
            spellCheck={false}
            placeholder="Optional"
          />
          {problems.id && <FieldError match>{problems.id}</FieldError>}
        </Field>
      </div>
    </FieldSet>
  )
}
