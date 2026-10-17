import { useMemo, useState } from "react"
import { useAppState } from "../lib/useStore"
import { removeSession, renameSession, startNewChat, openSession, setDirectory } from "../lib/store"
import { dayBucket, relativeTime } from "../lib/format"
import type { SessionInfo } from "../lib/types"
import { NetworkPanel } from "./NetworkPanel"

const BUCKET_LABELS: Record<string, string> = {
  hoje: "Hoje",
  ontem: "Ontem",
  semana: "Últimos 7 dias",
  antigas: "Anteriores",
}

function SessionRow({ session, active }: { session: SessionInfo; active: boolean }) {
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(session.title ?? "Nova conversa")

  if (renaming) {
    return (
      <li className="session-row renaming">
        <input
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => {
            setRenaming(false)
            if (title.trim() && title !== session.title) void renameSession(session.id, title.trim())
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur()
            if (event.key === "Escape") {
              setTitle(session.title ?? "")
              setRenaming(false)
            }
          }}
        />
      </li>
    )
  }

  return (
    <li className={`session-row ${active ? "active" : ""}`}>
      <button type="button" className="session-main" onClick={() => void openSession(session.id)}>
        <span className="session-title">{session.title || "Nova conversa"}</span>
        <span className="session-time">{relativeTime(session.time.updated)}</span>
      </button>
      <span className="session-tools">
        <button
          type="button"
          title="Renomear"
          onClick={(event) => {
            event.stopPropagation()
            setTitle(session.title ?? "")
            setRenaming(true)
          }}
        >
          ✎
        </button>
        <button
          type="button"
          title="Excluir"
          onClick={(event) => {
            event.stopPropagation()
            if (window.confirm("Excluir esta conversa?")) void removeSession(session.id)
          }}
        >
          🗑
        </button>
      </span>
    </li>
  )
}

export function Sidebar({ onClose }: { onClose?: () => void }) {
  const state = useAppState()
  const [search, setSearch] = useState("")
  const [networkOpen, setNetworkOpen] = useState(false)

  const groups = useMemo(() => {
    const filtered = state.sessions.filter((session) =>
      (session.title ?? "").toLowerCase().includes(search.toLowerCase()),
    )
    const buckets = new Map<string, SessionInfo[]>()
    for (const session of filtered) {
      const bucket = dayBucket(session.time.updated)
      const list = buckets.get(bucket) ?? []
      list.push(session)
      buckets.set(bucket, list)
    }
    return [...buckets.entries()]
  }, [state.sessions, search])

  const connectionLabel =
    state.connection === "online" ? "conectado" : state.connection === "connecting" ? "conectando…" : "offline"

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">
          <span aria-hidden>🥒</span> OpenCode Web
        </span>
        {onClose ? (
          <button type="button" className="icon" onClick={onClose} title="Fechar">
            ✕
          </button>
        ) : null}
      </div>

      <button
        type="button"
        className="new-chat"
        onClick={() => {
          startNewChat()
          onClose?.()
        }}
      >
        <span aria-hidden>＋</span> Nova conversa
      </button>

      <input
        className="search"
        placeholder="Buscar conversas…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />

      <div className="sessions">
        {groups.length === 0 ? <p className="empty-hint">Nenhuma conversa ainda.</p> : null}
        {groups.map(([bucket, sessions]) => (
          <div key={bucket} className="session-group">
            <h4>{BUCKET_LABELS[bucket] ?? bucket}</h4>
            <ul>
              {sessions.map((session) => (
                <SessionRow key={session.id} session={session} active={session.id === state.activeSessionID} />
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="sidebar-foot">
        <span className={`dot ${state.connection}`} aria-hidden />
        <span className="foot-text">{connectionLabel}</span>
        {state.config ? (
          <button
            type="button"
            className="foot-dir"
            title={`${state.config.directory} — clique para trocar de diretório`}
            onClick={() => {
              const next = window.prompt("Diretório de trabalho:", state.config?.directory ?? "")
              if (next) void setDirectory(next)
            }}
          >
            {state.config.directory}
          </button>
        ) : null}
        <button
          type="button"
          className={`foot-net ${state.network?.enabled ? "on" : ""}`}
          title={
            state.network?.enabled
              ? "Acesso pela rede ativado — clique para gerenciar"
              : "Acesso pela rede desativado — clique para ativar"
          }
          onClick={() => setNetworkOpen((open) => !open)}
        >
          <span aria-hidden>🌐</span>
        </button>
        {networkOpen ? <NetworkPanel onClose={() => setNetworkOpen(false)} /> : null}
      </div>
    </aside>
  )
}
