import { useEffect, useState } from "react"
import { useAppState } from "../lib/useStore"
import { forgetDevice, loadDevices, patchDevice } from "../lib/store"
import { relativeTime } from "../lib/format"
import type { DeviceInfo } from "../lib/types"

type Runner = (action: () => Promise<void>) => Promise<void>

/**
 * Devices known by the server. Each one is identified by where the request came
 * from (loopback is always the owner), and owns one project folder in the root.
 */
export function DeviceSection() {
  const state = useAppState()
  const devices = state.devices
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void loadDevices()
  }, [])

  const owner = Boolean(devices?.owner)
  const projects = devices?.projects ?? []

  const run: Runner = async (action) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
      setBusy(false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setBusy(false)
    }
  }

  return (
    <div className="network-body">
      <p className="network-note">
        Cada aparelho tem o próprio projeto: as conversas e os arquivos não se misturam. O servidor continua sendo
        este computador.
      </p>

      {devices?.devices.length ? (
        <ul className="device-list">
          {devices.devices.map((device) => (
            <DeviceRow key={device.key} device={device} projects={projects} editable={owner} busy={busy} run={run} />
          ))}
        </ul>
      ) : (
        <p className="network-note">Nenhum aparelho registrado ainda.</p>
      )}

      <p className="network-note">
        Raiz: <code>{devices?.root ?? ""}</code>
      </p>

      {!owner ? <p className="network-note">Só o computador do servidor pode editar esta lista.</p> : null}
      {error ? <div className="network-error">{error}</div> : null}
    </div>
  )
}

function DeviceRow({
  device,
  projects,
  editable,
  busy,
  run,
}: {
  device: DeviceInfo
  projects: string[]
  editable: boolean
  busy: boolean
  run: Runner
}) {
  const [name, setName] = useState(device.name)

  useEffect(() => {
    setName(device.name)
  }, [device.name])

  function saveName() {
    const value = name.trim()
    if (!value || value === device.name) return
    void run(() => patchDevice(device.key, { name: value }))
  }

  return (
    <li className={`device-row ${device.self ? "self" : ""}`}>
      <div className="device-top">
        {editable ? (
          <input
            className="device-name"
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            onBlur={saveName}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur()
            }}
          />
        ) : (
          <span className="device-name">{device.name}</span>
        )}
        {device.owner ? <span className="device-badge">admin</span> : null}
        {device.self ? <span className="device-badge self">este</span> : null}
      </div>

      <div className="device-meta">
        <span>{device.ip || device.key}</span>
        <span aria-hidden>·</span>
        <span>{device.lastSeen ? `visto ${relativeTime(device.lastSeen)}` : "nunca acessou"}</span>
      </div>

      <div className="device-actions">
        {editable ? (
          <select
            className="project-select"
            value={device.project}
            disabled={busy}
            onChange={(event) => {
              const next = event.target.value
              void run(async () => {
                await patchDevice(device.key, { project: next })
                if (device.self) window.location.reload()
              })
            }}
          >
            <option value="">raiz</option>
            {projects.map((project) => (
              <option key={project} value={project}>
                {project}
              </option>
            ))}
            {device.project && !projects.includes(device.project) ? (
              <option value={device.project}>{device.project}</option>
            ) : null}
          </select>
        ) : (
          <span className="device-project">{device.project || "raiz"}</span>
        )}

        {editable && device.key !== "local" ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => patchDevice(device.key, { owner: !device.owner }))}
            >
              {device.owner ? "Tirar admin" : "Dar admin"}
            </button>
            <button
              type="button"
              className="device-danger"
              disabled={busy}
              onClick={() => {
                if (!window.confirm(`Esquecer "${device.name}"?`)) return
                const wipe = window.confirm(
                  "Apagar também a pasta do projeto dele?\n\nOK = apagar os arquivos\nCancelar = manter no disco",
                )
                void run(() => forgetDevice(device.key, wipe))
              }}
            >
              Esquecer
            </button>
          </>
        ) : null}
      </div>
    </li>
  )
}
