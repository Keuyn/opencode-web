import { useState } from "react"
import { Markdown } from "./Markdown"
import { ToolCard } from "./ToolCard"
import { formatTokens } from "../lib/format"
import type { ChatMessage } from "../lib/types"

function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(streaming)
  return (
    <div className="reasoning">
      <button type="button" className="reasoning-head" onClick={() => setOpen((value) => !value)}>
        <span className={`chevron ${open ? "open" : ""}`} aria-hidden>▾</span>
        {streaming ? "Pensando…" : "Raciocínio"}
      </button>
      {open ? (
        <div className="reasoning-body">
          <Markdown text={text} />
        </div>
      ) : null}
    </div>
  )
}

function AssistantMeta({ message }: { message: ChatMessage }) {
  const bits: string[] = []
  if (message.agent) bits.push(message.agent)
  if (message.tokens) bits.push(`${formatTokens(message.tokens.input)} in / ${formatTokens(message.tokens.output)} out`)
  if (typeof message.cost === "number" && message.cost > 0) bits.push(`US$ ${message.cost.toFixed(4)}`)
  if (bits.length === 0) return null
  return <div className="message-meta">{bits.join(" · ")}</div>
}

export function Message({ message, streaming }: { message: ChatMessage; streaming: boolean }) {
  const [copied, setCopied] = useState(false)

  if (message.role === "user") {
    return (
      <div className="message message-user">
        <div className="bubble">
          <div className="user-text">{message.text}</div>
        </div>
      </div>
    )
  }

  if (message.role === "error" || message.role === "system") {
    return (
      <div className="message message-system">
        <Markdown text={message.text} />
      </div>
    )
  }

  const copy = () => {
    const text = message.parts
      .filter((part) => part.kind === "text")
      .map((part) => (part.kind === "text" ? part.text : ""))
      .join("\n\n")
    void navigator.clipboard.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="message message-assistant">
      <div className="avatar" aria-hidden>
        🥒
      </div>
      <div className="message-body">
        {message.parts.map((part, index) => {
          if (part.kind === "reasoning") {
            return <Reasoning key={part.key} text={part.text} streaming={streaming && index === message.parts.length - 1} />
          }
          if (part.kind === "tool") {
            return <ToolCard key={part.key} tool={part.tool} />
          }
          return (
            <div key={part.key} className="assistant-text">
              <Markdown text={part.text} />
            </div>
          )
        })}
        {streaming && message.parts.length === 0 ? (
          <div className="thinking">
            <span className="spinner" aria-hidden /> pensando…
          </div>
        ) : null}
        {message.error ? <div className="message-error">{message.error}</div> : null}
        {!streaming && message.parts.length > 0 ? (
          <div className="message-actions">
            <button type="button" onClick={copy}>
              {copied ? "Copiado!" : "Copiar"}
            </button>
            <AssistantMeta message={message} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
