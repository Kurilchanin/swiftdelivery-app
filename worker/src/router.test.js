// The Worker must pass only the app's own toncenter calls, from our origins,
// with our app key, under a per-IP limit — and add the real toncenter key only
// on its way out.
import { describe, it, expect } from 'vitest'
import { handle } from './router.js'

const ORIGIN = 'https://swiftdelivery.pages.dev'
const BASE = 'https://swiftdelivery.fatherslab.workers.dev'

function setup({ allow = true, inviteAllow = true } = {}) {
  const calls = []
  const env = {
    ALLOWED_ORIGINS: 'https://swiftdelivery.pages.dev,https://*.swiftdelivery.pages.dev,http://localhost:5173',
    APP_KEY: 'app-key',
    TONCENTER_KEY_MAINNET: 'real-main',
    TONCENTER_KEY_TESTNET: 'real-test',
    MARKETPLACE_MAINNET: 'SET-AT-DEPLOY',
    MARKETPLACE_TESTNET: 'SET-AT-DEPLOY',
    TON_LIMIT: { limit: async () => ({ success: allow }) },
    INVITE_LIMIT: { limit: async () => ({ success: inviteAllow }) },
    INVITES: { get: async () => null, put: async () => true },
  }
  const deps = {
    now: () => 1800000000,
    fetch: async (url, init) => {
      calls.push({ url, init })
      return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  }
  const send = (path, { method = 'GET', origin = ORIGIN, key = 'app-key', body } = {}) => {
    const headers = { 'CF-Connecting-IP': '1.2.3.4' }
    if (origin) headers.Origin = origin
    if (key) headers['X-API-Key'] = key
    return handle(new Request(BASE + path, { method, headers, body }), env, deps)
  }
  return { env, deps, calls, send }
}

describe('worker: who may call', () => {
  it('refuses a missing or foreign origin', async () => {
    const { send, calls } = setup()
    expect((await send('/ton/mainnet/v3/accountStates?address=x', { origin: null })).status).toBe(403)
    expect((await send('/ton/mainnet/v3/accountStates?address=x', { origin: 'https://evil.dev' })).status).toBe(403)
    expect((await send('/ton/mainnet/v3/accountStates?address=x', { origin: 'https://evilswiftdelivery.pages.dev' })).status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('serves preview builds and local dev, and answers the CORS preflight', async () => {
    const { send } = setup()
    expect((await send('/ton/mainnet/v3/accountStates?address=x', { origin: 'https://abc.swiftdelivery.pages.dev' })).status).toBe(200)
    expect((await send('/ton/testnet/v3/accountStates?address=x', { origin: 'http://localhost:5173' })).status).toBe(200)
    const pre = await send('/ton/mainnet/v2/jsonRPC', { method: 'OPTIONS', key: null })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
    expect(pre.headers.get('Access-Control-Allow-Headers')).toContain('X-API-Key')
    // TonClient (getters on the create path) sends it; without it the browser drops the POST.
    expect(pre.headers.get('Access-Control-Allow-Headers')).toContain('X-Ton-Client-Version')
  })

  it('wants the app key', async () => {
    const { send, calls } = setup()
    expect((await send('/ton/mainnet/v3/accountStates?address=x', { key: null })).status).toBe(401)
    expect((await send('/ton/mainnet/v3/accountStates?address=x', { key: 'wrong' })).status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('limits each IP', async () => {
    const { send, calls } = setup({ allow: false })
    expect((await send('/ton/mainnet/v3/accountStates?address=x')).status).toBe(429)
    expect(calls).toHaveLength(0)
  })
})

describe('worker: toncenter proxy', () => {
  it('forwards an allowed call with the real key, never the app key', async () => {
    const { send, calls } = setup()
    const r = await send('/ton/mainnet/v3/accountStates?address=EQx&include_boc=true')
    expect(r.status).toBe(200)
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
    expect(calls[0].url).toBe('https://toncenter.com/api/v3/accountStates?address=EQx&include_boc=true')
    expect(calls[0].init.headers['X-API-Key']).toBe('real-main')
    await send('/ton/testnet/v2/getAddressBalance?address=EQx')
    expect(calls[1].url).toBe('https://testnet.toncenter.com/api/v2/getAddressBalance?address=EQx')
    expect(calls[1].init.headers['X-API-Key']).toBe('real-test')
  })

  it('lets through exactly the calls the app makes', async () => {
    const { send } = setup()
    for (const p of [
      '/ton/mainnet/v2/getAddressBalance?address=x',
      '/ton/mainnet/v2/getConfigAll',
      '/ton/mainnet/v3/accountStates?address=x',
      '/ton/mainnet/v3/transactions?account=x',
      '/ton/mainnet/v3/messages?source=x',
      '/ton/mainnet/v3/jetton/wallets?owner_address=x',
    ]) {
      expect((await send(p)).status, p).toBe(200)
    }
    for (const p of [
      '/ton/mainnet/v2/sendBoc',
      '/ton/mainnet/v2/getTransactions?address=x',
      '/ton/mainnet/v3/blocks',
      '/ton/mainnet/v3/wallet/states',
      '/ton/mainnet/v3/../v2/sendBoc',
      '/ton/devnet/v3/accountStates',
    ]) {
      expect([403, 404], p).toContain((await send(p)).status)
    }
    // GET-only endpoints refuse POST.
    expect((await send('/ton/mainnet/v3/accountStates', { method: 'POST', body: '{}' })).status).toBe(403)
  })

  it('jsonRPC: only get-method reads', async () => {
    const { send, calls } = setup()
    const rpc = (body) => send('/ton/mainnet/v2/jsonRPC', { method: 'POST', body: JSON.stringify(body) })
    expect((await rpc({ id: 1, jsonrpc: '2.0', method: 'runGetMethod', params: {} })).status).toBe(200)
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers['X-API-Key']).toBe('real-main')
    expect((await rpc({ method: 'sendBoc', params: {} })).status).toBe(403)
    expect((await rpc([{ method: 'runGetMethod' }, { method: 'sendBoc' }])).status).toBe(403)
    expect((await send('/ton/mainnet/v2/jsonRPC', { method: 'POST', body: 'nope' })).status).toBe(400)
    expect((await send('/ton/mainnet/v2/jsonRPC', { method: 'POST', body: 'x'.repeat(20000) })).status).toBe(413)
    expect(calls).toHaveLength(1)
  })
})

describe('worker: invites', () => {
  const ORDER = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c'

  it('reads an order slot and says when there is none', async () => {
    const { send, env } = setup()
    expect((await send(`/invite/mainnet/${ORDER}`)).status).toBe(404)
    env.INVITES.get = async () => ({ courier: '0:44', validUntil: 1800000100, signature: 's' })
    const r = await send(`/invite/mainnet/${ORDER}`)
    expect(r.status).toBe(200)
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
    expect((await r.json()).courier).toBe('0:44')
  })

  it('limits writes per IP and refuses them while the Marketplace is not set', async () => {
    expect((await setup({ inviteAllow: false }).send(`/invite/mainnet/${ORDER}`, { method: 'PUT', body: '{}' })).status).toBe(429)
    expect((await setup().send(`/invite/mainnet/${ORDER}`, { method: 'PUT', body: '{}' })).status).toBe(503)
  })
})
