import { useEffect, useRef, useState } from "react"
import { useAppState } from "../lib/useStore"
import {
  backToParent,
  deleteAgent,
  openSubsession,
  saveAgent,
  setAgent,
  type AgentDraft,
} from "../lib/store"
import type { SessionInfo } from "../lib/types"

type Tab = "agentes" | "criar"

const EMPTY_DRAFT: AgentDraft = { id: "", description: "", system: "", mode: "primary" }

function sessionLabel(session: SessionInfo): string {
  return session.title?.trim() || "Subagente"
}

function RunningRow({
  session,
  running,
  current,
  onOpen,
}: {
  session: SessionInfo
  running: boolean
  current: boolean
  onOpen: () => void
}) {
  return (
    <button type="button" className={`agent-run ${running ? "running" : ""}`} onClick={onOpen}>
      <span className="agent-run-dot" aria-hidden>
        {running ? <span className="spinner" /> : "○"}
      </span>
      <span className="agent-run-body">
        <span className="agent-run-title">{sessionLabel(session)}</span>
        <span className="agent-run-meta">
          {session.agent ?? "subagente"}
          {running ? " · rodando" : session.outcome ? ` · ${session.outcome}` : " · ocioso"}
          {current ? " · aberto" : ""}
        </span>
      </span>
    </button>
  )
}

export function AgentPanel({ onClose }: { onClose: () => void }) {
  const state = useAppState()
  const [tab, setTab] = useState<Tab>("agentes")
  const [draft, setDraft] = useState<AgentDraft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("mousedown", onPointer)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onPointer)
      document.removeEventListener("keydown", onKey)
    }
  }, [onClose])

  const runningSet = new Set(state.running)
  const children = state.children
  const currentAgent = state.agents.find((item) => item.id === state.agent)

  async function handleSave() {
    const id = draft.id.trim()
    if (!id) {
      setFailure("Informe um nome para o agente.")
      return
    }
    setSaving(true)
    setFailure(null)
    setNotice(null)
    try {
      const result = await saveAgent({ ...draft, id })
      setNotice(`Agente "${id}" salvo em ${result.file}.`)
      setDraft(EMPTY_DRAFT)
      setTab("agentes")
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    setFailure(null)
    setNotice(null)
    try {
      await deleteAgent(id)
      setNotice(`Agente "${id}" removido.`)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="agent-panel" ref={root} role="dialog" aria-label="Agentes">
      <div className="agent-panel-head">
        <div className="agent-panel-tabs">
          <button
            type="button"
            className={tab === "agentes" ? "active" : ""}
            onClick={() => setTab("agentes")}
          >
            Agentes
          </button>
          <button type="button" className={tab === "criar" ? "active" : ""} onClick={() => setTab("criar")}>
            + Criar
          </button>
        </div>
        <button type="button" className="icon" onClick={onClose} title="Fechar">
          ✕
        </button>
      </div>

      {notice ? <div className="agent-notice ok">{notice}</div> : null}
      {failure ? <div className="agent-notice error">{failure}</div> : null}

      {tab === "agentes" ? (
        <div className="agent-panel-body">
          <section className="agent-section">
            <h4>Agente principal</h4>
            <p className="agent-section-hint">Quem responde na conversa atual.</p>
            <ul className="agent-list">
              {state.agents.map((agent) => {
                const custom = state.customAgents.includes(agent.id)
                return (
                  <li key={agent.id} className={`agent-item ${agent.id === state.agent ? "selected" : ""}`}>
                    <button type="button" className="agent-item-main" onClick={() => void setAgent(agent.id)}>
                      <span className="agent-item-name">
                        {agent.name}
                        {custom ? <span className="agent-tag">personalizado</span> : null}
                      </span>
                      {agent.description ? <span className="agent-item-desc">{agent.description}</span> : null}
                    </button>
                    {custom ? (
                      <button
                        type="button"
                        className="agent-item-remove"
                        title="Remover agente"
                        onClick={() => void handleDelete(agent.id)}
                      >
                        ✕
                      </button>
                    ) : null}
                  </li>
                )
              })}
              {state.agents.length === 0 ? <li className="agent-empty">Nenhum agente principal disponível.</li> : null}
            </ul>
          </section>

          {state.subagents.length > 0 ? (
            <section className="agent-section">
              <h4>Subagentes</h4>
              <p className="agent-section-hint">
                Acionados automaticamente pelo OpenCode para tarefas paralelas.
              </p>
              <ul className="agent-list">
                {state.subagents.map((agent) => (
                  <li key={agent.id} className="agent-item muted">
                    <div className="agent-item-main">
                      <span className="agent-item-name">{agent.name}</span>
                      {agent.description ? <span className="agent-item-desc">{agent.description}</span> : null}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="agent-section">
            <h4>
              Rodando agora
              {state.running.length > 0 ? <span className="agent-count">{state.running.length}</span> : null}
            </h4>
            {children.length === 0 && !runningSet.has(state.activeSessionID ?? "") ? (
              <p className="agent-empty">Nenhum agente ativo no momento.</p>
            ) : (
              <div className="agent-running">
                {state.activeSessionID && runningSet.has(state.activeSessionID) ? (
                  <div className="agent-run running static">
                    <span className="agent-run-dot" aria-hidden>
                      <span className="spinner" />
                    </span>
                    <span className="agent-run-body">
                      <span className="agent-run-title">{currentAgent?.name ?? "Agente principal"}</span>
                      <span className="agent-run-meta">conversa atual · rodando</span>
                    </span>
                  </div>
                ) : null}
                {children.map((child) => (
                  <RunningRow
                    key={child.id}
                    session={child}
                    running={runningSet.has(child.id)}
                    current={child.id === state.activeSessionID}
                    onOpen={() => {
                      void openSubsession(child.id)
                      onClose()
                    }}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      ) : (
        <div className="agent-panel-body">
          <div className="agent-form">
            <label className="field">
              <span>Nome (id)</span>
              <input
                value={draft.id}
                placeholder="ex.: revisor"
                autoFocus
                spellCheck={false}
                onChange={(event) => setDraft({ ...draft, id: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Descrição</span>
              <input
                value={draft.description ?? ""}
                placeholder="Aparece na lista de agentes"
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Modo</span>
              <select
                value={draft.mode ?? "primary"}
                onChange={(event) => setDraft({ ...draft, mode: event.target.value })}
              >
                <option value="primary">primary (aparece no seletor)</option>
                <option value="subagent">subagent (tarefas paralelas)</option>
                <option value="all">all (ambos)</option>
              </select>
            </label>
            <label className="field">
              <span>Prompt do sistema</span>
              <textarea
                rows={6}
                value={draft.system ?? ""}
                placeholder="Você é um agente que…"
                onChange={(event) => setDraft({ ...draft, system: event.target.value })}
              />
            </label>
            <p className="agent-form-hint">
              Salvo em <code>{state.agentConfigFile ?? "opencode.json"}</code> deste projeto e recarregado no
              serviço automaticamente.
            </p>
            <div className="agent-form-actions">
              <button type="button" className="primary" disabled={saving} onClick={() => void handleSave()}>
                {saving ? "Salvando…" : "Criar agente"}
              </button>
              <button type="button" onClick={() => setDraft(EMPTY_DRAFT)} disabled={saving}>
                Limpar
              </button>
            </div>
          </div>
        </div>
      )}

      {state.returnSessionID ? (
        <button type="button" className="agent-back" onClick={() => void backToParent()}>
          ← Voltar para a conversa principal
        </button>
      ) : null}
    </div>
  )
}
