import { TonClient } from '@ton/ton'
import { IS_TESTNET, TONCENTER_API_KEY } from '../ton/network'

// A single shared TON RPC client for reading contract get-methods.
// An API key is optional but strongly recommended: the public toncenter
// endpoint throttles hard (frequent HTTP 500/429) without one.
let client = null

export function getClient() {
  if (!client) {
    client = new TonClient({
      endpoint: IS_TESTNET
        ? 'https://testnet.toncenter.com/api/v2/jsonRPC'
        : 'https://toncenter.com/api/v2/jsonRPC',
      apiKey: TONCENTER_API_KEY || undefined,
    })
  }
  return client
}
