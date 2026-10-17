import { useState } from "react"
import { replyPermission } from "../lib/store"
import type { PermissionRequest } from "../lib/types"

export function PermissionCard({ request }: { request: PermissionRequest }) {
  const [busy, setBusy] = useState(false)

  const act = async (decision: "once" | "always" | "reject") => {
    setBusy(true)
    await replyPermission(request, decision)
    setBusy(false)
  }

  return (
    <div className="permission">
      <div className="permission-head">
        <span aria-hidden>🔐</span> Permissão necessária
      </div>
      <div className="permission-body">
        <p>{request.message ?? `O agente quer executar a ação "${request.action}".`}</p>
        {request.resources.length > 0 ? (
          <ul>
            {request.resources.slice(0, 8).map((resource) => (
              <li key={resource}>
                <code>{resource}</code>
              </li>
            ))}
            {request.resources.length > 8 ? <li>e mais {request.resources.length - 8}…</li> : null}
          </ul>
        ) : null}
      </div>
      <div className="permission-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void act("once")}>
          Permitir uma vez
        </button>
        <button type="button" disabled={busy} onClick={() => void act("always")}>
          Permitir sempre
        </button>
        <button type="button" className="danger" disabled={busy} onClick={() => void act("reject")}>
          Recusar
        </button>
      </div>
    </div>
  )
}
