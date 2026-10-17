import { useState } from "react"
import { ChatView } from "./components/ChatView"
import { Header } from "./components/Header"
import { LoginGate } from "./components/LoginGate"
import { Sidebar } from "./components/Sidebar"
import { useAppState } from "./lib/useStore"

export default function App() {
  const state = useAppState()
  const [draft, setDraft] = useState("")
  const [menuOpen, setMenuOpen] = useState(false)

  if (state.authRequired && !state.authed) {
    return <LoginGate />
  }

  return (
    <div className={`app ${menuOpen ? "menu-open" : ""}`}>
      <div className="sidebar-wrap">
        <Sidebar onClose={() => setMenuOpen(false)} />
      </div>
      <div className="backdrop" onClick={() => setMenuOpen(false)} />
      <main className="main">
        <Header onMenu={() => setMenuOpen(true)} />
        <ChatView draft={draft} setDraft={setDraft} />
      </main>
    </div>
  )
}
