import { useEffect, useRef } from "react"
import { useAppState } from "../lib/useStore"
import { interrupt, sendPrompt, setDelivery } from "../lib/store"

export function Composer({
  value,
  onChange,
  showHint = true,
}: {
  value: string
  onChange: (value: string) => void
  showHint?: boolean
}) {
  const state = useAppState()
  const textarea = useRef<HTMLTextAreaElement>(null)
  const busy = state.status === "busy" || state.status === "retry"

  useEffect(() => {
    const element = textarea.current
    if (!element) return
    element.style.height = "auto"
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`
  }, [value])

  useEffect(() => {
    const element = textarea.current
    if (!element) return
    const focus = (event: KeyboardEvent) => {
      if (event.key === "/" && document.activeElement !== element && !event.metaKey && !event.ctrlKey) {
        const target = event.target as HTMLElement | null
        if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return
        event.preventDefault()
        element.focus()
      }
    }
    window.addEventListener("keydown", focus)
    return () => window.removeEventListener("keydown", focus)
  }, [])

  const submit = () => {
    const text = value.trim()
    if (!text) return
    onChange("")
    void sendPrompt(text)
  }

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          ref={textarea}
          rows={1}
          value={value}
          placeholder="Pergunte, peça para editar arquivos, rodar comandos…"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer-actions">
          {busy ? (
            <div className="delivery-toggle" title="Como enviar enquanto o agente trabalha">
              <button
                type="button"
                className={state.delivery === "steer" ? "active" : ""}
                onClick={() => setDelivery("steer")}
              >
                Agora
              </button>
              <button
                type="button"
                className={state.delivery === "queue" ? "active" : ""}
                onClick={() => setDelivery("queue")}
              >
                Fila
              </button>
            </div>
          ) : null}
          {busy ? (
            <button type="button" className="stop" title="Interromper" onClick={() => void interrupt()}>
              Parar
            </button>
          ) : null}
          <button type="button" className="send" disabled={!value.trim()} onClick={submit} title="Enviar">
            ➤
          </button>
        </div>
      </div>
      {showHint ? (
        <div className="composer-hint">
          <span>
            <kbd>Enter</kbd> envia · <kbd>Shift</kbd>+<kbd>Enter</kbd> nova linha
          </span>
          {busy ? (
            <span className="composer-delivery">
              {state.delivery === "steer"
                ? "O agente lê sua mensagem enquanto trabalha."
                : "Sua mensagem entra na fila para depois da execução atual."}
            </span>
          ) : state.config ? (
            <span className="composer-dir">{state.config.directory}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
