import {
  OpenCode,
  type AgentInfo,
  type FormDetail,
  type FormInfo,
  type ModelInfo,
  type OpenCodeEvent,
  type PermissionRequest,
  type SessionInboxInfo,
  type SessionInfo,
  type SessionMessageAssistantTool,
  type SessionMessageInfo,
} from "@opencode/client"
import type { AppState, ChatMessage, DeliveryMode, ModelRef, Part, ToolCall, ToolContent } from "./types"

export type OpenCodeClient = ReturnType<typeof OpenCode.make>

const initialState: AppState = {
  config: null,
  connection: "connecting",
  sessions: [],
  activeSessionID: null,
  activeSession: null,
  messages: [],
  olderCursor: null,
  loadingOlder: false,
  loadingMessages: false,
  status: "idle",
  statusMessage: null,
  permissions: [],
  forms: [],
  models: [],
  agents: [],
  subagents: [],
  model: null,
  agent: null,
  error: null,
  running: [],
  children: [],
  inbox: [],
  agentPanelOpen: false,
  delivery: "steer",
  returnSessionID: null,
  agentConfigFile: null,
  customAgents: [],
}

let state: AppState = initialState
let version = 0
let client: OpenCodeClient | null = null
let directory = ""
let eventLoopStarted = false

const listeners = new Set<() => void>()
let notifyScheduled = false

function emit() {
  if (notifyScheduled) return
  notifyScheduled = true
  const schedule = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn: () => void) => setTimeout(fn, 16)
  schedule(() => {
    notifyScheduled = false
    version += 1
    for (const listener of listeners) listener()
  })
}

