import { useEffect, useMemo, useRef } from "react"
import { Marked } from "marked"
import DOMPurify from "dompurify"
import { copyText } from "../lib/browser"

const marked = new Marked({ gfm: true, breaks: true })

/** Closes an unterminated code fence so streaming markdown renders sanely. */
function balanceFences(text: string): string {
  const fences = text.match(/```/g)
  if (fences && fences.length % 2 === 1) return `${text}\n\`\`\``
  return text
}

function render(text: string): string {
  const html = marked.parse(balanceFences(text), { async: false }) as string
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target", "rel"] })
}

export function Markdown({ text }: { text: string }) {
  const container = useRef<HTMLDivElement>(null)
  const html = useMemo(() => render(text), [text])

  useEffect(() => {
    const root = container.current
    if (!root) return
    for (const anchor of Array.from(root.querySelectorAll("a"))) {
      anchor.setAttribute("target", "_blank")
      anchor.setAttribute("rel", "noreferrer")
    }
    for (const pre of Array.from(root.querySelectorAll("pre"))) {
      if (pre.querySelector(":scope > .code-copy")) continue
      const button = document.createElement("button")
      button.type = "button"
      button.className = "code-copy"
      button.textContent = "Copiar"
      button.addEventListener("click", () => {
        const code = pre.querySelector("code")?.textContent ?? ""
        void copyText(code)
        button.textContent = "Copiado!"
        window.setTimeout(() => {
          button.textContent = "Copiar"
        }, 1500)
      })
      pre.appendChild(button)
    }
  }, [html])

  return <div ref={container} className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
}
