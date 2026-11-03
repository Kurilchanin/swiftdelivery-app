// The SwiftDelivery Worker (swiftdelivery.fatherslab.workers.dev). Two jobs:
//
//   /ton/<net>/v2/<method>, /ton/<net>/v3/<path>  — a proxy to toncenter. The
//       real toncenter key lives only here (a Worker secret); the app sends its
//       own app key, which is public (it is in the JS bundle), so it only keeps
//       out stray traffic. What protects the toncenter key is the rest: only the
//       calls the app makes are let through, every IP has a rate limit, and only
//       our origins are served.
//   /invite/<net>/<order>  — the accept-invite mailbox (src/server/inviteHandler.js).
//
// <net> is "mainnet" or "testnet". Pure: `env` carries the bindings and `deps`
// the outside world, so tests run it without Cloudflare.
import { Address } from '@ton/core'
import { handleInvite } from '../../src/server/inviteHandler.js'

const TONCENTER = {
  mainnet: 'https://toncenter.com/api',
  testnet: 'https://testnet.toncenter.com/api',
}

// Exactly the toncenter calls the app makes (see src/ton/network.js).
const ALLOWED = {
  v2: { GET: ['getAddressBalance', 'getConfigAll'], POST: ['jsonRPC'] },
  v3: { GET: ['accountStates', 'transactions', 'messages', 'jetton/wallets'] },
}
// jsonRPC: the app only reads contract get-methods (TonClient.runMethod).
const RPC_METHODS = ['runGetMethod']
const MAX_BODY = 16 * 1024

function originAllowed(origin, env) {
  if (!origin) return false
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)
  return list.some((o) =>
    o.startsWith('https://*.')
      ? origin.startsWith('https://') && origin.endsWith(o.slice('https://*'.length))
      : origin === o,
  )
}

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    // X-Ton-Client-Version: @ton/ton's TonClient adds it to every jsonRPC call.
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Ton-Client-Version',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

const reply = (status, body, headers = {}) =>
  new Response(body == null ? null : typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  })

const keyFor = (env, net) => (net === 'mainnet' ? env.TONCENTER_KEY_MAINNET : env.TONCENTER_KEY_TESTNET)

async function limited(limiter, key) {
  if (!limiter) return false
  const { success } = await limiter.limit({ key })
  return !success
}

async function proxyTon(request, env, net, version, endpoint, url, deps) {
  const allowed = ALLOWED[version]?.[request.method] || []
  if (!allowed.includes(endpoint)) return reply(403, { error: 'not allowed' })
  const init = { method: request.method, headers: {} }
  const key = keyFor(env, net)
  if (key) init.headers['X-API-Key'] = key
  if (request.method === 'POST') {
    const text = await request.text()
    if (text.length > MAX_BODY) return reply(413, { error: 'body' })
    let body
    try {
      body = JSON.parse(text)
    } catch {
      return reply(400, { error: 'body' })
    }
    const calls = Array.isArray(body) ? body : [body]
    if (!calls.length || calls.some((c) => !RPC_METHODS.includes(c?.method))) {
      return reply(403, { error: 'not allowed' })
    }
    init.body = text
    init.headers['Content-Type'] = 'application/json'
  }
  const r = await deps.fetch(`${TONCENTER[net]}/${version}/${endpoint}${url.search}`, init)
  return new Response(r.body, {
    status: r.status,
    headers: { 'Content-Type': r.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store' },
  })
}

// `env`: ALLOWED_ORIGINS, APP_KEY, TONCENTER_KEY_MAINNET/_TESTNET (secrets),
// MARKETPLACE_MAINNET/_TESTNET, TON_LIMIT and INVITE_LIMIT (rate limiters),
// INVITES (the invite store, see d1Store.js). `deps`: { fetch, now }.
export async function handle(request, env, deps) {
  const url = new URL(request.url)
  const origin = request.headers.get('Origin')
  if (!originAllowed(origin, env)) return reply(403, { error: 'origin' })
  const h = cors(origin)
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h })
  if (env.APP_KEY && request.headers.get('X-API-Key') !== env.APP_KEY) {
    return reply(401, { error: 'app key' }, h)
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  const parts = url.pathname.split('/').filter(Boolean)
  const [kind, net] = parts
  if (!TONCENTER[net]) return reply(404, { error: 'not found' }, h)

  if (kind === 'ton' && (parts[2] === 'v2' || parts[2] === 'v3')) {
    if (await limited(env.TON_LIMIT, ip)) return reply(429, { error: 'rate limit' }, h)
    const res = await proxyTon(request, env, net, parts[2], parts.slice(3).join('/'), url, deps)
    const out = new Response(res.body, res)
    for (const [k, v] of Object.entries(h)) out.headers.set(k, v)
    return out
  }

  if (kind === 'invite' && parts.length === 3) {
    if (request.method === 'PUT' && (await limited(env.INVITE_LIMIT, ip))) {
      return reply(429, { error: 'rate limit' }, h)
    }
    let marketplace = null
    try {
      marketplace = Address.parse(net === 'mainnet' ? env.MARKETPLACE_MAINNET : env.MARKETPLACE_TESTNET)
    } catch {
      // not configured: PUT answers 503, GET still works
    }
    const key = keyFor(env, net)
    const res = await handleInvite({
      method: request.method,
      orderParam: parts[2],
      bodyText: request.method === 'PUT' ? await request.text() : null,
      now: deps.now(),
      db: env.INVITES,
      fetchAccount: async (address) => {
        try {
          const r = await deps.fetch(
            `${TONCENTER[net]}/v3/accountStates?address=${encodeURIComponent(address)}&include_boc=true`,
            { headers: key ? { 'X-API-Key': key } : {} },
          )
          if (!r.ok) return null
          return (await r.json())?.accounts?.[0] || null
        } catch {
          return null
        }
      },
      marketplace,
    })
    return reply(res.status, res.body, { ...res.headers, ...h })
  }

  return reply(404, { error: 'not found' }, h)
}
