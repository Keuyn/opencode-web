import { useEffect, useState } from "react"
import { useAppState } from "../lib/useStore"
import { chooseProject, downloadProject, loadDevices } from "../lib/store"

/**
 * Project picker. Every device works inside one folder of the projects root, and
 * the OpenCode sessions are scoped by directory — switching folders swaps the
 * whole conversation list. Only the owner (the server machine) can switch.
 */
export function ProjectSection() {
  const state = useAppState()
  const config = state.config
  const devices = state.devices
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void loadDevices()
  }, [])

  const owner = Boolean(config?.owner)
  const current = config?.project ?? ""
  const projects = devices?.projects ?? []

  async function run(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setBusy(false)
    }
  }

  return (
    <div className="network-body">
      <div className="network-field">
        <label>Pasta onde o agente trabalha</label>
        <div className="network-input">
          <input
            id="project-dir"
            readOnly
            value={config?.directory ?? ""}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button type="button" onClick={() => downloadProject()}>
            Baixar .zip
          </button>
        </div>
        <p className="network-note">
          Raiz dos projetos: <code>{devices?.root ?? config?.projectRoot ?? ""}</code>
        </p>
      </div>

      {owner ? (
        <>
          <div className="network-field">
            <label htmlFor="project-select">Projeto atual</label>
            <select
              id="project-select"
              className="project-select"
              value={current}
              disabled={busy}
              onChange={(event) => void run(() => chooseProject(event.target.value))}
            >
              <option value="">raiz de projetos (todos)</option>
              {projects.map((project) => (
                <option key={project} value={project}>
                  {project}
                </option>
              ))}
            </select>
            <p className="network-note">
              As conversas ficam separadas por projeto — trocar de pasta recarrega a interface.
            </p>
          </div>

          <div className="network-field">
            <label htmlFor="project-new">Novo projeto</label>
            <div className="network-input">
              <input
                id="project-new"
                value={name}
                disabled={busy}
                placeholder="nome-da-pasta"
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && name.trim()) void run(() => chooseProject(name, true))
                }}
              />
              <button type="button" disabled={busy || !name.trim()} onClick={() => void run(() => chooseProject(name, true))}>
                Criar
              </button>
            </div>
            <p className="network-note">Cria a pasta na raiz e passa a usá-la.</p>
          </div>
        </>
      ) : (
        <p className="network-note">
          O projeto deste aparelho é definido no computador do servidor. Suas conversas e seus arquivos ficam
          separados dos outros aparelhos.
        </p>
      )}

      <p className="network-note">
        O zip ignora o que dá para gerar de novo (<code>node_modules</code>, <code>dist</code>, <code>build</code>,{" "}
        <code>.git</code>, caches) e sai com a pasta do projeto na raiz.
      </p>

      {error ? <div className="network-error">{error}</div> : null}
    </div>
  )
}
