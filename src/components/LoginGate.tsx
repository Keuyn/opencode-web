import { useState, type FormEvent } from "react"
import { login } from "../lib/store"

export function LoginGate() {
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const value = password.trim()
    if (!value || busy) return
    setBusy(true)
    setError(null)
    try {
      await login(value)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-gate">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo" aria-hidden>
          🥒
        </div>
        <h1>OpenCode Web</h1>
        <p>Esta instalação está acessível pela rede. Informe a senha de acesso para continuar.</p>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          placeholder="Senha de acesso"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error ? <div className="login-error">{error}</div> : null}
        <button type="submit" className="primary" disabled={!password.trim() || busy}>
          {busy ? "Entrando…" : "Entrar"}
        </button>
        <span className="login-hint">A senha aparece no terminal onde o servidor foi iniciado.</span>
      </form>
    </div>
  )
}
