import { useAppState } from "../lib/useStore"
import { setModel, interrupt, setAgentPanelOpen } from "../lib/store"
import { AgentPanel } from "./AgentPanel"

function StatusPill() {
  const state = useAppState()
  if (state.status === "busy") {
    return (
      <span className="pill busy">
        <span className="spinner" aria-hidden /> {state.statusMessage ?? "trabalhando…"}
      </span>
    )
  }
  if (state.status === "retry") {
    return <span className="pill warn">{state.statusMessage ?? "tentando novamente…"}</span>
  }
  if (state.status === "error") {
    return <span className="pill error">erro</span>
  }
  return null
}

export function Header({ onMenu }: { onMenu: () => void }) {
  const state = useAppState()
  const session = state.activeSession
  const runningNow = state.children.filter((child) => state.running.includes(child.id)).length
  const modelsByProvider = state.models.reduce<Record<string, typeof state.models>>((grouped, model) => {
    const list = grouped[model.providerID] ?? []
    list.push(model)
    grouped[model.providerID] = list
    return grouped
  }, {})

  const modelValue = state.model ? `${state.model.providerID}::${state.model.id}` : ""
  const currentAgent = state.agents.find((item) => item.id === state.agent)

  return (
    <header className="header">
      <button type="button" className="icon menu" onClick={onMenu} title="Conversas">
        ☰
      </button>
      <div className="header-title" title={session?.title ?? "Nova conversa"}>
        {session?.title || "Nova conversa"}
      </div>
      <div className="header-controls">
        <StatusPill />
        <button
          type="button"
          className={`picker agent-trigger ${state.agentPanelOpen ? "open" : ""}`}
          title="Agentes"
          onClick={() => setAgentPanelOpen(!state.agentPanelOpen)}
        >
          <span aria-hidden>🧭</span>
          <span className="agent-trigger-label">{currentAgent?.name ?? state.agent ?? "agentes"}</span>
          {runningNow > 0 ? <span className="agent-trigger-badge">{runningNow}</span> : null}
          <span aria-hidden className="agent-trigger-caret">▾</span>
        </button>
        <label className="picker" title="Modelo">
          <span aria-hidden>🧠</span>
          <select
            value={modelValue}
            onChange={(event) => {
              const [providerID, id] = event.target.value.split("::")
              if (providerID && id) void setModel({ providerID, id })
            }}
          >
            {state.models.length === 0 ? <option value="">carregando…</option> : null}
            {Object.entries(modelsByProvider).map(([provider, models]) => (
              <optgroup key={provider} label={provider}>
                {models.map((model) => (
                  <option key={`${provider}::${model.modelID ?? model.id}`} value={`${provider}::${model.modelID ?? model.id}`}>
                    {model.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        {state.status === "busy" ? (
          <button type="button" className="stop" onClick={() => void interrupt()}>
            Parar
          </button>
        ) : null}
      </div>
      {state.agentPanelOpen ? <AgentPanel onClose={() => setAgentPanelOpen(false)} /> : null}
    </header>
  )
}
