// Cloudflare Worker entry: wires the real bindings into router.js.
import './bufferPolyfill.js'
import { handle } from './router.js'
import { d1Store, deleteExpired } from './d1Store.js'

export default {
  async fetch(request, env) {
    return handle(
      request,
      { ...env, INVITES: d1Store(env.INVITES) },
      { fetch: (url, init) => fetch(url, init), now: () => Math.floor(Date.now() / 1000) },
    )
  },
  // Hourly (wrangler.toml [triggers]): drop invites that have run out, so none
  // is kept for more than about an hour after its end (the privacy policy says so).
  async scheduled(_event, env) {
    await deleteExpired(env.INVITES, Math.floor(Date.now() / 1000))
  },
}
