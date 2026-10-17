import { randomBytes, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir, networkInterfaces } from "node:os"
import { Readable, Transform } from "node:stream"
import path from "node:path"
import process from "node:process"
import archiver from "archiver"
import express, { type Request, type Response } from "express"
import { Service } from "@opencode/client/service"

const isProduction = process.env.NODE_ENV === "production"
const PORT = Number(process.env.PORT ?? 3123)
/** Pasta onde o próprio app está instalado (nunca é usada como workspace). */
const appDirectory = process.cwd()

/**
 * Acesso pela rede local. Por padrão a interface só escuta em localhost; o
 * interruptor do painel "Rede" (ou `HOST`) libera os demais dispositivos.
 * Quando isso acontece, a autenticação por senha passa a valer para todos.
 *
 * São duas credenciais:
 * - a **senha do terminal** (`runToken`), sorteada a cada execução e impressa no
 *   log: sempre serve para entrar (ativar/recuperar o acesso) nesta execução;
 * - a **senha personalizada** (`customPassword`), definida no painel 🌐, que fica
 *   salva entre reinícios e é a que você entrega para os outros dispositivos.
 */
const forcedHost = process.env.HOST?.trim() || undefined
const envToken = process.env.WEB_TOKEN?.trim() || undefined
const COOKIE_NAME = "opencode_web"
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365
const MIN_PASSWORD = 6
const configDirectory = process.env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), ".config")
const SETTINGS_FILE = path.join(configDirectory, "opencode-web", "settings.json")

/**
 * Raiz dos projetos. O agente nunca roda dentro da pasta de instalação do app:
 * cada dispositivo ganha um workspace dentro desta raiz, e é isso que separa as
 * conversas (as sessões do OpenCode são escopadas por diretório).
 */
const envProjectsRoot = process.env.PROJECTS_ROOT?.trim() || undefined
const DEFAULT_PROJECTS_ROOT = path.join(homedir(), "opencode-web-projects")

type DeviceRecord = {
  name?: string
  /** Pasta dentro da raiz ("" = a própria raiz). */
  project?: string
  owner?: boolean
  ip?: string
  agent?: string
  created?: number
  lastSeen?: number
}

type Settings = {
  password?: string
  networkEnabled?: boolean
  projectRoot?: string
  devices?: Record<string, DeviceRecord>
}

let networkEnabled = false
/** Senha do terminal: nova a cada execução (não é persistida). */
let runToken = ""
/** Senha personalizada do painel: definida pelo usuário, salva em disco. */
let customPassword: string | undefined
/** Raiz onde os projetos dos dispositivos ficam. */
let projectRoot = envProjectsRoot ? path.resolve(envProjectsRoot) : DEFAULT_PROJECTS_ROOT
/** Dispositivos conhecidos (chave = "local" ou "ip:<endereço>"). */
let devices: Record<string, DeviceRecord> = {}

function bindHost(): string {
  if (forcedHost) return forcedHost
  return networkEnabled ? "0.0.0.0" : "127.0.0.1"
}

function isLoopback(host: string): boolean {
  const value = host.toLowerCase()
  return value === "127.0.0.1" || value === "::1" || value === "localhost"
}

/** Senha efetiva: a que os dispositivos digitam para entrar. */
function accessPassword(): string {
  return envToken ?? customPassword ?? runToken
}

/** Todas as senhas aceitas no login (a do terminal funciona sempre). */
function acceptedPasswords(): string[] {
  return [runToken, customPassword, envToken].filter((value): value is string => Boolean(value))
}

/** A senha só é exigida quando a interface é alcançável por outros aparelhos. */
function authEnabled(): boolean {
  return Boolean(envToken) || !isLoopback(bindHost())
}

function lanUrls(): string[] {
  const urls: string[] = []
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) urls.push(`http://${address.address}:${PORT}`)
    }
  }
  return urls
}

// ------------------------------------------------------- dispositivos

/** Endereço do socket, sem o prefixo IPv4-mapped do IPv6. */
function normalizeIp(raw: string | undefined): string {
  if (!raw) return "desconhecido"
  const value = raw.startsWith("::ffff:") ? raw.slice("::ffff:".length) : raw
  return value === "::1" ? "127.0.0.1" : value
}

/** Loopback + interfaces da própria máquina: tudo isso é "o dono". */
function isLocalIp(ip: string): boolean {
  if (ip === "127.0.0.1" || ip === "::1") return true
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && address.address === ip) return true
    }
  }
  return false
}

/**
 * Identidade do dispositivo. Sai do socket (o cliente não escolhe), então um
 * convidado não consegue se passar por outro. Acesso pela própria máquina é
 * sempre "local" — abrir por localhost ou pelo IP da rede é o mesmo dono.
 */
function deviceKey(req: Request): string {
  const ip = normalizeIp(req.socket.remoteAddress)
  return isLocalIp(ip) ? "local" : `ip:${ip}`
}

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Valida o nome da pasta do projeto ("" = a própria raiz). */
function safeProject(value: unknown): string | null {
  const trimmed = String(value ?? "").trim()
  if (!trimmed) return ""
  return PROJECT_NAME.test(trimmed) ? trimmed : null
}

function projectDirectory(project: string | undefined): string {
  const safe = safeProject(project)
  return safe ? path.join(projectRoot, safe) : projectRoot
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return slug || "dispositivo"
}

