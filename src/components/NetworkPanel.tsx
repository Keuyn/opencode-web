import { useEffect, useRef, useState } from "react"
import { QRCodeSVG } from "qrcode.react"
import { useAppState } from "../lib/useStore"
import { loadNetwork, logout, setNetwork } from "../lib/store"

function randomPassword(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function NetworkPanel({ onClose }: { onClose: () => void }) {
  const state = useAppState()
  const network = state.network
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void loadNetwork()
  }, [])

  useEffect(() => {
    if (network?.token && !password) setPassword(network.token)
  }, [network?.token, password])

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

  const enabled = Boolean(network?.enabled)
  const urls = network?.urls ?? []
  const primary = urls[0] ?? (network ? `http://${network.host}:${network.port}` : "")
  const value = password.trim()
  const changed = enabled && value.length > 0 && value !== network?.token

  async function apply(next: boolean) {
    if (busy) return
    setError(null)
    if (next && !value) {
      setError("Defina uma senha para ativar o acesso pela rede.")
      return
    }
    setBusy(true)
    try {
      await setNetwork(next, next ? value : undefined)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setBusy(false)
    }
  }

  function copy(text: string, label: string) {
    void navigator.clipboard.writeText(text).catch(() => {})
    setCopied(label)
    window.setTimeout(() => setCopied(null), 1500)
  }

  return (
    <div className="network-panel" ref={root}>
      <div className="network-head">
        <span>Rede local</span>
        <button type="button" className="icon" onClick={onClose} title="Fechar">
          ✕
        </button>
      </div>

      <div className="network-body">
        {network?.locked ? (
          <p className="network-note">
            O endereço está fixado pela variável <code>HOST</code>, então o interruptor não se aplica.
          </p>
        ) : (
          <label className="network-switch">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={(event) => void apply(event.target.checked)}
            />
            <span>Disponibilizar na rede local</span>
          </label>
        )}

        <p className="network-note">
          {enabled
            ? "Outros aparelhos na mesma rede abrem o endereço abaixo e informam a senha."
            : "Desativado, somente este computador consegue acessar."}
        </p>

        <div className="network-field">
          <label htmlFor="network-password">Senha de acesso</label>
          <div className="network-input">
            <input
              id="network-password"
              value={password}
              disabled={busy}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="senha"
            />
            <button type="button" disabled={busy} onClick={() => setPassword(randomPassword())}>
              Gerar
            </button>
          </div>
          {changed ? (
            <button type="button" className="network-save" disabled={busy} onClick={() => void apply(true)}>
              Salvar nova senha
            </button>
          ) : null}
        </div>

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

        {error ? <div className="network-error">{error}</div> : null}
        {busy ? <div className="network-note">Aplicando… a página vai recarregar.</div> : null}

        {network?.authRequired ? (
          <button type="button" className="network-logout" onClick={() => void logout()}>
            Sair deste dispositivo
          </button>
        ) : null}
      </div>
    </div>
  )
}
