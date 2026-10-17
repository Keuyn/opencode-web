import { useEffect, useMemo, useState } from "react"
import type { FormDetail, FormInfo } from "@opencode/client"
import { cancelForm, loadForm, replyForm } from "../lib/store"

type FormField = FormInfo["fields"][number]
type Answer = string | number | boolean | string[]

function isHidden(field: FormField): boolean {
  return "hidden" in field && Boolean(field.hidden)
}

function isRequired(field: FormField): boolean {
  return "required" in field && Boolean(field.required)
}

function defaultAnswer(field: FormField): Answer | undefined {
  if ("default" in field && field.default !== undefined) return field.default as Answer
  if (field.type === "boolean") return false
  if (field.type === "multiselect") return []
  return undefined
}

function OptionSelect({
  field,
  value,
  onChange,
}: {
  field: Extract<FormField, { type: "string" | "multiselect" }>
  value: Answer | undefined
  onChange: (value: Answer) => void
}) {
  const options = "options" in field ? (field.options ?? []) : []
  const custom = "custom" in field ? Boolean(field.custom) : false
  const current = value === undefined ? "" : String(value)
  const isCustom = custom && current !== "" && !options.some((option) => option.value === current)

  return (
    <div className="form-control">
      <select
        value={isCustom ? "__custom__" : current}
        onChange={(event) => onChange(event.target.value === "__custom__" ? "" : event.target.value)}
      >
        <option value="">—</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
        {custom ? <option value="__custom__">Outro…</option> : null}
      </select>
      {isCustom || (custom && current !== "" && !options.some((option) => option.value === current)) ? (
        <input type="text" value={current} onChange={(event) => onChange(event.target.value)} />
      ) : null}
    </div>
  )
}

function Field({
  field,
  value,
  onChange,
}: {
  field: FormField
  value: Answer | undefined
  onChange: (value: Answer) => void
}) {
  if (field.type === "boolean") {
    return (
      <label className="form-check">
        <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />
        <span>{field.title ?? field.key}</span>
      </label>
    )
  }

  if (field.type === "number" || field.type === "integer") {
    return (
      <input
        type="number"
        step={field.type === "integer" ? 1 : "any"}
        value={value === undefined ? "" : String(value)}
        onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))}
      />
    )
  }

  if (field.type === "multiselect") {
    const selected = Array.isArray(value) ? value : []
    return (
      <div className="form-options">
        {(field.options ?? []).map((option) => (
          <label key={option.value} className="form-check">
            <input
              type="checkbox"
              checked={selected.includes(option.value)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, option.value]
                    : selected.filter((item) => item !== option.value),
                )
              }
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    )
  }

  if (field.type === "external") {
    return (
      <a href={field.url} target="_blank" rel="noreferrer" className="form-external">
        {field.title ?? field.url}
      </a>
    )
  }

  if ("options" in field && field.options && field.options.length > 0) {
    return <OptionSelect field={field as never} value={value} onChange={onChange} />
  }

  return (
    <input
      type={field.format === "email" ? "email" : field.format === "uri" ? "url" : "text"}
      placeholder={field.placeholder}
      value={value === undefined ? "" : String(value)}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

export function FormCard({ form }: { form: FormInfo }) {
  const [detail, setDetail] = useState<FormDetail | null>(null)
  const [answers, setAnswers] = useState<Record<string, Answer>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void loadForm(form.id).then(setDetail)
  }, [form.id])

  const fields = useMemo(
    () => (detail?.fields ?? form.fields).filter((field) => !isHidden(field) && field.type !== "external"),
    [detail, form.fields],
  )

  useEffect(() => {
    setAnswers((current) => {
      const next = { ...current }
      for (const field of fields) {
        if (next[field.key] === undefined) {
          const fallback = defaultAnswer(field)
          if (fallback !== undefined) next[field.key] = fallback
        }
      }
      return next
    })
  }, [fields])

  const submit = async () => {
    const missing = fields.filter(
      (field) => isRequired(field) && (answers[field.key] === undefined || answers[field.key] === ""),
    )
    if (missing.length > 0) {
      setError(`Preencha: ${missing.map((field) => field.title ?? field.key).join(", ")}`)
      return
    }
    setBusy(true)
    setError(null)
    await replyForm(form.id, answers as Record<string, string | number | boolean | string[]>)
    setBusy(false)
  }

  return (
    <div className="form-card">
      <div className="form-head">
        <span aria-hidden>❓</span> {form.title || "O agente precisa de uma informação"}
      </div>
      <div className="form-body">
        {fields.map((field) => (
          <div key={field.key} className="form-field">
            <label className="form-label">
              {field.title ?? field.key}
              {isRequired(field) ? <span className="required">*</span> : null}
            </label>
            {field.description ? <p className="form-description">{field.description}</p> : null}
            <Field
              field={field}
              value={answers[field.key]}
              onChange={(value) => setAnswers((current) => ({ ...current, [field.key]: value }))}
            />
          </div>
        ))}
        {error ? <div className="message-error">{error}</div> : null}
      </div>
      <div className="form-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void submit()}>
          Enviar resposta
        </button>
        <button type="button" disabled={busy} onClick={() => void cancelForm(form.id)}>
          Cancelar
        </button>
      </div>
    </div>
  )
}