function deviceLabel(req: Request): string {
  const agent = String(req.headers["user-agent"] ?? "")
  if (/iPhone/i.test(agent)) return "iPhone"
  if (/iPad/i.test(agent)) return "iPad"
  if (/Android/i.test(agent)) return /Mobile/i.test(agent) ? "Celular" : "Tablet"
  if (/Windows/i.test(agent)) return "Windows"
  if (/Macintosh|Mac OS X/i.test(agent)) return "Mac"
  if (/Linux/i.test(agent)) return "Linux"
  return "Dispositivo"
}

function projectInUse(project: string, except?: string): boolean {
  return Object.entries(devices).some(([key, record]) => key !== except && (record.project ?? "") === project)
}

/** Nome de pasta livre para um convidado novo (não reaproveita pasta órfã). */
async function uniqueProject(base: string): Promise<string> {
  let candidate = base
  let counter = 2
  for (;;) {
    if (!projectInUse(candidate)) {
      let exists = true
      try {
        await stat(path.join(projectRoot, candidate))
      } catch {
        exists = false
      }
      if (!exists) return candidate
    }
    candidate = `${base}-${counter}`
    counter += 1
  }
}

/** Registra (e mantém) o dispositivo da requisição. */
async function ensureDevice(req: Request): Promise<void> {
  const ip = normalizeIp(req.socket.remoteAddress)
  const key = deviceKey(req)
  let record = devices[key]
  if (!record) {
    const local = key === "local"
    const label = deviceLabel(req)
    const project = local ? "" : await uniqueProject(`${slugify(label)}-${ip.split(".").pop() ?? "0"}`)
    record = { name: local ? "Este computador" : label, project, owner: local, ip, created: Date.now() }
    devices[key] = record
    await mkdir(projectDirectory(project), { recursive: true }).catch(() => {})
    persistSoon()
  } else if (!record.lastSeen || Date.now() - record.lastSeen > 60_000) {
    persistSoon()
  }
  record.ip = ip
  record.lastSeen = Date.now()
  const agent = String(req.headers["user-agent"] ?? "").slice(0, 180)
  if (agent) record.agent = agent
}

/** Diretório de trabalho do dispositivo (única fonte de verdade). */
function workspaceDirectory(req: Request): string {
  return projectDirectory(devices[deviceKey(req)]?.project)
}

function isOwnerRequest(req: Request): boolean {
  return Boolean(devices[deviceKey(req)]?.owner)
}

async function loadSettings(): Promise<Settings> {
  try {
    const raw = await readFile(SETTINGS_FILE, "utf8")
    const parsed = JSON.parse(raw) as Settings
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

async function saveSettings(next: Settings): Promise<void> {
  try {
    await mkdir(path.dirname(SETTINGS_FILE), { recursive: true })
    const temporary = `${SETTINGS_FILE}.tmp-${process.pid}`
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8")
    await rename(temporary, SETTINGS_FILE)
  } catch (error) {
    console.warn("[opencode-web] não foi possível salvar as configurações:", error)
  }
}

function currentSettings(): Settings {
  return { password: customPassword, networkEnabled, projectRoot, devices }
}

let persistTimer: ReturnType<typeof setTimeout> | undefined

/** Grava as configurações agrupando rajadas de alterações. */
function persistSoon(): void {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = undefined
    void saveSettings(currentSettings())
  }, 1500)
}

async function persistNow(): Promise<void> {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = undefined
  await saveSettings(currentSettings())
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!header) return result
  for (const part of header.split(";")) {
    const index = part.indexOf("=")
    if (index === -1) continue
    const key = part.slice(0, index).trim()
    if (!key) continue
    const value = part.slice(index + 1).trim()
    try {
      result[key] = decodeURIComponent(value)
    } catch {
      result[key] = value
    }
  }
  return result
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** Compara com qualquer senha aceita, sempre em tempo constante. */
function matchesAny(value: string): boolean {
  let found = false
  for (const candidate of acceptedPasswords()) {
    if (safeEqual(value, candidate)) found = true
  }
  return found
}

function cookieHeader(value: string, maxAge: number): string {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
  ].join("; ")
}

function authorized(req: Request): boolean {
  if (!authEnabled()) return true
  const value = parseCookies(req.headers.cookie)[COOKIE_NAME]
  return Boolean(value) && matchesAny(value)
}

type Endpoint = Awaited<ReturnType<typeof Service.ensure>>

let endpoint: Endpoint | undefined
let endpointPromise: Promise<Endpoint> | undefined

/**
 * Resolves the local OpenCode background service. Reuses the registered
 * instance when possible and starts one if none is healthy.
 */
async function resolveEndpoint(reset = false): Promise<Endpoint> {
  if (reset) {
    endpoint = undefined
    endpointPromise = undefined
  }
  if (endpoint) return endpoint
  if (!endpointPromise) {
    endpointPromise = (async () => {
      const discovered = await Service.discover()
      const found = discovered ?? (await Service.ensure())
      endpoint = { url: found.url, auth: (found as { auth?: Endpoint["auth"] }).auth }
      console.log(`[opencode-web] serviço do OpenCode em ${endpoint.url}`)
      return endpoint
    })().catch((error) => {
      endpointPromise = undefined
      throw error
    })
  }
  return endpointPromise
}

function authHeaders(target: Endpoint): Record<string, string> {
  const headers = Service.headers(target) as Record<string, string> | undefined
  const result: Record<string, string> = {}
  if (!headers) return result
  for (const [key, value] of Object.entries(headers)) {
    if (value) result[key] = String(value)
  }
  return result
}

