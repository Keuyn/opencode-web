import type { ToolCall } from "./types"

export function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return "agora"
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h`
  const days = Math.floor(hours / 24)
  if (days === 1) return "ontem"
  if (days < 7) return `${days} dias`
  return new Date(timestamp).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })
}

export function dayBucket(timestamp: number): "hoje" | "ontem" | "semana" | "antigas" {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const today = start.getTime()
  if (timestamp >= today) return "hoje"
  if (timestamp >= today - 86_400_000) return "ontem"
  if (timestamp >= today - 6 * 86_400_000) return "semana"
  return "antigas"
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} min ${Math.round(seconds % 60)} s`
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`
  return `${(count / 1_000_000).toFixed(2)}M`
}

export function basename(filePath: string): string {
  const parts = filePath.split("/")
  return parts[parts.length - 1] || filePath
}

export function shortModel(model?: { providerID: string; id: string } | null): string {
  if (!model) return "modelo padrão"
  return model.id
}

export type ToolDescriptor = {
  label: string
  icon: string
  summary: string
}

const STRING_KEYS = [
  "filePath",
  "path",
  "command",
  "pattern",
  "query",
  "url",
  "description",
  "prompt",
  "glob",
  "directory",
]

function firstString(input: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!input) return undefined
  for (const key of keys) {
    const value = input[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

export function describeTool(tool: ToolCall): ToolDescriptor {
  const input = tool.input
  const direct = firstString(input, STRING_KEYS)
  const summary = (() => {
    switch (tool.name) {
      case "bash":
      case "shell":
        return direct ?? tool.inputText
      case "read":
      case "write":
      case "edit":
      case "patch":
        return input ? basename(String(input.filePath ?? input.path ?? "")) : tool.inputText
      case "grep":
        return [
          firstString(input, ["pattern"]) ? `/${firstString(input, ["pattern"])}/` : undefined,
          firstString(input, ["path"]) ? `em ${basename(firstString(input, ["path"])!)}` : undefined,
        ]
          .filter(Boolean)
          .join(" ")
      case "glob":
        return firstString(input, ["pattern", "glob"]) ?? tool.inputText
      case "list":
        return firstString(input, ["path", "directory"]) ?? tool.inputText
      case "webfetch":
      case "fetch":
        return firstString(input, ["url"]) ?? tool.inputText
      case "websearch":
        return firstString(input, ["query"]) ?? tool.inputText
      case "task":
        return firstString(input, ["description", "prompt"]) ?? tool.inputText
      default:
        return direct ?? (tool.inputText ? tool.inputText.slice(0, 120) : "")
    }
  })()

  return {
    label: TOOL_LABELS[tool.name] ?? tool.name,
    icon: TOOL_ICONS[tool.name] ?? "🔧",
    summary: summary.length > 160 ? `${summary.slice(0, 157)}…` : summary,
  }
}

const TOOL_LABELS: Record<string, string> = {
  bash: "Comando no terminal",
  shell: "Comando no terminal",
  read: "Ler arquivo",
  write: "Escrever arquivo",
  edit: "Editar arquivo",
  patch: "Aplicar patch",
  grep: "Buscar no código",
  glob: "Procurar arquivos",
  list: "Listar diretório",
  webfetch: "Buscar página",
  fetch: "Buscar página",
  websearch: "Pesquisar na web",
  task: "Subtarefa",
  question: "Pergunta",
  skill: "Habilidade",
  todo: "Lista de tarefas",
  todowrite: "Lista de tarefas",
  todoread: "Lista de tarefas",
}

const TOOL_ICONS: Record<string, string> = {
  bash: "⌘",
  shell: "⌘",
  read: "📄",
  write: "📝",
  edit: "✏️",
  patch: "🩹",
  grep: "🔍",
  glob: "🗂️",
  list: "📁",
  webfetch: "🌐",
  fetch: "🌐",
  websearch: "🔎",
  task: "🤖",
  question: "❓",
  skill: "📚",
  todo: "✅",
  todowrite: "✅",
  todoread: "✅",
}

export function toolOutput(tool: ToolCall): string {
  const parts = tool.content.map((item) => {
    if (item.type === "text") return item.text
    return `[${item.type}: ${item.name ?? item.uri}]`
  })
  return parts.join("\n\n")
}
