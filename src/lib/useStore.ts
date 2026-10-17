import { useSyncExternalStore } from "react"
import { getState, getVersion, subscribe } from "./store"
import type { AppState } from "./types"

export function useAppState(): AppState {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return getState()
}