const HOP_BY_HOP = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "date",
])

// ------------------------------------------- isolamento por dispositivo

const SESSION_ID = /ses_[A-Za-z0-9]+/g

/** Rotas que um convidado nunca acessa. */
const GUEST_BLOCKED_PREFIXES = [
  "/api/fs/",
  "/api/experimental/",
  "/api/debug/",
  "/api/credential",
  "/api/location",
  // Lista global de formulários e regras de permissão: valem para o serviço
  // inteiro (todos os diretórios), então ficam restritas ao dono.
  "/api/permission/saved",
]

/** Rotas exatas que um convidado nunca acessa. */
const GUEST_BLOCKED_ROUTES = new Set(["/api/form"])

/** Mover uma sessão trocaria o diretório de trabalho dela: só o dono. */
const GUEST_BLOCKED_PATTERNS = [/^\/api\/session\/[^/]+\/move$/]

/** Rotas cuja resposta precisa ser filtrada pelo workspace do convidado. */
const LIST_ROUTES = new Set(["/api/session", "/api/session/active"])

/** Mapa sessão → diretório, lido do próprio serviço do OpenCode. */
let sessionIndex = new Map<string, string>()
let sessionIndexAt = 0
let sessionIndexLoading: Promise<void> | undefined

function normalizeDirectory(value: string): string {
  return path.resolve(value).replace(/\/+$/, "")
}

/** O serviço não escopa por diretório: o índice é o que permite checar posse. */
async function loadSessionIndex(): Promise<void> {
  try {
    const target = await resolveEndpoint()
    const response = await fetch(`${target.url}/api/session?limit=500`, { headers: authHeaders(target) })
    if (!response.ok) return
    const body = (await response.json()) as unknown
    const list = Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[])
    if (!Array.isArray(list)) return
    const next = new Map<string, string>()
    for (const entry of list as Array<Record<string, unknown>>) {
      const id = typeof entry.id === "string" ? entry.id : ""
      const location = entry.location as { directory?: unknown } | undefined
      const directory = typeof location?.directory === "string" ? location.directory : ""
      if (id && directory) next.set(id, directory)
    }
    if (next.size > 0) {
      sessionIndex = next
      sessionIndexAt = Date.now()
    }
  } catch {
    // mantém o índice anterior
  }
}

async function refreshSessionIndex(force = false): Promise<void> {
  if (!force && sessionIndex.size > 0 && Date.now() - sessionIndexAt < 5000) return
  if (!sessionIndexLoading) {
    sessionIndexLoading = loadSessionIndex().finally(() => {
      sessionIndexLoading = undefined
    })
  }
  await sessionIndexLoading
}

/** true/false quando a sessão é conhecida, undefined quando ainda não indexada. */
function ownsSession(id: string, directory: string): boolean | undefined {
  const known = sessionIndex.get(id)
  if (known === undefined) return undefined
  return normalizeDirectory(known) === normalizeDirectory(directory)
}

/** Guarda as sessões que aparecem num payload (criação/eventos). */
function registerSessions(value: unknown, depth = 0): void {
  if (depth > 4 || !value || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const item of value) registerSessions(item, depth + 1)
    return
  }
  const record = value as Record<string, unknown>
  const id = typeof record.id === "string" ? record.id : ""
  const location = record.location as { directory?: unknown } | undefined
  if (id.startsWith("ses_") && typeof location?.directory === "string") sessionIndex.set(id, location.directory)
  for (const child of Object.values(record)) {
    if (child && typeof child === "object") registerSessions(child, depth + 1)
  }
}

function sessionIDsIn(text: string): string[] {
  const found = new Set<string>()
  SESSION_ID.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SESSION_ID.exec(text))) found.add(match[0])
  return [...found]
}

function filterSessionList(body: unknown, directory: string): unknown {
  const wrapper = Array.isArray(body) ? null : (body as Record<string, unknown>)
  const list = Array.isArray(body) ? body : (wrapper?.data as unknown[])
  if (!Array.isArray(list)) return body
  const keep = list.filter((item) => {
    const location = (item as Record<string, unknown>).location as { directory?: unknown } | undefined
    const value = typeof location?.directory === "string" ? location.directory : ""
    return value !== "" && normalizeDirectory(value) === normalizeDirectory(directory)
  })
  return Array.isArray(body) ? keep : { ...wrapper, data: keep }
}

function filterActiveMap(body: unknown, directory: string): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body
  const result: Record<string, unknown> = {}
  for (const [id, value] of Object.entries(body as Record<string, unknown>)) {
    if (ownsSession(id, directory) !== false) result[id] = value
  }
  return result
}

/** Deixa passar um quadro SSE só se ele for do workspace do convidado. */
function frameAllowed(frame: string, directory: string): boolean {
  const trimmed = frame.trim()
  if (!trimmed || trimmed.startsWith(":")) return true
  const dataLine = trimmed.split("\n").find((line) => line.startsWith("data:"))
  if (!dataLine) return true
  const payload = dataLine.slice(5).trim()
  if (!payload) return true
  let parsed: unknown = null
  try {
    parsed = JSON.parse(payload)
  } catch {
    parsed = null
  }
  if (parsed === null) return sessionIDsIn(payload).length === 0 && !payload.includes("\"directory\"")
  const location = (parsed as Record<string, unknown>).location as { directory?: unknown } | undefined
  const eventDirectory = typeof location?.directory === "string" ? location.directory : undefined
  if (eventDirectory && normalizeDirectory(eventDirectory) !== normalizeDirectory(directory)) return false
  for (const id of sessionIDsIn(payload)) {
    if (ownsSession(id, directory) === false) return false
  }
  registerSessions(parsed)
  return true
}

