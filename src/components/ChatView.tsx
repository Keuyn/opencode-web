import { useEffect, useLayoutEffect, useRef } from "react"
import { useAppState } from "../lib/useStore"
import { Composer } from "./Composer"
import { FormCard } from "./FormCard"
import { Message } from "./Message"
import { PermissionCard } from "./PermissionCard"
import {
  backToParent,
  cancelInbox,
  dismissError,
  loadOlderMessages,
  setInboxDelivery,
} from "../lib/store"
import type { SessionInboxInfo } from "../lib/types"

const SUGGESTIONS = [
  "Explique a estrutura deste projeto",
  "Quais arquivos você mudaria para adicionar autenticação?",
  "Rode os testes e corrija o que falhar",
  "Revise o último commit e aponte riscos",
]

function inboxText(item: SessionInboxInfo): string {
  if (item.type === "user") return item.payload.text
  if (item.type === "synthetic") return item.payload.text
  if (item.type === "compaction") return "Compactação de contexto"
  return "Movimentação de sessão"
}

function InboxList({ inbox }: { inbox: SessionInboxInfo[] }) {
  if (inbox.length === 0) return null
  return (
    <div className="inbox">
      <div className="inbox-head">
        {inbox.length === 1 ? "1 mensagem aguardando" : `${inbox.length} mensagens aguardando`}
      </div>
      {inbox.map((item) => (
        <div key={item.id} className="inbox-item">
          <span className={`inbox-mode ${item.delivery}`}>
            {item.delivery === "steer" ? "agora" : "fila"}
          </span>
          <span className="inbox-text" title={inboxText(item)}>
            {inboxText(item)}
          </span>
          <button
            type="button"
            className="inbox-action"
            onClick={() => void setInboxDelivery(item.id, item.delivery === "steer" ? "queue" : "steer")}
          >
            {item.delivery === "steer" ? "Enfileirar" : "Enviar agora"}
          </button>
          <button
            type="button"
            className="inbox-action danger"
            title="Remover da fila"
            onClick={() => void cancelInbox(item.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}

export function ChatView({ draft, setDraft }: { draft: string; setDraft: (value: string) => void }) {
  const state = useAppState()
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const restore = useRef<{ height: number; top: number } | null>(null)

  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const onScroll = () => {
      stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 140
    }
    element.addEventListener("scroll", onScroll, { passive: true })
    return () => element.removeEventListener("scroll", onScroll)
  }, [])

  useEffect(() => {
    const element = scroller.current
    if (element && stick.current) element.scrollTop = element.scrollHeight
  }, [state.messages, state.permissions, state.forms, state.status])

  // Mantém a posição visual ao prepender mensagens antigas.
  useLayoutEffect(() => {
    const element = scroller.current
    const saved = restore.current
    if (!element || !saved) return
    restore.current = null
    element.scrollTop = element.scrollHeight - saved.height + saved.top
  }, [state.messages])

  const lastAssistant = [...state.messages].reverse().find((message) => message.role === "assistant")
  const streaming = state.status === "busy" || state.status === "retry"
  const showThinking = streaming && (!lastAssistant || lastAssistant.done)
  const isEmpty = state.messages.length === 0 && !state.loadingMessages
  const knownMessages = new Set(state.messages.map((message) => message.id))
  const pendingInbox = state.inbox.filter((item) => !knownMessages.has(item.id))

  return (
    <div className="chat">
      {state.returnSessionID ? (
        <div className="subsession-bar">
          <button type="button" onClick={() => void backToParent()}>
            ← Voltar para a conversa principal
          </button>
          <span>
            Você está vendo um subagente{state.activeSession?.agent ? ` (${state.activeSession.agent})` : ""}.
          </span>
        </div>
      ) : null}
      <div className="scroller" ref={scroller}>
        <div className="messages">
          {state.olderCursor && state.messages.length > 0 ? (
            <button
              type="button"
              className="load-older"
              disabled={state.loadingOlder}
              onClick={() => {
                const element = scroller.current
                if (element) restore.current = { height: element.scrollHeight, top: element.scrollTop }
                void loadOlderMessages()
              }}
            >
              {state.loadingOlder ? "Carregando…" : "↑ Carregar mensagens anteriores"}
            </button>
          ) : null}

          {isEmpty ? (
            <div className="welcome">
              <div className="welcome-logo" aria-hidden>
                🥒
              </div>
              <h1>Olá! Como posso ajudar?</h1>
              <p>
                Estou rodando via OpenCode no diretório{" "}
                <code>{state.config?.directory ?? "…"}</code>. Posso ler e editar arquivos, rodar comandos e
                pesquisar na web.
              </p>
              <div className="suggestions">
                {SUGGESTIONS.map((suggestion) => (
                  <button key={suggestion} type="button" onClick={() => setDraft(suggestion)}>
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {state.loadingMessages ? <div className="loading">Carregando conversa…</div> : null}

          {state.messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              streaming={streaming && message.id === lastAssistant?.id}
            />
          ))}

          {showThinking ? (
            <div className="message message-assistant">
              <div className="avatar" aria-hidden>
                🥒
              </div>
              <div className="message-body">
                <div className="thinking">
                  <span className="spinner" aria-hidden /> {state.statusMessage ?? "pensando…"}
                </div>
              </div>
            </div>
          ) : null}

          {state.permissions.map((permission) => (
            <PermissionCard key={permission.id} request={permission} />
          ))}

          {state.forms.map((form) => (
            <FormCard key={form.id} form={form} />
          ))}

          {state.error ? (
            <div className="banner error">
              <span>{state.error}</span>
              <button type="button" onClick={dismissError}>
                ✕
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <InboxList inbox={pendingInbox} />
      <Composer value={draft} onChange={setDraft} />
    </div>
  )
}
