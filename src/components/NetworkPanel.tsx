import { useEffect, useRef, useState } from "react"
import { QRCodeSVG } from "qrcode.react"
import { useAppState } from "../lib/useStore"
import { changePassword, loadNetwork, logout, setNetwork } from "../lib/store"
import { copyText } from "../lib/browser"
import { ProjectSection } from "./ProjectPanel"
import { DeviceSection } from "./DevicePanel"

const MIN_PASSWORD = 6

function randomPassword(): string {
  const bytes = new Uint8Array(9)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export type PanelTab = "project" | "network" | "devices"

const TABS: Array<{ id: PanelTab; label: string }> = [
  { id: "project", label: "Projeto" },
  { id: "network", label: "Rede" },
  { id: "devices", label: "Aparelhos" },
]

export function NetworkPanel({
  initialTab = "network",
  onClose,
}: {
  initialTab?: PanelTab
  onClose: () => void
}) {
  const [tab, setTab] = useState<PanelTab>(initialTab)
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

  return (
    <div className="network-panel" ref={root}>
      <div className="network-head">
        <span>Servidor e acesso</span>
        <button type="button" className="icon" onClick={onClose} title="Fechar">
          ✕
        </button>
      </div>

      <div className="panel-tabs" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`panel-tab ${tab === item.id ? "active" : ""}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "project" ? <ProjectSection /> : null}
      {tab === "network" ? <NetworkSection /> : null}
      {tab === "devices" ? <DeviceSection /> : null}
    </div>
  )
}

function NetworkSection() {
  const state = useAppState()
  const network = state.network
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    void loadNetwork()
  }, [])

  const enabled = Boolean(network?.enabled)
  const locked = Boolean(network?.locked)
  const fromEnv = Boolean(network?.env)
  const custom = Boolean(network?.custom)
  const owner = Boolean(state.config?.owner)
  const urls = network?.urls ?? []
  const primary = urls[0] ?? (network ? `http://${network.host}:${network.port}` : "")
  const value = draft.trim()
  const canSave = !busy && value.length >= MIN_PASSWORD && value !== network?.password

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

  function copy(text: string, label: string) {
    void copyText(text)
    setCopied(label)
    window.setTimeout(() => setCopied(null), 1500)
  }

  async function save() {
    await run(async () => {
      await changePassword(value)
      setDraft("")
      setBusy(false)
    })
  }

  async function reset() {
    await run(async () => {
      await changePassword(null)
      setDraft("")
      setBusy(false)
    })
  }

  return (
    <div className="network-body">
      {locked ? (
        <p className="network-note">
          O endereço está fixado pela variável <code>HOST</code>, então o interruptor não se aplica.
        </p>
      ) : (
        <label className="network-switch">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy || !owner}
            onChange={(event) => void run(() => setNetwork(event.target.checked))}
          />
          <span>Disponibilizar na rede local</span>
        </label>
      )}

      <p className="network-note">
        {enabled
          ? "Outros aparelhos na mesma rede abrem o endereço abaixo e informam a senha."
          : "Desativado, somente este computador consegue acessar."}
      </p>

      {enabled && primary ? (
        <div className="network-field">
          <label>Endereço de acesso</label>
          <div className="network-input">
            <input readOnly value={primary} onFocus={(event) => event.currentTarget.select()} />
            <button type="button" onClick={() => copy(primary, "url")}>
              {copied === "url" ? "Copiado" : "Copiar"}
            </button>
          </div>
          <div className="network-qr">
            <QRCodeSVG value={primary} size={140} bgColor="#ffffff" fgColor="#0f1115" level="M" />
          </div>
          <p className="network-note">Aponte a câmera do celular e digite a senha no aparelho.</p>
          {urls.length > 1 ? (
            <ul className="network-urls">
              {urls.map((url) => (
                <li key={url}>
                  <button type="button" onClick={() => copy(url, url)} title="Copiar">
                    {url}
                  </button>
                  <span aria-hidden>{copied === url ? "✓" : ""}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="network-field">
        <label>Senha para os outros aparelhos</label>
        <div className="network-input">
          <input
            id="network-password"
            readOnly
            value={network?.password ?? ""}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button type="button" onClick={() => copy(network?.password ?? "", "senha")}>
            {copied === "senha" ? "Copiado" : "Copiar"}
          </button>
        </div>
        {fromEnv ? (
          <p className="network-note">
            Definida pela variável <code>WEB_TOKEN</code>; não pode ser alterada aqui.
          </p>
        ) : custom ? (
          <p className="network-note">Senha personalizada: vale para os próximos acessos e reinícios.</p>
        ) : (
          <p className="network-note">
            Sem senha personalizada: é usada a <strong>senha do terminal</strong>, sorteada a cada execução e
            mostrada no log do servidor.
          </p>
        )}
      </div>

      {fromEnv || !owner ? null : (
        <div className="network-field">
          <label htmlFor="network-new">Alterar senha</label>
          <div className="network-input">
            <input
              id="network-new"
              type="text"
              value={draft}
              disabled={busy}
              placeholder={`nova senha (${MIN_PASSWORD}+ caracteres)`}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canSave) void save()
              }}
            />
            <button type="button" disabled={busy} onClick={() => setDraft(randomPassword())}>
              Gerar
            </button>
          </div>
          <div className="network-actions">
            <button type="button" className="network-primary" disabled={!canSave} onClick={() => void save()}>
              {busy ? "Salvando…" : "Salvar senha"}
            </button>
            {custom ? (
              <button type="button" disabled={busy} onClick={() => void reset()}>
                Voltar à senha do terminal
              </button>
            ) : null}
          </div>
          <p className="network-note">
            Vale na hora, sem reiniciar. Quem já estava conectado precisa informar a nova senha de novo.
          </p>
        </div>
      )}

      {!owner ? (
        <p className="network-note">
          Só o computador do servidor pode mudar a senha e o interruptor de rede.
        </p>
      ) : null}

      {error ? <div className="network-error">{error}</div> : null}

      {network?.authRequired ? (
        <button type="button" className="network-logout" onClick={() => void logout()}>
          Sair deste dispositivo
        </button>
      ) : null}
    </div>
  )
}
