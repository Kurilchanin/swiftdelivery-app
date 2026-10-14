// A promise-based transaction preview. requestTxPreview() shows the modal and
// resolves to true (approve) or false (cancel). One pending request at a time.
import { useSyncExternalStore } from 'react'

let pending = null // { summary, resolve } | null
const listeners = new Set()
function emit() {
  listeners.forEach((l) => l())
}

export function requestTxPreview(summary) {
  // If something is already pending, cancel it first.
  if (pending) pending.resolve(false)
  return new Promise((resolve) => {
    pending = { summary, resolve }
    emit()
  })
}

function settle(ok) {
  if (!pending) return
  const { resolve } = pending
  pending = null
  emit()
  resolve(ok)
}

export const approveTx = () => settle(true)
export const cancelTx = () => settle(false)

export function usePendingTx() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => pending,
  )
}
