import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import { bootstrap } from "./lib/store"
import "./styles.css"

const container = document.getElementById("root")
if (!container) throw new Error("elemento #root não encontrado")

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  container.innerHTML = `<div class="fatal"><h1>Não foi possível iniciar</h1><p>${message}</p><p>Verifique se o serviço do OpenCode está rodando (<code>opencode service status</code>).</p></div>`
})

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