/** Filtra o stream de eventos, quadro a quadro. */
function sessionEventFilter(directory: string): Transform {
  let buffer = ""
  return new Transform({
    transform(chunk, _encoding, callback) {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)
      const frames = buffer.split("\n\n")
      buffer = frames.pop() ?? ""
      let output = ""
      for (const frame of frames) {
        if (frameAllowed(frame, directory)) output += `${frame}\n\n`
      }
      callback(null, output)
    },
    flush(callback) {
      if (buffer && frameAllowed(buffer, directory)) this.push(buffer)
      callback()
    },
  })
}

async function readBody(req: Request): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  }
  return Buffer.concat(chunks)
}

/** Força o diretório de criação de sessão para o workspace do convidado. */
function rewriteSessionCreate(raw: Buffer, directory: string): Buffer {
  const payload = JSON.parse(raw.toString("utf8")) as Record<string, unknown>
  if (!payload || typeof payload !== "object") throw new Error("corpo inválido")
  const location = payload.location && typeof payload.location === "object" ? (payload.location as Record<string, unknown>) : {}
  payload.location = { ...location, directory }
  return Buffer.from(JSON.stringify(payload))
}

/**
 * Transparent streaming proxy to the OpenCode HTTP API. The browser talks to
 * the official `@opencode/client` on this same origin, and the server attaches
 * the discovery credentials and streams responses (including SSE) through.
 *
 * Para convidados este proxy é também a fronteira de isolamento: o serviço do
 * OpenCode devolve sessões de *todos* os diretórios, então aqui a resposta é
 * filtrada pelo workspace do dispositivo e as rotas de outra conversa são
 * recusadas.
 */
async function proxy(req: Request, res: Response, retried = false) {
  const method = req.method.toUpperCase()
  const hasBody = !["GET", "HEAD"].includes(method)
  const requestPath = req.originalUrl.split("?")[0]
  const directory = workspaceDirectory(req)
  const guest = !isOwnerRequest(req)

  if (guest) {
    if (
      GUEST_BLOCKED_PREFIXES.some((prefix) => requestPath.startsWith(prefix)) ||
      GUEST_BLOCKED_ROUTES.has(requestPath) ||
      GUEST_BLOCKED_PATTERNS.some((pattern) => pattern.test(requestPath))
    ) {
      res.status(403).json({
        error: "forbidden",
        message: "Esta operação só está disponível no computador do servidor.",
      })
      return
    }
    await refreshSessionIndex()
    let decoded = req.originalUrl
    try {
      decoded = decodeURIComponent(req.originalUrl)
    } catch {
      // mantém o valor bruto
    }
    for (const id of sessionIDsIn(decoded)) {
      if (ownsSession(id, directory) === false) {
        res.status(403).json({ error: "forbidden", message: "Esta conversa pertence a outro dispositivo." })
        return
      }
    }
  }

  // O corpo do convidado pode precisar de reescrita (criação de sessão).
  let payload: Buffer | undefined
  if (hasBody && guest && requestPath === "/api/session" && method === "POST") {
    try {
      const raw = await readBody(req)
      // Um `parentID` de outra conversa também seria um acesso indevido.
      for (const id of sessionIDsIn(raw.toString("utf8"))) {
        if (ownsSession(id, directory) === false) {
          res.status(403).json({ error: "forbidden", message: "Esta conversa pertence a outro dispositivo." })
          return
        }
      }
      payload = rewriteSessionCreate(raw, directory)
    } catch {
      res.status(400).json({ error: "invalid_body", message: "Corpo da requisição inválido." })
      return
    }
    req.headers["content-length"] = String(payload.length)
  }

  try {
    const target = await resolveEndpoint()
    const url = `${target.url.replace(/\/+$/, "")}${req.originalUrl}`
    const headers = new Headers(authHeaders(target))

    if (req.headers.accept) headers.set("accept", req.headers.accept)
    if (req.headers["content-type"]) headers.set("content-type", String(req.headers["content-type"]))
    // Location/workspace selection and any other OpenCode-scoped request metadata.
    for (const [name, value] of Object.entries(req.headers)) {
      if (!value || !name.toLowerCase().startsWith("x-opencode-")) continue
      headers.set(name, Array.isArray(value) ? value.join(", ") : value)
    }
    // O diretório é sempre o do dispositivo — o cliente não escolhe.
    headers.set("x-opencode-directory", encodeURIComponent(directory))
    // Avoid compressed streams so the body can be piped through untouched.
    headers.set("accept-encoding", "identity")

    const body = !hasBody ? undefined : (payload ?? (Readable.toWeb(req) as unknown as ReadableStream))

    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body,
      // Required by undici when streaming a request body.
      duplex: "half",
    } as RequestInit & { duplex: "half" })

    if (upstream.status === 401 && !retried && !hasBody) {
      await upstream.body?.cancel().catch(() => {})
      await resolveEndpoint(true)
      return proxy(req, res, true)
    }

    const contentType = upstream.headers.get("content-type") ?? ""

    function copyHeaders() {
      for (const [key, value] of upstream.headers) {
        if (HOP_BY_HOP.has(key.toLowerCase())) continue
        res.setHeader(key, value)
      }
    }

    // A lista de conversas vem com todos os diretórios: filtra pelo workspace.
    if (guest && upstream.ok && method === "GET" && LIST_ROUTES.has(requestPath)) {
      const text = await upstream.text()
      let parsed: unknown = null
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
      const result =
        parsed === null
          ? text
          : JSON.stringify(
              requestPath === "/api/session/active"
                ? filterActiveMap(parsed, directory)
                : filterSessionList(parsed, directory),
            )
      res.status(upstream.status)
      copyHeaders()
      res.setHeader("content-type", "application/json; charset=utf-8")
      res.send(result)
      return
    }

    // Sessão recém-criada pelo convidado: registra para as próximas checagens.
    if (guest && method === "POST" && requestPath === "/api/session" && upstream.ok) {
      const text = await upstream.text()
      try {
        registerSessions(JSON.parse(text))
      } catch {
        // resposta inesperada: segue sem registrar
      }
      res.status(upstream.status)
      copyHeaders()
      res.send(text)
      return
    }

    res.status(upstream.status)
    copyHeaders()
    if (contentType.includes("text/event-stream")) {
      res.setHeader("cache-control", "no-cache, no-transform")
      res.setHeader("x-accel-buffering", "no")
    }

    if (!upstream.body) {
      res.end()
      return
    }
    res.flushHeaders?.()
    const stream = Readable.fromWeb(upstream.body as never)
    if (guest && contentType.includes("text/event-stream")) {
      stream.pipe(sessionEventFilter(directory)).pipe(res)
      return
    }
    stream.pipe(res)
  } catch (error) {
    if (!retried && !hasBody) {
      await resolveEndpoint(true).catch(() => {})
      return proxy(req, res, true)
    }
    if (res.headersSent) {
      res.end()
      return
    }
    res.status(502).json({
      error: "opencode_unreachable",
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Agent definitions live in the OpenCode config file (`agents` key). We edit the
 * project-level file so agents created from the web panel are scoped to the
 * current directory. `opencode.json` is preferred, `.opencode/*` as a fallback.
 */
const AGENT_CONFIG_CANDIDATES = [
  "opencode.json",
  ".opencode/opencode.json",
  "opencode.jsonc",
  ".opencode/opencode.jsonc",
]

const AGENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/** Removes `//` and `/* *\/` comments while preserving string literals. */
function stripJsonComments(input: string): string {
  let output = ""
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    const next = input[index + 1]
    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false
        output += char
      }
      continue
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false
        index += 1
      }
      continue
    }
    if (inString) {
      output += char
      if (char === "\\") {
        output += next ?? ""
        index += 1
        continue
      }
      if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === "/" && next === "/") {
      inLineComment = true
      index += 1
      continue
    }
    if (char === "/" && next === "*") {
      inBlockComment = true
      index += 1
      continue
    }
    output += char
  }
  return output
}

