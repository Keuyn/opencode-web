import { createServer } from "node:http"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { Readable } from "node:stream"
import path from "node:path"
import process from "node:process"
import express, { type Request, type Response } from "express"
import { Service } from "@opencode/client/service"

const isProduction = process.env.NODE_ENV === "production"
const PORT = Number(process.env.PORT ?? 3123)
const HOST = process.env.HOST ?? "127.0.0.1"
const projectDirectory = process.cwd()

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

async function bootstrap() {
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

  server.listen(PORT, HOST, () => {
    console.log(`[opencode-web] interface em http://${HOST}:${PORT}`)
    console.log(`[opencode-web] diretório do projeto: ${projectDirectory}`)
  })
}

void bootstrap()
