import { TonClient } from '@ton/ton'
import { TONCENTER, APP_KEY } from '../ton/network'

// A single shared TON RPC client for reading contract get-methods. It goes
// through our Worker (TONCENTER), which holds the real toncenter key; the
// client sends the app key as X-API-Key.
let client = null

export function getClient() {
  if (!client) {
    client = new TonClient({
      endpoint: TONCENTER + '/jsonRPC',
      apiKey: APP_KEY || undefined,
    })
  }
  return client
}