/** Drops trailing commas before `}` or `]`, ignoring string literals. */
function removeTrailingCommas(input: string): string {
  let output = ""
  let inString = false
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (inString) {
      output += char
      if (char === "\\") {
        output += input[index + 1] ?? ""
        index += 1
        continue
      }
      if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === ",") {
      let next = index + 1
      while (next < input.length && /\s/.test(input[next])) next += 1
      if (input[next] === "}" || input[next] === "]") continue
    }
    output += char
  }
  return output
}

function parseJsonc(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  if (!trimmed) return {}
  return JSON.parse(removeTrailingCommas(stripJsonComments(trimmed))) as Record<string, unknown>
}

async function readAgentConfig(directory: string): Promise<{ target: string; existed: boolean; data: Record<string, unknown> }> {
  for (const relative of AGENT_CONFIG_CANDIDATES) {
    const file = path.join(directory, relative)
    let raw: string
    try {
      raw = await readFile(file, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    try {
      return { target: file, existed: true, data: parseJsonc(raw) }
    } catch (error) {
      throw new Error(`config inválido em ${relative}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { target: path.join(directory, "opencode.json"), existed: false, data: {} }
}

function readAgents(data: Record<string, unknown>): Record<string, unknown> {
  const value = data.agents
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  return {}
}

async function writeAgentConfig(target: string, data: Record<string, unknown>) {
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8")
  await rename(temporary, target)
}

function relativeConfig(directory: string, target: string): string {
  const relative = path.relative(directory, target)
  return relative && !relative.startsWith("..") ? relative : target
}

function errorResponse(res: Response, status: number, error: string, exception: unknown) {
  res.status(status).json({ error, message: exception instanceof Error ? exception.message : String(exception) })
}

const app = express()
app.disable("x-powered-by")

// Autenticação: protege a API e os endpoints internos quando a rede está ligada.
app.use((req, res, next) => {
  const target = req.path
  const scoped =
    target === "/app" || target.startsWith("/app/") || target === "/api" || target.startsWith("/api/")
  if (!scoped || target === "/app/auth" || target === "/app/login") return next()
  if (authorized(req)) return next()
  res.status(401).json({ error: "unauthorized", message: "Autenticação necessária." })
})

// Registra o dispositivo (e o workspace dele) antes de qualquer rota.
app.use(async (req, _res, next) => {
  try {
    await ensureDevice(req)
  } catch (error) {
    console.warn("[opencode-web] falha ao registrar o dispositivo:", error)
  }
  next()
})

/** Só o computador do servidor (ou um dispositivo promovido) administra o app. */
function requireOwner(req: Request, res: Response): boolean {
  if (isOwnerRequest(req)) return true
  res.status(403).json({
    error: "forbidden",
    message: "Esta configuração só pode ser alterada no computador do servidor.",
  })
  return false
}

app.get("/app/auth", (_req, res) => {
  res.json({ required: authEnabled() })
})

app.post("/app/login", express.json(), (req, res) => {
  const value = String((req.body as { token?: unknown } | undefined)?.token ?? "")
  if (!value || !matchesAny(value)) {
    res.status(401).json({ error: "invalid_token", message: "Senha incorreta." })
    return
  }
  res.setHeader("set-cookie", cookieHeader(value, COOKIE_MAX_AGE))
  res.json({ ok: true })
})

app.post("/app/logout", (_req, res) => {
  res.setHeader("set-cookie", cookieHeader("", 0))
  res.json({ ok: true })
})

/** Troca a senha personalizada a qualquer momento (sem reabrir o servidor). */
app.post("/app/password", express.json(), async (req, res) => {
  if (!requireOwner(req, res)) return
  if (envToken) {
    res.status(409).json({ error: "locked", message: "A senha é definida pela variável WEB_TOKEN." })
    return
  }
  const body = (req.body ?? {}) as { password?: unknown; reset?: unknown }
  if (body.reset) {
    customPassword = undefined
  } else {
    const candidate = typeof body.password === "string" ? body.password.trim() : ""
    if (candidate.length < MIN_PASSWORD) {
      res.status(400).json({
        error: "weak_password",
        message: `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`,
      })
      return
    }
    customPassword = candidate
  }
  await saveSettings(currentSettings())
  // Mantém este navegador autenticado com a nova senha.
  res.setHeader("set-cookie", cookieHeader(accessPassword(), COOKIE_MAX_AGE))
  res.json({ ok: true, custom: Boolean(customPassword), password: accessPassword() })
})

app.get("/app/network", (_req, res) => {
  res.json({
    enabled: networkEnabled,
    locked: Boolean(forcedHost),
    host: bindHost(),
    port: PORT,
    urls: lanUrls(),
    password: accessPassword(),
    custom: Boolean(customPassword),
    env: Boolean(envToken),
    authRequired: authEnabled(),
  })
})

app.post("/app/network", express.json(), async (req, res) => {
  if (!requireOwner(req, res)) return
  if (forcedHost) {
    res.status(409).json({ error: "locked", message: "O endereço é definido pela variável HOST." })
    return
  }
  const body = (req.body ?? {}) as { enabled?: unknown }
  const enabled = Boolean(body.enabled)
  networkEnabled = enabled
  if (!envToken) await saveSettings(currentSettings())
  if (enabled || authEnabled()) {
    // Mantém este navegador autenticado depois que a porta é reaberta.
    res.setHeader("set-cookie", cookieHeader(accessPassword(), COOKIE_MAX_AGE))
  }
  res.json({ enabled, reload: true })
  setTimeout(() => {
    void rebind()
  }, 300)
})

app.get("/app/config", (req, res) => {
  const record = devices[deviceKey(req)] ?? {}
  res.json({
    directory: workspaceDirectory(req),
    project: record.project ?? "",
    projectRoot,
    owner: Boolean(record.owner),
    version: process.env.npm_package_version ?? "0.1.0",
  })
})

// -------------------------------------------------- projetos e dispositivos

/** Pastas de primeiro nível da raiz (candidatas a projeto). */
async function listProjects(): Promise<string[]> {
  try {
    const entries = await readdir(projectRoot, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && PROJECT_NAME.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, "pt-BR"))
  } catch {
    return []
  }
}

function deviceView(key: string, record: DeviceRecord, self: string) {
  return {
    key,
    name: record.name ?? (record.owner ? "Este computador" : "Dispositivo"),
    project: record.project ?? "",
    owner: Boolean(record.owner),
    ip: record.ip ?? "",
    agent: record.agent ?? "",
    lastSeen: record.lastSeen ?? 0,
    self: key === self,
  }
}

async function devicesPayload(req: Request) {
  const self = deviceKey(req)
  return {
    root: projectRoot,
    projects: await listProjects(),
    self,
    owner: isOwnerRequest(req),
    devices: Object.entries(devices)
      .map(([key, record]) => deviceView(key, record, self))
      .sort(
        (left, right) =>
          Number(right.owner) - Number(left.owner) ||
          Number(right.self) - Number(left.self) ||
          left.name.localeCompare(right.name, "pt-BR"),
      ),
  }
}

app.get("/app/devices", async (req, res) => {
  res.json(await devicesPayload(req))
})

/** Troca o projeto do dispositivo atual (dono): vale para as próximas conversas. */
app.post("/app/workspace", express.json(), async (req, res) => {
  if (!requireOwner(req, res)) return
  const key = deviceKey(req)
  const body = (req.body ?? {}) as { project?: unknown; name?: unknown }
  const project =
    typeof body.name === "string" && body.name.trim() ? await uniqueProject(slugify(body.name)) : safeProject(body.project)
  if (project === null) {
    res.status(400).json({ error: "invalid_project", message: "Nome de projeto inválido." })
    return
  }
  if (projectInUse(project, key)) {
    res.status(409).json({ error: "project_in_use", message: "Este projeto já é usado por outro dispositivo." })
    return
  }
  const record = devices[key] ?? {}
  record.project = project
  devices[key] = record
  await mkdir(projectDirectory(project), { recursive: true }).catch(() => {})
  await persistNow()
  res.json({ ok: true, project, directory: projectDirectory(project), root: projectRoot, projects: await listProjects() })
})

/** Renomeia, move de projeto ou promove/rebaixa um dispositivo. */
app.patch("/app/devices/:key", express.json(), async (req, res) => {
  if (!requireOwner(req, res)) return
  const key = String(req.params.key ?? "")
  const record = devices[key]
  if (!record) {
    res.status(404).json({ error: "not_found", message: "Dispositivo não encontrado." })
    return
  }
  const body = (req.body ?? {}) as { name?: unknown; project?: unknown; owner?: unknown }
  if (typeof body.name === "string") {
    const name = body.name.trim().slice(0, 40)
    if (name) record.name = name
  }
  if (body.project !== undefined) {
    const project = safeProject(body.project)
    if (project === null) {
      res.status(400).json({ error: "invalid_project", message: "Nome de projeto inválido." })
      return
    }
    if (projectInUse(project, key)) {
      res.status(409).json({ error: "project_in_use", message: "Este projeto já é usado por outro dispositivo." })
      return
    }
    record.project = project
    await mkdir(projectDirectory(project), { recursive: true }).catch(() => {})
  }
  if (typeof body.owner === "boolean" && key !== "local") record.owner = body.owner
  await persistNow()
  res.json({ ok: true, ...(await devicesPayload(req)) })
})

/** Esquece um dispositivo (e, se pedido, apaga a pasta do projeto dele). */
app.delete("/app/devices/:key", async (req, res) => {
  if (!requireOwner(req, res)) return
  const key = String(req.params.key ?? "")
  if (key === "local") {
    res.status(400).json({ error: "protected", message: "Este computador não pode ser removido." })
    return
  }
  const record = devices[key]
  if (!record) {
    res.status(404).json({ error: "not_found", message: "Dispositivo não encontrado." })
    return
  }
  const wipe = String(req.query.wipe ?? "") === "1"
  const project = record.project ?? ""
  delete devices[key]
  let wiped = false
  if (wipe && project) {
    const target = path.join(projectRoot, project)
    if (target.startsWith(`${projectRoot}${path.sep}`)) {
      await rm(target, { recursive: true, force: true }).catch(() => {})
      wiped = true
    }
  }
  await persistNow()
  res.json({ ok: true, wiped, ...(await devicesPayload(req)) })
})

// ------------------------------------------------------------------- zip

/** Pastas regeneráveis: ficam de fora do zip (junto com o .git). */
const ZIP_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "target",
  "vendor",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".cache",
  ".turbo",
  ".parcel-cache",
  ".pytest_cache",
  ".mypy_cache",
  ".gradle",
  ".idea",
  ".vscode-server",
])

const ZIP_SKIP_FILES = new Set([".DS_Store", "Thumbs.db"])
const ZIP_SKIP_SUFFIX = [".log"]
const ZIP_MAX_BYTES = 500 * 1024 * 1024

type ZipEntry = { absolute: string; relative: string }

async function collectForZip(
  root: string,
  target: string = root,
  depth = 0,
  out: ZipEntry[] = [],
  state = { bytes: 0 },
): Promise<ZipEntry[]> {
  if (depth > 24) return out
  let entries
  try {
    entries = await readdir(target, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const absolute = path.join(target, entry.name)
    if (entry.isDirectory()) {
      if (ZIP_SKIP_DIRS.has(entry.name)) continue
      await collectForZip(root, absolute, depth + 1, out, state)
      continue
    }
    if (!entry.isFile()) continue
    if (ZIP_SKIP_FILES.has(entry.name) || ZIP_SKIP_SUFFIX.some((suffix) => entry.name.endsWith(suffix))) continue
    let size = 0
    try {
      size = (await stat(absolute)).size
    } catch {
      continue
    }
    state.bytes += size
    if (state.bytes > ZIP_MAX_BYTES) throw new Error("projeto grande demais para o download (limite de 500 MB)")
    out.push({ absolute, relative: path.relative(root, absolute) })
  }
  return out
}

/** Baixa o projeto do próprio dispositivo (sem parâmetro de caminho). */
app.get("/app/download", async (req, res) => {
  const directory = workspaceDirectory(req)
  const record = devices[deviceKey(req)]
  const label = record?.project || path.basename(directory) || "projeto"
  try {
    const files = await collectForZip(directory)
    if (files.length === 0) {
      res.status(404).json({ error: "empty_project", message: "Este projeto não tem arquivos para baixar." })
      return
    }
    res.setHeader("content-type", "application/zip")
    res.setHeader("content-disposition", `attachment; filename="${slugify(label)}.zip"`)
    res.setHeader("cache-control", "no-store")
    const archive = archiver("zip", { zlib: { level: 6 } })
    archive.on("error", (error) => {
      console.warn("[opencode-web] falha ao gerar o zip:", error)
      res.destroy()
    })
    archive.pipe(res)
    for (const file of files) archive.file(file.absolute, { name: file.relative })
    await archive.finalize()
  } catch (error) {
    if (res.headersSent) {
      res.destroy()
      return
    }
    errorResponse(res, 500, "zip_failed", error)
  }
})

app.get("/app/agents", async (req, res) => {
  const directory = workspaceDirectory(req)
  try {
    const { target, existed, data } = await readAgentConfig(directory)
    res.json({ file: relativeConfig(directory, target), existed, agents: readAgents(data) })
  } catch (error) {
    errorResponse(res, 400, "config_invalid", error)
  }
})

app.post("/app/agents", express.json(), async (req, res) => {
  const directory = workspaceDirectory(req)
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const id = String(body.id ?? "").trim()
    if (!AGENT_ID.test(id)) {
      res.status(400).json({
        error: "invalid_id",
        message: "Use apenas letras, números, ponto, hífen ou sublinhado (começando por letra ou número).",
      })
      return
    }
    const { target, data } = await readAgentConfig(directory)
    const agents = { ...readAgents(data) }
    const previous = agents[id] && typeof agents[id] === "object" ? (agents[id] as Record<string, unknown>) : {}
    const entry: Record<string, unknown> = { ...previous }
    if (typeof body.description === "string") entry.description = body.description
    if (typeof body.system === "string") entry.system = body.system
    if (typeof body.mode === "string" && body.mode) entry.mode = body.mode
    if (typeof body.color === "string" && body.color) entry.color = body.color
    if (typeof body.hidden === "boolean") entry.hidden = body.hidden
    if (body.model && typeof body.model === "object" && !Array.isArray(body.model)) entry.model = body.model
    if (!entry.mode) entry.mode = "primary"
    agents[id] = entry
    await writeAgentConfig(target, { ...data, agents })
    res.json({ file: relativeConfig(directory, target), agents })
  } catch (error) {
    errorResponse(res, 500, "write_failed", error)
  }
})

app.delete("/app/agents/:id", async (req, res) => {
  const directory = workspaceDirectory(req)
  try {
    const id = String(req.params.id ?? "").trim()
    const { target, data } = await readAgentConfig(directory)
    const agents = { ...readAgents(data) }
    if (!(id in agents)) {
      res.status(404).json({ error: "not_found", message: `Agente "${id}" não encontrado no config.` })
      return
    }
    delete agents[id]
    await writeAgentConfig(target, { ...data, agents })
    res.json({ file: relativeConfig(directory, target), agents })
  } catch (error) {
    errorResponse(res, 500, "write_failed", error)
  }
})

app.use("/api", (req, res) => {
  void proxy(req, res)
})

const server = createServer(app)

function logStartup() {
  console.log(`[opencode-web] interface em http://${bindHost()}:${PORT}`)
  console.log(`[opencode-web] raiz dos projetos: ${projectRoot}`)
  if (forcedHost) console.log(`[opencode-web] endereço fixado por HOST=${forcedHost}`)
  if (authEnabled()) {
    console.log("[opencode-web] acesso pela rede: ATIVADO (senha obrigatória)")
    console.log(`[opencode-web] senha de acesso: ${accessPassword()}`)
    if (customPassword) {
      console.log("[opencode-web]    (senha personalizada definida no painel 🌐)")
    } else {
      console.log("[opencode-web]    (senha do terminal: muda a cada execução)")
    }
    console.log(`[opencode-web] senha do terminal: ${runToken}`)
    for (const url of lanUrls()) console.log(`[opencode-web] acesse de outro dispositivo: ${url}`)
  } else {
    console.log("[opencode-web] acesso pela rede: desativado (somente esta máquina)")
  }
}

/** Reabre o servidor no endereço atual, preservando o app (o navegador recarrega). */
async function rebind() {
  const host = bindHost()
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections?.()
  })
  await new Promise<void>((resolve) => {
    const onError = (error: Error) => console.error("[opencode-web] falha ao reabrir o servidor", error)
    server.once("error", onError)
    server.listen(PORT, host, () => {
      server.off("error", onError)
      logStartup()
      resolve()
    })
  })
}

async function bootstrap() {
  const settings = await loadSettings()
  runToken = randomBytes(24).toString("hex")
  customPassword = envToken ? undefined : settings.password?.trim() || undefined
  networkEnabled = forcedHost ? !isLoopback(forcedHost) : Boolean(settings.networkEnabled)
  if (!envProjectsRoot && settings.projectRoot?.trim()) projectRoot = path.resolve(settings.projectRoot.trim())
  devices = settings.devices && typeof settings.devices === "object" ? settings.devices : {}
  // O computador do servidor é sempre o dono da raiz.
  const local = devices.local ?? {}
  devices.local = { ...local, owner: true, project: typeof local.project === "string" ? local.project : "" }
  await mkdir(projectRoot, { recursive: true }).catch((error) => {
    console.warn(`[opencode-web] não foi possível criar a raiz de projetos ${projectRoot}:`, error)
  })
  // A senha do terminal nunca é gravada em disco (é nova a cada execução).
  if (!envToken) await persistNow()

  if (isProduction) {
    const dist = path.join(appDirectory, "dist")
    app.use(express.static(dist))
    app.use((_req, res) => {
      res.sendFile(path.join(dist, "index.html"))
    })
  } else {
    const { createServer: createViteServer } = await import("vite")
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    })
    app.use(vite.middlewares)
  }

  server.listen(PORT, bindHost(), () => {
    logStartup()
  })
}

void bootstrap()
