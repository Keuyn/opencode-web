/**
 * Teste de integração do reducer de eventos do front-end.
 * Roda o store real (sem React) contra o proxy local.
 * Uso: npm run smoke
 */
const origin = process.env.SMOKE_URL ?? "http://127.0.0.1:3123"
const realFetch = globalThis.fetch

;(globalThis as unknown as { window: unknown }).window = { location: { origin } }
;(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (fn: (t: number) => void) =>
  setTimeout(() => fn(Date.now()), 16)
;(globalThis as unknown as { fetch: unknown }).fetch = (input: unknown, init?: unknown) => {
  if (typeof input === "string" && input.startsWith("/")) return realFetch(`${origin}${input}`, init as RequestInit)
  return realFetch(input as RequestInfo, init as RequestInit)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const store = await import("../src/lib/store")

store.subscribe(() => {})

await store.bootstrap()
await sleep(500)
let state = store.getState()
console.log("conexão:", state.connection, "| agentes:", state.agents.map((a) => a.id).join(","), "| sessões:", state.sessions.length)
console.log("modelo padrão:", JSON.stringify(state.model), "| agente padrão:", state.agent)

await store.setModel({ providerID: "opencode", id: "big-pickle" })
const sessionID = await store.createSession()
console.log("sessão criada:", sessionID)

await store.sendPrompt("Liste os arquivos da raiz deste diretório usando o comando de shell `ls -1` e responda em uma linha com a contagem.")
console.log("prompt enviado, aguardando…")

for (let attempt = 0; attempt < 240; attempt += 1) {
  state = store.getState()
  const assistant = state.messages.filter((message) => message.role === "assistant")
  const done = assistant.length > 0 && assistant[assistant.length - 1].done
  if (done && state.status === "idle") break
  await sleep(500)
}

state = store.getState()
console.log("status final:", state.status, "| erro:", state.error)
console.log("permissões pendentes:", state.permissions.length, "| forms pendentes:", state.forms.length)
for (const message of state.messages) {
  if (message.role === "user") {
    console.log("USER   :", message.text.slice(0, 90))
    continue
  }
  console.log(`ASSIST : agent=${message.agent} model=${JSON.stringify(message.model)} tokens=${JSON.stringify(message.tokens)}`)
  for (const part of message.parts) {
    if (part.kind === "text") console.log("   texto    :", JSON.stringify(part.text.slice(0, 90)))
    else if (part.kind === "reasoning") console.log("   raciocínio:", JSON.stringify(part.text.slice(0, 70)))
    else
      console.log(
        "   tool     :",
        part.tool.name,
        part.tool.status,
        JSON.stringify(part.tool.input ?? part.tool.inputText).slice(0, 100),
        "→",
        JSON.stringify((part.tool.content[0] as { text?: string } | undefined)?.text ?? part.tool.error ?? "").slice(0, 90),
      )
  }
}

await store.removeSession(sessionID)
console.log("sessão de teste removida")
console.log("sessões restantes:", store.getState().sessions.length)
process.exit(0)
