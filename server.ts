import { randomBytes, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir, networkInterfaces } from "node:os"
import { Readable } from "node:stream"
import path from "node:path"
import process from "node:process"
import express, { type Request, type Response } from "express"
import { Service } from "@opencode/client/service"

const isProduction = process.env.NODE_ENV === "production"
const PORT = Number(process.env.PORT ?? 3123)
const projectDirectory = process.cwd()

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

type Settings = { password?: string; networkEnabled?: boolean }

let networkEnabled = false
/** Senha do terminal: nova a cada execução (não é persistida). */
let runToken = ""
/** Senha personalizada do painel: definida pelo usuário, salva em disco. */
let customPassword: string | undefined

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

/**
 * Transparent streaming proxy to the OpenCode HTTP API. The browser talks to
 * the official `@opencode/client` on this same origin, and the server attaches
 * the discovery credentials and streams responses (including SSE) through.
 */
async function proxy(req: Request, res: Response, retried = false) {
  const hasBody = !["GET", "HEAD"].includes(req.method.toUpperCase())
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
    // Avoid compressed streams so the body can be piped through untouched.
    headers.set("accept-encoding", "identity")

    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream) : undefined,
      // Required by undici when streaming a request body.
      duplex: "half",
    } as RequestInit & { duplex: "half" })

    if (upstream.status === 401 && !retried && !hasBody) {
      await upstream.body?.cancel().catch(() => {})
      await resolveEndpoint(true)
      return proxy(req, res, true)
    }

    res.status(upstream.status)
    for (const [key, value] of upstream.headers) {
      if (HOP_BY_HOP.has(key.toLowerCase())) continue
      res.setHeader(key, value)
    }
    if (upstream.headers.get("content-type")?.includes("text/event-stream")) {
      res.setHeader("cache-control", "no-cache, no-transform")
      res.setHeader("x-accel-buffering", "no")
    }

    if (!upstream.body) {
      res.end()
      return
    }
    res.flushHeaders?.()
    Readable.fromWeb(upstream.body as never).pipe(res)
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

async function readAgentConfig(): Promise<{ target: string; existed: boolean; data: Record<string, unknown> }> {
  for (const relative of AGENT_CONFIG_CANDIDATES) {
    const file = path.join(projectDirectory, relative)
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
  return { target: path.join(projectDirectory, "opencode.json"), existed: false, data: {} }
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

function relativeConfig(target: string): string {
  const relative = path.relative(projectDirectory, target)
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
  await saveSettings({ password: customPassword, networkEnabled })
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
  if (forcedHost) {
    res.status(409).json({ error: "locked", message: "O endereço é definido pela variável HOST." })
    return
  }
  const body = (req.body ?? {}) as { enabled?: unknown }
  const enabled = Boolean(body.enabled)
  networkEnabled = enabled
  if (!envToken) await saveSettings({ password: customPassword, networkEnabled })
  if (enabled || authEnabled()) {
    // Mantém este navegador autenticado depois que a porta é reaberta.
    res.setHeader("set-cookie", cookieHeader(accessPassword(), COOKIE_MAX_AGE))
  }
  res.json({ enabled, reload: true })
  setTimeout(() => {
    void rebind()
  }, 300)
})

app.get("/app/config", (_req, res) => {
  res.json({
    directory: projectDirectory,
    version: process.env.npm_package_version ?? "0.1.0",
  })
})

app.get("/app/agents", async (_req, res) => {
  try {
    const { target, existed, data } = await readAgentConfig()
    res.json({ file: relativeConfig(target), existed, agents: readAgents(data) })
  } catch (error) {
    errorResponse(res, 400, "config_invalid", error)
  }
})

app.post("/app/agents", express.json(), async (req, res) => {
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
    const { target, data } = await readAgentConfig()
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
    res.json({ file: relativeConfig(target), agents })
  } catch (error) {
    errorResponse(res, 500, "write_failed", error)
  }
})

app.delete("/app/agents/:id", async (req, res) => {
  try {
    const id = String(req.params.id ?? "").trim()
    const { target, data } = await readAgentConfig()
    const agents = { ...readAgents(data) }
    if (!(id in agents)) {
      res.status(404).json({ error: "not_found", message: `Agente "${id}" não encontrado no config.` })
      return
    }
    delete agents[id]
    await writeAgentConfig(target, { ...data, agents })
    res.json({ file: relativeConfig(target), agents })
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
  console.log(`[opencode-web] diretório do projeto: ${projectDirectory}`)
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
  // A senha do terminal nunca é gravada em disco (é nova a cada execução).
  if (!envToken && !forcedHost && settings.password !== customPassword) {
    await saveSettings({ password: customPassword, networkEnabled })
  }

  if (isProduction) {
    const dist = path.join(projectDirectory, "dist")
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