function patch(next: Partial<AppState>) {
  state = { ...state, ...next }
  emit()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getVersion(): number {
  return version
}

export function getState(): AppState {
  return state
}

function api(): OpenCodeClient {
  if (!client) throw new Error("Cliente do OpenCode ainda não foi inicializado")
  return client
}

// ---------------------------------------------------------------- boot

export async function bootstrap() {
  const config = (await fetch("/app/config").then((response) => response.json())) as { directory: string }
  directory = config.directory
  client = OpenCode.make({
    baseUrl: window.location.origin,
    headers: { "x-opencode-directory": encodeURIComponent(directory) },
  })
  patch({ config: { directory } })

  await Promise.allSettled([loadModels(), loadAgents(), loadAgentConfig(), loadSessions()])
  if (state.sessions.length > 0) await openSession(state.sessions[0].id)
  startEventLoop()
  startActivityPoller()
}

function startEventLoop() {
  if (eventLoopStarted) return
  eventLoopStarted = true
  void (async () => {
    for (;;) {
      try {
        const stream = api().event.subscribe()
        for await (const event of stream) {
          if (state.connection !== "online") patch({ connection: "online" })
          try {
            handleEvent(event)
          } catch (error) {
            console.error("[opencode-web] falha ao tratar evento", event, error)
          }
        }
        throw new Error("stream de eventos encerrado")
      } catch (error) {
        if (state.connection !== "offline") patch({ connection: "offline" })
        console.warn("[opencode-web] reconectando stream de eventos", error)
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
    }
  })()
}

// ---------------------------------------------------------------- helpers

const isActive = (sessionID: string) => sessionID === state.activeSessionID

function emptyAssistant(id: string): ChatMessage {
  return { id, role: "assistant", text: "", parts: [], created: Date.now(), done: false }
}

function withPart(
  message: ChatMessage,
  key: string,
  create: (() => Part) | null,
  updater: (part: Part) => Part,
): ChatMessage {
  const index = message.parts.findIndex((part) => part.key === key)
  if (index === -1) {
    if (!create) return message
    return { ...message, parts: [...message.parts, create()] }
  }
  const parts = message.parts.slice()
  parts[index] = updater(parts[index])
  return { ...message, parts }
}

function updateMessage(
  id: string,
  updater: (message: ChatMessage) => ChatMessage,
  create?: () => ChatMessage,
) {
  const index = state.messages.findIndex((message) => message.id === id)
  if (index === -1) {
    if (!create) return
    patch({ messages: [...state.messages, updater(create())] })
    return
  }
  const messages = state.messages.slice()
  messages[index] = updater(messages[index])
  patch({ messages })
}

function upsertAssistant(id: string, updater: (message: ChatMessage) => ChatMessage) {
  updateMessage(id, updater, () => updater(emptyAssistant(id)))
}

function appendText(message: ChatMessage, key: string, delta: string): ChatMessage {
  return withPart(
    message,
    key,
    () => ({ kind: "text", key, text: delta }),
    (part) => (part.kind === "text" ? { ...part, text: part.text + delta } : part),
  )
}

function appendReasoning(message: ChatMessage, key: string, delta: string): ChatMessage {
  return withPart(
    message,
    key,
    () => ({ kind: "reasoning", key, text: delta }),
    (part) => (part.kind === "reasoning" ? { ...part, text: part.text + delta } : part),
  )
}

function updateTool(message: ChatMessage, key: string, updater: (tool: ToolCall) => ToolCall): ChatMessage {
  return withPart(
    message,
    key,
    null,
    (part) => (part.kind === "tool" ? { kind: "tool", key, tool: updater(part.tool) } : part),
  )
}

function ensureTool(message: ChatMessage, key: string, tool: ToolCall): ChatMessage {
  return withPart(
    message,
    key,
    () => ({ kind: "tool", key, tool }),
    (part) => (part.kind === "tool" ? { kind: "tool", key, tool: { ...part.tool, ...tool } } : part),
  )
}

function markLastAssistant(done: boolean, error?: string) {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    if (state.messages[index].role === "assistant") {
      const id = state.messages[index].id
      updateMessage(id, (message) => ({ ...message, done, error: error ?? message.error }))
      return
    }
  }
}

let sessionsReloadTimer: ReturnType<typeof setTimeout> | undefined
function scheduleSessionsReload() {
  if (sessionsReloadTimer) clearTimeout(sessionsReloadTimer)
  sessionsReloadTimer = setTimeout(() => {
    sessionsReloadTimer = undefined
    void loadSessions()
  }, 700)
}

let activityReloadTimer: ReturnType<typeof setTimeout> | undefined
function scheduleActivityReload() {
  if (activityReloadTimer) clearTimeout(activityReloadTimer)
  activityReloadTimer = setTimeout(() => {
    activityReloadTimer = undefined
    void loadActivity()
  }, 400)
}

let activityPoller: ReturnType<typeof setInterval> | undefined
function startActivityPoller() {
  if (activityPoller) return
  activityPoller = setInterval(() => {
    if (typeof document !== "undefined" && document.hidden) return
    void loadActivity()
  }, 5000)
}

// ---------------------------------------------------------------- events

function handleEvent(event: OpenCodeEvent) {
  switch (event.type) {
    case "session.text.started": {
      const data = event.data
      if (!isActive(data.sessionID)) return
      const key = `${data.assistantMessageID}:text:${data.ordinal}`
      upsertAssistant(data.assistantMessageID, (message) => withPart(message, key, () => ({ kind: "text", key, text: "" }), (part) => part))
      return
    }
    case "session.text.delta": {
      const data = event.data
      if (!isActive(data.sessionID)) return
      const key = `${data.assistantMessageID}:text:${data.ordinal}`
      upsertAssistant(data.assistantMessageID, (message) => appendText(message, key, data.delta))
      return
    }
    case "session.reasoning.started": {
      const data = event.data
      if (!isActive(data.sessionID)) return
      const key = `${data.assistantMessageID}:reasoning:${data.ordinal}`
      upsertAssistant(data.assistantMessageID, (message) => withPart(message, key, () => ({ kind: "reasoning", key, text: "" }), (part) => part))
      return
    }
    case "session.reasoning.delta": {
      const data = event.data
      if (!isActive(data.sessionID)) return
      const key = `${data.assistantMessageID}:reasoning:${data.ordinal}`
      upsertAssistant(data.assistantMessageID, (message) => appendReasoning(message, key, data.delta))
      return
    }
    case "session.tool.input.started": {
      const data = event.data
      if (!isActive(data.sessionID)) return
      const key = `${data.assistantMessageID}:tool:${data.id}`
      upsertAssistant(data.assistantMessageID, (message) =>
        ensureTool(message, key, {
          id: data.id,
          name: data.name,
          status: "streaming",
          inputText: "",
          content: [],
          started: event.created,
        }),
      )
      return
    }
    case "session.tool.input.delta": {
      const data = event.data
      if (!isActive(data.sessionID)) return
      const key = `${data.assistantMessageID}:tool:${data.id}`
      upsertAssistant(data.assistantMessageID, (message) =>
        updateTool(message, key, (tool) => ({ ...tool, inputText: tool.inputText + data.delta })),
      )
      return
    }
    case "session.tool.input.ended": {
      const data = event.data
      if (!isActive(data.sessionID)) return
      const key = `${data.assistantMessageID}:tool:${data.id}`
      upsertAssistant(data.assistantMessageID, (message) =>
        updateTool(message, key, (tool) => ({ ...tool, inputText: data.text })),
      )
      return
    }
    case "session.tool.called": {
      const data = event.data
      if (!isActive(data.sessionID)) return
      const key = `${data.assistantMessageID}:tool:${data.id}`
      upsertAssistant(data.assistantMessageID, (message) =>
        updateTool(message, key, (tool) => ({
          ...tool,
          input: data.input as Record<string, unknown>,
          status: data.executed ? "running" : "completed",
        })),
      )
      return
    }
    case "session.tool.progress": {
      const data = event.data
      if (!isActive(data.sessionID)) return
      const key = `${data.assistantMessageID}:tool:${data.id}`
      upsertAssistant(data.assistantMessageID, (message) =>
        updateTool(message, key, (tool) => ({ ...tool, metadata: { ...tool.metadata, ...(data.metadata as Record<string, unknown>) } })),
      )
      return
    }
    case "session.tool.success": {
      const data = event.data
      if (!isActive(data.sessionID)) return
      const key = `${data.assistantMessageID}:tool:${data.id}`
      upsertAssistant(data.assistantMessageID, (message) =>
        updateTool(message, key, (tool) => ({
          ...tool,
          status: "completed",
          content: data.content as ToolContent[],
          metadata: (data.metadata as Record<string, unknown>) ?? tool.metadata,
          finished: event.created,
        })),
      )
      return
    }
    case "session.tool.failed": {
      const data = event.data
      if (!isActive(data.sessionID)) return
      const key = `${data.assistantMessageID}:tool:${data.id}`
      upsertAssistant(data.assistantMessageID, (message) =>
        updateTool(message, key, (tool) => ({
          ...tool,
          status: "error",
          content: (data.content as ToolContent[]) ?? tool.content,
          error: data.error?.message ?? "falha ao executar a ferramenta",
          finished: event.created,
        })),
      )
      return
    }
    case "session.step.started": {
      const data = event.data
      if (!isActive(data.sessionID)) return
      upsertAssistant(data.assistantMessageID, (message) => ({
        ...message,
        agent: data.agent,
        model: data.model as ModelRef,
      }))
      return
    }
    case "session.step.ended": {
      const data = event.data
      if (!isActive(data.sessionID)) return
      upsertAssistant(data.assistantMessageID, (message) => ({
        ...message,
        cost: data.cost,
        tokens: data.tokens ? { input: data.tokens.input, output: data.tokens.output, reasoning: data.tokens.reasoning } : message.tokens,
      }))
      return
    }
    case "session.execution.started": {
      if (!isActive(event.data.sessionID)) return
      patch({ status: "busy", statusMessage: null })
      scheduleActivityReload()
      return
    }
    case "session.execution.succeeded": {
      if (!isActive(event.data.sessionID)) return
      patch({ status: "idle", statusMessage: null })
      markLastAssistant(true)
      scheduleSessionsReload()
      scheduleActivityReload()
      return
    }
    case "session.execution.interrupted": {
      if (!isActive(event.data.sessionID)) return
      patch({ status: "idle", statusMessage: null })
      markLastAssistant(true)
      scheduleSessionsReload()
      scheduleActivityReload()
      return
    }
    case "session.execution.failed": {
      const data = event.data
      if (!isActive(data.sessionID)) return
      patch({ status: "error", statusMessage: null, error: data.error?.message ?? "a execução falhou" })
      markLastAssistant(true, data.error?.message)
      scheduleSessionsReload()
      scheduleActivityReload()
      return
    }
    case "session.idle": {
      if (!isActive(event.data.sessionID)) return
      patch({ status: "idle", statusMessage: null })
      markLastAssistant(true)
      scheduleSessionsReload()
      scheduleActivityReload()
      return
    }
    case "session.status": {
      const data = event.data
      if (!isActive(data.sessionID)) return
      if (data.status.type === "busy") patch({ status: "busy" })
      else if (data.status.type === "idle") patch({ status: "idle", statusMessage: null })
      else patch({ status: "retry", statusMessage: data.status.message })
      return
    }
    case "session.compaction.started": {
      if (!isActive(event.data.sessionID)) return
      patch({ status: "busy", statusMessage: "Compactando o contexto…" })
      return
    }
    case "session.compaction.ended":
    case "session.compaction.failed": {
      if (!isActive(event.data.sessionID)) return
      patch({ statusMessage: null })
      return
    }
    case "session.agent.selected": {
      const data = event.data
      if (!isActive(data.sessionID)) return
      patch({ agent: data.agent })
      return
    }
    case "config.updated": {
      void loadAgents().catch(() => {})
      void loadModels().catch(() => {})
      void loadAgentConfig().catch(() => {})
      return
    }
    case "session.created": {
      scheduleSessionsReload()
      scheduleActivityReload()
      return
    }
    case "session.renamed": {
      const data = event.data
      patch({
        sessions: state.sessions.map((session) =>
          session.id === data.sessionID ? { ...session, title: data.title } : session,
        ),
      })
      return
    }
    case "session.deleted": {
      const data = event.data
      const sessions = state.sessions.filter((session) => session.id !== data.sessionID)
      const children = state.children.filter((session) => session.id !== data.sessionID)
      if (state.activeSessionID === data.sessionID) {
        patch({
          sessions,
          children,
          activeSessionID: null,
          activeSession: null,
          messages: [],
          olderCursor: null,
          permissions: [],
          forms: [],
          inbox: [],
          returnSessionID: null,
        })
      } else {
        patch({ sessions, children })
      }
      scheduleActivityReload()
      return
    }
    case "permission.asked": {
      const data = event.data
      if (!isActive(data.sessionID)) return
      if (state.permissions.some((item) => item.id === data.id)) return
      patch({
        permissions: [
          ...state.permissions,
          {
            id: data.id,
            sessionID: data.sessionID,
            action: data.action,
            resources: data.resources,
            save: data.save,
            metadata: data.metadata,
            source: data.source,
            message: data.message,
          },
        ],
      })
      return
    }
    case "permission.replied": {
      const data = event.data as { requestID?: string; id?: string }
      const requestID = data.requestID ?? data.id
      if (!requestID) return
      patch({ permissions: state.permissions.filter((item) => item.id !== requestID) })
      return
    }
    case "form.created": {
      const data = event.data
      if (!isActive(data.form.sessionID)) return
      if (state.forms.some((item) => item.id === data.form.id)) return
      patch({ forms: [...state.forms, data.form] })
      return
    }
    case "form.replied":
    case "form.cancelled": {
      const data = event.data as { formID?: string; id?: string; form?: { id: string } }
      const formID = data.formID ?? data.id ?? data.form?.id
      if (!formID) return
      patch({ forms: state.forms.filter((item) => item.id !== formID) })
      return
    }
    default:
      return
  }
}

// ---------------------------------------------------------------- loads

export async function loadSessions() {
  const response = await api().session.list({ limit: 100, order: "desc" })
  patch({
    sessions: response.data.filter(
      (session) => !session.parentID && normalize(session.location.directory) === normalize(directory),
    ),
  })
}

function normalize(path: string): string {
  return path.replace(/\/+$/, "")
}

export async function setDirectory(next: string) {
  const trimmed = normalize(next.trim())
  if (!trimmed || trimmed === normalize(directory)) return
  directory = trimmed
  client = OpenCode.make({
    baseUrl: window.location.origin,
    headers: { "x-opencode-directory": encodeURIComponent(directory) },
  })
  patch({
    config: { directory },
    sessions: [],
    activeSessionID: null,
    activeSession: null,
    messages: [],
    olderCursor: null,
    permissions: [],
    forms: [],
    error: null,
    status: "idle",
    statusMessage: null,
    children: [],
    inbox: [],
    running: [],
    returnSessionID: null,
  })
  await loadSessions().catch((error) => patch({ error: errorMessage(error) }))
  await loadAgents().catch(() => {})
  await loadAgentConfig().catch(() => {})
}

export async function loadModels() {
  const response = await api().model.list()
  const models = response.data.filter((model) => model.enabled)
  let model = state.model
  if (!model) {
    const fallback = await api().model.default().catch(() => null)
    const preferred =
      models.find((item) => item.id === "big-pickle") ??
      fallback?.data ??
      models.find((item) => item.providerID === "opencode") ??
      models[0]
    if (preferred) model = { providerID: preferred.providerID, id: preferred.modelID ?? preferred.id }
  }
  patch({ models, model })
}

export async function loadAgents() {
  const response = await api().agent.list()
  const visible = response.data.filter((item) => !item.hidden)
  const agents = visible.filter((item) => item.mode !== "subagent")
  const subagents = visible.filter((item) => item.mode === "subagent")
  let agent = state.agent
  if (!agent || !agents.some((item) => item.id === agent)) {
    const config = await api().config.get().catch(() => null)
    const preferred = (config as { default_agent?: string } | null)?.default_agent
    agent = preferred && agents.some((item) => item.id === preferred) ? preferred : (agents[0]?.id ?? agent)
  }
  patch({ agents, subagents, agent })
}

/** Reads the project config file used for agent definitions. */
export async function loadAgentConfig() {
  try {
    const response = await fetch("/app/agents")
    if (!response.ok) return
    const body = (await response.json()) as { file?: string; agents?: Record<string, unknown> }
    patch({
      agentConfigFile: body.file ?? null,
      customAgents: Object.keys(body.agents ?? {}),
    })
  } catch {
    // silencioso: o painel mostra o estado conhecido
  }
}

/** Resolves which sessions are running and the active conversation's children. */
export async function loadActivity() {
  const sessionID = state.activeSessionID
  try {
    const [active, inbox] = await Promise.all([
      api()
        .session.active()
        .catch(() => ({}) as Record<string, { type: "running" }>),
      sessionID
        ? api()
            .session.inbox.list({ sessionID })
            .catch(() => [] as SessionInboxInfo[])
        : Promise.resolve([] as SessionInboxInfo[]),
    ])
    if (state.activeSessionID !== sessionID) return
    const running = Object.keys(active)
    let children: SessionInfo[] = []
    if (sessionID) {
      const response = await api()
        .session.list({ parentID: sessionID, limit: 50, order: "desc" })
        .catch(() => null)
      if (state.activeSessionID !== sessionID) return
      if (response) children = response.data
    }
    patch({ running, children, inbox })
  } catch {
    // silencioso: mantém o último estado conhecido
  }
}

function toChatMessage(message: SessionMessageInfo): ChatMessage | null {
  if (message.type === "user") {
    return { id: message.id, role: "user", text: message.text, parts: [], created: message.time.created, done: true }
  }
  if (message.type === "assistant") {
    const parts: Part[] = []
    message.content.forEach((part, index) => {
      if (part.type === "text") {
        parts.push({ kind: "text", key: `${message.id}:text:${index}`, text: part.text })
        return
      }
      if (part.type === "reasoning") {
        parts.push({ kind: "reasoning", key: `${message.id}:reasoning:${index}`, text: part.text })
        return
      }
      parts.push({ kind: "tool", key: `${message.id}:tool:${part.id}`, tool: toolFromPart(part) })
    })
    return {
      id: message.id,
      role: "assistant",
      text: "",
      parts,
      created: message.time.created,
      done: message.time.completed !== undefined,
      agent: message.agent,
      model: message.model as ModelRef,
      error: message.error?.message,
      cost: message.cost,
      tokens: message.tokens
        ? { input: message.tokens.input, output: message.tokens.output, reasoning: message.tokens.reasoning }
        : undefined,
    }
  }
  return null
}

function toolFromPart(part: SessionMessageAssistantTool): ToolCall {
  const call: ToolCall = {
    id: part.id,
    name: part.name,
    status: "running",
    inputText: "",
    content: [],
    started: part.time.created,
    finished: part.time.completed,
  }
  const toolState = part.state
  if (toolState.status === "streaming") {
    return { ...call, status: "streaming", inputText: toolState.input }
  }
  if (toolState.status === "running") {
    return { ...call, status: "running", input: toolState.input as Record<string, unknown>, metadata: toolState.metadata as Record<string, unknown> }
  }
  if (toolState.status === "completed") {
    return {
      ...call,
      status: "completed",
      input: toolState.input as Record<string, unknown>,
      content: toolState.content as ToolContent[],
      metadata: toolState.metadata as Record<string, unknown>,
    }
  }
  return {
    ...call,
    status: "error",
    input: toolState.input as Record<string, unknown>,
    content: (toolState.content ?? []) as ToolContent[],
    error: toolState.error?.message,
  }
}

export async function openSession(sessionID: string) {
  patch({
    activeSessionID: sessionID,
    messages: [],
    olderCursor: null,
    loadingOlder: false,
    loadingMessages: true,
    permissions: [],
    forms: [],
    error: null,
    status: "idle",
    statusMessage: null,
    children: [],
    inbox: [],
  })
  try {
    const [messages, permissions, forms, session] = await Promise.all([
      api().message.list({ sessionID, limit: 200, order: "desc" }),
      api().permission.list({ sessionID }).catch(() => [] as PermissionRequest[]),
      api().session.form.list({ sessionID }).catch(() => [] as FormInfo[]),
      api().session.get({ sessionID }).catch(() => null),
    ])
    if (state.activeSessionID !== sessionID) return
    patch({
      messages: messages.data
        .slice()
        .reverse()
        .map(toChatMessage)
        .filter((message): message is ChatMessage => message !== null),
      olderCursor: messages.cursor.next ?? null,
      permissions,
      forms,
      loadingMessages: false,
      agent: session?.agent ?? state.agent,
      model: (session?.model as ModelRef) ?? state.model,
      activeSession: session ?? state.activeSession,
    })
    void loadActivity()
  } catch (error) {
    if (state.activeSessionID !== sessionID) return
    patch({ loadingMessages: false, error: errorMessage(error) })
  }
}

/** Carrega a página anterior (mensagens mais antigas) do histórico. */
export async function loadOlderMessages() {
  const sessionID = state.activeSessionID
  const cursor = state.olderCursor
  if (!sessionID || !cursor || state.loadingOlder) return
  patch({ loadingOlder: true })
  try {
    const page = await api().message.list({ sessionID, limit: 200, cursor })
    if (state.activeSessionID !== sessionID) return
    const older = page.data
      .slice()
      .reverse()
      .map(toChatMessage)
      .filter((message): message is ChatMessage => message !== null)
    const known = new Set(state.messages.map((message) => message.id))
    patch({
      messages: [...older.filter((message) => !known.has(message.id)), ...state.messages],
      olderCursor: page.cursor.next ?? null,
      loadingOlder: false,
    })
  } catch (error) {
    patch({ loadingOlder: false, error: errorMessage(error) })
  }
}

// ---------------------------------------------------------------- actions

export async function createSession(): Promise<string> {
  const created = await api().session.create({
    title: "Nova conversa",
    agent: state.agent ?? undefined,
    model: state.model ?? undefined,
    location: { directory },
  })
  patch({
    sessions: [created, ...state.sessions],
    activeSessionID: created.id,
    activeSession: created,
    messages: [],
    olderCursor: null,
    permissions: [],
    forms: [],
    error: null,
    status: "idle",
    statusMessage: null,
    children: [],
    inbox: [],
    returnSessionID: null,
  })
  return created.id
}

export async function startNewChat() {
  patch({
    activeSessionID: null,
    activeSession: null,
    messages: [],
    olderCursor: null,
    permissions: [],
    forms: [],
    error: null,
    status: "idle",
    statusMessage: null,
    children: [],
    inbox: [],
    returnSessionID: null,
  })
}

export async function removeSession(sessionID: string) {
  await api().session.remove({ sessionID })
  const sessions = state.sessions.filter((session) => session.id !== sessionID)
  if (state.activeSessionID === sessionID) {
    patch({
      sessions,
      activeSessionID: null,
      activeSession: null,
      messages: [],
      olderCursor: null,
      permissions: [],
      forms: [],
      children: [],
      inbox: [],
      returnSessionID: null,
    })
  } else {
    patch({ sessions })
  }
}

export async function renameSession(sessionID: string, title: string) {
  await api().session.update({ sessionID, title })
  patch({ sessions: state.sessions.map((session) => (session.id === sessionID ? { ...session, title } : session)) })
}

export async function sendPrompt(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return
  const wasBusy = state.status === "busy" || state.status === "retry"
  let sessionID = state.activeSessionID
  try {
    if (!sessionID) sessionID = await createSession()
  } catch (error) {
    patch({ error: errorMessage(error) })
    return
  }

  const optimisticID = `local-${crypto.randomUUID()}`
  patch({
    messages: [
      ...state.messages,
      { id: optimisticID, role: "user", text: trimmed, parts: [], created: Date.now(), done: true },
    ],
    status: "busy",
    statusMessage: null,
    error: null,
  })

  try {
    const inbox = await api().session.prompt({
      sessionID,
      text: trimmed,
      // "steer" (default) faz o agente ler a mensagem enquanto ainda trabalha;
      // "queue" guarda para depois que a execução atual terminar.
      delivery: wasBusy ? state.delivery : undefined,
    })
    if (inbox?.id) {
      patch({
        messages: state.messages.map((message) =>
          message.id === optimisticID ? { ...message, id: inbox.id } : message,
        ),
      })
    }
    void loadActivity()
  } catch (error) {
    patch({
      status: "error",
      error: errorMessage(error),
      messages: state.messages.filter((message) => message.id !== optimisticID),
    })
  }
}

export function setDelivery(delivery: DeliveryMode) {
  patch({ delivery })
}

export function setAgentPanelOpen(open: boolean) {
  patch({ agentPanelOpen: open })
  if (open) {
    void loadAgents().catch(() => {})
    void loadAgentConfig().catch(() => {})
    void loadActivity()
  }
}

/** Cancels a pending inbox item (queued or steering). */
export async function cancelInbox(inboxID: string) {
  const sessionID = state.activeSessionID
  if (!sessionID) return
  try {
    await api().session.inbox.cancel({ sessionID, inboxID })
    patch({ inbox: state.inbox.filter((item) => item.id !== inboxID) })
  } catch (error) {
    patch({ error: errorMessage(error) })
  }
}

/** Switches a pending inbox item between "steer" and "queue". */
export async function setInboxDelivery(inboxID: string, delivery: DeliveryMode) {
  const sessionID = state.activeSessionID
  if (!sessionID) return
  try {
    await api().session.inbox.update({ sessionID, inboxID, delivery })
    patch({ inbox: state.inbox.map((item) => (item.id === inboxID ? { ...item, delivery } : item)) })
  } catch (error) {
    patch({ error: errorMessage(error) })
  }
}

/** Opens a running/child subagent session, remembering how to get back. */
export async function openSubsession(sessionID: string) {
  const parent = state.activeSessionID
  if (parent && parent !== sessionID) patch({ returnSessionID: parent })
  await openSession(sessionID)
}

export async function backToParent() {
  const parent = state.returnSessionID
  patch({ returnSessionID: null })
  if (parent) await openSession(parent)
}

export type AgentDraft = {
  id: string
  description?: string
  system?: string
  mode?: string
  color?: string
  hidden?: boolean
  model?: ModelRef | null
}

/** Creates or updates an agent in the project config and reloads the service. */
export async function saveAgent(draft: AgentDraft): Promise<{ file: string }> {
  const response = await fetch("/app/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(draft),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `falha ao salvar (${response.status})`)
  }
  const body = (await response.json()) as { file: string }
  await api().location.reload().catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 900))
  await Promise.allSettled([loadAgents(), loadAgentConfig()])
  if (state.agents.some((item) => item.id === draft.id)) await setAgent(draft.id)
  return { file: body.file }
}

