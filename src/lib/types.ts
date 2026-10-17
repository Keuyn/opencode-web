import type {
  AgentInfo,
  FormInfo,
  ModelInfo,
  PermissionRequest,
  SessionInboxInfo,
  SessionInfo,
} from "@opencode/client"

export type DeliveryMode = "steer" | "queue"

export type ModelRef = {
  providerID: string
  id: string
  variant?: string
}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "file"; uri: string; mime: string; name?: string | null }

export type ToolStatus = "streaming" | "running" | "completed" | "error"

export type ToolCall = {
  id: string
  name: string
  status: ToolStatus
  inputText: string
  input?: Record<string, unknown>
  content: ToolContent[]
  error?: string
  metadata?: Record<string, unknown>
  started: number
  finished?: number
}

export type Part =
  | { kind: "text"; key: string; text: string }
  | { kind: "reasoning"; key: string; text: string }
  | { kind: "tool"; key: string; tool: ToolCall }

export type ChatRole = "user" | "assistant" | "system" | "error"

export type ChatMessage = {
  id: string
  role: ChatRole
  text: string
  parts: Part[]
  created: number
  done: boolean
  agent?: string
  model?: ModelRef
  error?: string
  cost?: number
  tokens?: { input: number; output: number; reasoning: number }
}

export type ConnectionStatus = "connecting" | "online" | "offline"
export type RunStatus = "idle" | "busy" | "retry" | "error"

export type NetworkInfo = {
  /** Whether other devices on the LAN can reach the interface. */
  enabled: boolean
  /** True when the address is fixed by the HOST environment variable. */
  locked: boolean
  host: string
  port: number
  /** Reachable URLs for other devices on the same network. */
  urls: string[]
  /** Password other devices type to get in (see `custom`). */
  password: string
  /** True when the password was chosen in the panel and survives restarts. */
  custom: boolean
  /** True when the password comes from the WEB_TOKEN variable. */
  env: boolean
  authRequired: boolean
}

export type AppState = {
  config: { directory: string } | null
  connection: ConnectionStatus
  sessions: SessionInfo[]
  activeSessionID: string | null
  /** Full record of the currently open session (including subagent sessions). */
  activeSession: SessionInfo | null
  messages: ChatMessage[]
  olderCursor: string | null
  loadingOlder: boolean
  loadingMessages: boolean
  status: RunStatus
  statusMessage: string | null
  permissions: PermissionRequest[]
  forms: FormInfo[]
  models: ModelInfo[]
  agents: AgentInfo[]
  subagents: AgentInfo[]
  model: ModelRef | null
  agent: string | null
  error: string | null
  /** Session IDs currently running, from `session.active()`. */
  running: string[]
  /** Child (subagent) sessions of the active conversation. */
  children: SessionInfo[]
  /** Pending inbox items (steer/queue) for the active conversation. */
  inbox: SessionInboxInfo[]
  /** Whether the agents panel is open. */
  agentPanelOpen: boolean
  /** Preferred delivery mode while the assistant is running. */
  delivery: DeliveryMode
  /** Parent conversation to return to when viewing a subagent session. */
  returnSessionID: string | null
  /** Config file used for agent definitions (`opencode.json`). */
  agentConfigFile: string | null
  /** IDs of agents defined in the project config file (editable/removable). */
  customAgents: string[]
  /** Whether the server requires a password (network access enabled). */
  authRequired: boolean
  /** Whether this browser is authenticated. */
  authed: boolean
  /** Local network status (URLs, password, toggle state). */
  network: NetworkInfo | null
}

export type { AgentInfo, FormInfo, ModelInfo, PermissionRequest, SessionInboxInfo, SessionInfo }
