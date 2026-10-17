/**
 * Compatibilidade com contexto não-seguro.
 *
 * Quando a interface é aberta por `http://192.168.x.x` (celular na rede local),
 * o navegador não expõe as APIs que só valem em contexto seguro (HTTPS ou
 * `localhost`): `crypto.randomUUID` e `navigator.clipboard`, por exemplo. Como
 * o acesso pela rede é justamente sobre `http://`, cada uma tem alternativa
 * aqui — sem isso o envio de mensagem simplesmente não acontecia no celular.
 */

/** UUID v4 que também funciona fora de contexto seguro. */
export function uuid(): string {
  const web = globalThis.crypto
  if (web && typeof web.randomUUID === "function") return web.randomUUID()

  const bytes = new Uint8Array(16)
  if (web && typeof web.getRandomValues === "function") web.getRandomValues(bytes)
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)

  // Versão 4 e variante RFC 4122.
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Copia texto para a área de transferência, com alternativa para `http://`. */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = navigator.clipboard
  if (clipboard && typeof clipboard.writeText === "function") {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      // sem permissão ou fora de contexto seguro: tenta o método antigo
    }
  }
  try {
    const area = document.createElement("textarea")
    area.value = text
    area.setAttribute("readonly", "")
    area.style.position = "fixed"
    area.style.top = "-1000px"
    area.style.opacity = "0"
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand("copy")
    document.body.removeChild(area)
    return copied
  } catch {
    return false
  }
}
