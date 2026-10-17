import { useState } from "react"
import { describeTool, formatDuration, toolOutput } from "../lib/format"
import type { ToolCall } from "../lib/types"

function inputPreview(tool: ToolCall): string {
  if (tool.input) {
    try {
      return JSON.stringify(tool.input, null, 2)
    } catch {
      return String(tool.input)
    }
  }
  return tool.inputText
}

export function ToolCard({ tool }: { tool: ToolCall }) {
  const [open, setOpen] = useState(false)
  const descriptor = describeTool(tool)
  const output = toolOutput(tool)
  const duration = tool.finished ? formatDuration(tool.finished - tool.started) : undefined
  const hasDetails = Boolean(inputPreview(tool) || output || tool.error)

  return (
    <div className={`tool tool-${tool.status}`}>
      <button type="button" className="tool-head" onClick={() => hasDetails && setOpen((value) => !value)}>
        <span className="tool-icon" aria-hidden>
          {descriptor.icon}
        </span>
        <span className="tool-name">{descriptor.label}</span>
        {descriptor.summary ? <code className="tool-summary">{descriptor.summary}</code> : null}
        <span className="tool-meta">
          {tool.status === "streaming" || tool.status === "running" ? <span className="spinner" aria-hidden /> : null}
          {tool.status === "error" ? <span className="tool-badge error">erro</span> : null}
          {duration ? <span className="tool-time">{duration}</span> : null}
          {hasDetails ? <span className={`chevron ${open ? "open" : ""}`} aria-hidden>▾</span> : null}
        </span>
      </button>
      {open && hasDetails ? (
        <div className="tool-body">
          {inputPreview(tool) ? (
            <details className="tool-section">
              <summary>Entrada</summary>
              <pre>{inputPreview(tool)}</pre>
            </details>
          ) : null}
          {output ? (
            <details className="tool-section" open={tool.status === "error"}>
              <summary>Saída</summary>
              <pre>{output}</pre>
            </details>
          ) : null}
          {tool.error ? (
            <div className="tool-error">
              <strong>Falha:</strong> {tool.error}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
