// A tiny hash-based router. We avoid a routing dependency on purpose:
// the whole app has 5 pages, so a few lines do the job.
import { useSyncExternalStore } from 'react'

function getPath() {
  return window.location.hash.slice(1) || '/'
}

function subscribe(cb) {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}

// Returns the current path, e.g. "/", "/create", "/order/3".
export function usePath() {
  return useSyncExternalStore(subscribe, getPath)
}

// Go to a path. Example: navigate('/order/3')
export function navigate(to) {
  if (getPath() === to) return
  window.location.hash = to
}