/** Removes an agent from the project config and reloads the service. */
export async function deleteAgent(id: string): Promise<void> {
  const response = await fetch(`/app/agents/${encodeURIComponent(id)}`, { method: "DELETE" })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `falha ao remover (${response.status})`)
  }
  await api().location.reload().catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 900))
  await Promise.allSettled([loadAgents(), loadAgentConfig()])
}

export async function interrupt() {
  const sessionID = state.activeSessionID
  if (!sessionID) return
  try {
    await api().session.interrupt({ sessionID })
  } catch (error) {
    patch({ error: errorMessage(error) })
  }
}

export async function replyPermission(request: PermissionRequest, decision: "once" | "always" | "reject") {
  try {
    await api().permission.reply({ sessionID: request.sessionID, requestID: request.id, decision })
    patch({ permissions: state.permissions.filter((item) => item.id !== request.id) })
  } catch (error) {
    patch({ error: errorMessage(error) })
  }
}

export async function loadForm(formID: string): Promise<FormDetail | null> {
  const sessionID = state.activeSessionID
  if (!sessionID) return null
  try {
    return await api().session.form.get({ sessionID, formID })
  } catch (error) {
    patch({ error: errorMessage(error) })
    return null
  }
}

export async function replyForm(formID: string, answer: Record<string, string | number | boolean | string[]>) {
  const sessionID = state.activeSessionID
  if (!sessionID) return
  try {
    await api().session.form.reply({ sessionID, formID, answer } as never)
    patch({ forms: state.forms.filter((item) => item.id !== formID) })
  } catch (error) {
    patch({ error: errorMessage(error) })
  }
}

export async function cancelForm(formID: string) {
  const sessionID = state.activeSessionID
  if (!sessionID) return
  try {
    await api().session.form.cancel({ sessionID, formID })
    patch({ forms: state.forms.filter((item) => item.id !== formID) })
  } catch (error) {
    patch({ error: errorMessage(error) })
  }
}

export async function setModel(model: ModelRef) {
  patch({ model })
  const sessionID = state.activeSessionID
  if (!sessionID) return
  try {
    await api().session.switchModel({ sessionID, model })
  } catch (error) {
    patch({ error: errorMessage(error) })
  }
}

export async function setAgent(agent: string) {
  patch({ agent })
  const sessionID = state.activeSessionID
  if (!sessionID) return
  try {
    await api().session.switchAgent({ sessionID, agent })
  } catch (error) {
    patch({ error: errorMessage(error) })
  }
}

export function dismissError() {
  patch({ error: null })
}

function errorMessage(error: unknown): string {
  if (!error) return "erro desconhecido"
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
