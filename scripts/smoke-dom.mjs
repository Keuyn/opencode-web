/**
 * Teste de renderização: carrega o bundle de produção dentro do jsdom,
 * conversa com o proxy real e confere a interface montada.
 * Uso: node scripts/smoke-dom.mjs  (com o servidor já rodando)
 */
import { readdirSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { JSDOM } from "jsdom"

const origin = process.env.SMOKE_URL ?? "http://127.0.0.1:3123"
const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
  url: `${origin}/`,
  pretendToBeVisual: true,
})

const { window } = dom
const nodeFetch = globalThis.fetch

for (const key of Object.getOwnPropertyNames(window)) {
  if (key in globalThis) continue
  try {
    Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
  } catch {}
}

for (const key of ["window", "document", "navigator", "location", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "DOMParser"]) {
  try {
    Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
  } catch (error) {
    console.warn("não foi possível definir global", key, String(error))
  }
}

globalThis.fetch = (input, init) => {
  const url = typeof input === "string" && input.startsWith("/") ? `${origin}${input}` : input
  return nodeFetch(url, init)
}

const dist = path.join(process.cwd(), "dist", "assets")
const bundle = readdirSync(dist).find((file) => file.endsWith(".js"))
if (!bundle) throw new Error("bundle não encontrado: rode `npm run build` antes")

await import(pathToFileURL(path.join(dist, bundle)).href)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const text = () => window.document.body.textContent ?? ""
const waitFor = async (label, predicate, attempts = 60) => {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return true
    await sleep(250)
  }
  console.log(`FALHOU: ${label}`)
  return false
}
const waitForQuiet = async (predicate, attempts = 20) => {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return true
    await sleep(250)
  }
  return false
}

const results = []
results.push(["marca OpenCode Web", await waitFor("marca", () => text().includes("OpenCode Web"))])
results.push(["lista de sessões", await waitFor("sessões", () => window.document.querySelectorAll(".session-row").length > 0)])
results.push(["modelo no cabeçalho", await waitFor("modelo", () => Array.from(window.document.querySelectorAll(".picker select option")).some((option) => option.textContent?.includes("Big Pickle")))])
results.push(["campo de mensagem", await waitFor("composer", () => Boolean(window.document.querySelector(".composer textarea")))])

const sessionRow = window.document.querySelector(".session-row .session-main")
if (sessionRow) {
  sessionRow.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  results.push(["mensagens carregadas", await waitFor("mensagens", () => window.document.querySelectorAll(".message").length > 0)])
  results.push(["cartões de ferramenta", await waitFor("ferramentas", () => window.document.querySelectorAll(".tool").length > 0)])
  results.push(["blocos markdown", await waitFor("markdown", () => window.document.querySelectorAll(".markdown").length > 0)])

  // O raciocínio é persistido apenas em algumas conversas; procura em até 6 sessões
  // e restaura a primeira antes de continuar.
  let reasoningFound = false
  const rows = Math.min(6, window.document.querySelectorAll(".session-row .session-main").length)
  for (let index = 0; index < rows; index += 1) {
    const row = window.document.querySelectorAll(".session-row .session-main")[index]
    if (!row) break
    row.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
    if (await waitForQuiet(() => window.document.querySelectorAll(".reasoning").length > 0)) {
      reasoningFound = true
      break
    }
  }
  if (rows > 0) {
    const first = window.document.querySelectorAll(".session-row .session-main")[0]
    first?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
    await sleep(400)
  }
  results.push(["bloco de raciocínio", reasoningFound])
}

// painel de agentes (nova funcionalidade)
const agentTrigger = window.document.querySelector(".agent-trigger")
results.push(["botão de agentes", Boolean(agentTrigger)])
if (agentTrigger) {
  agentTrigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  results.push(["painel de agentes", await waitFor("painel de agentes", () => Boolean(window.document.querySelector(".agent-panel")))])
  results.push([
    "seção rodando agora",
    await waitForQuiet(() => (window.document.querySelector(".agent-panel")?.textContent ?? "").includes("Rodando agora")),
  ])
  const createTab = Array.from(window.document.querySelectorAll(".agent-panel-tabs button")).find((button) =>
    button.textContent?.includes("Criar"),
  )
  if (createTab) {
    createTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
    results.push([
      "formulário de agente",
      await waitForQuiet(() => Boolean(window.document.querySelector(".agent-form input"))),
    ])
  }
  agentTrigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  await sleep(250)
}

// digita e envia de verdade
const textarea = window.document.querySelector(".composer textarea")
if (textarea) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set
  setter.call(textarea, "Diga apenas: OK")
  textarea.dispatchEvent(new window.Event("input", { bubbles: true }))
  await sleep(200)
  const send = window.document.querySelector(".composer .send")
  results.push(["botão enviar habilitado", Boolean(send) && !send.disabled])
  if (send && !send.disabled) {
    send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
    results.push(["resposta do assistente", await waitFor("resposta", () => text().includes("OK") && window.document.querySelectorAll(".message-assistant").length > 0, 160)])
  }
}

let failures = 0
for (const [label, ok] of results) {
  console.log(`${ok ? "OK  " : "FALHA"} ${label}`)
  if (!ok) failures += 1
}
console.log(failures === 0 ? "\nTodos os checks passaram." : `\n${failures} check(s) falharam.`)
process.exit(failures === 0 ? 0 : 1)
