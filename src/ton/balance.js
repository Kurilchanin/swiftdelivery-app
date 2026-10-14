import { TONCENTER, TONCENTER_API_KEY } from './network'

// Read a wallet balance in TON. Returns a number, or null on any error.
export async function fetchBalance(address, attempt = 0) {
  try {
    const url = TONCENTER + '/getAddressBalance?address=' + encodeURIComponent(address)
    // Send the API key as a header (never in the URL, so it stays out of logs),
    // same as indexer.js — raises rate limits on this read.
    const key = TONCENTER_API_KEY
    const r = await fetch(url, key ? { headers: { 'X-API-Key': key } } : undefined)
    if (r.status === 429 && attempt < 3) {
      await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt + Math.random() * 400))
      return fetchBalance(address, attempt + 1)
    }
    if (!r.ok) return null
    const data = await r.json()
    if (!data.ok) return null
    // result is a string of nanotons.
    return Number(BigInt(data.result)) / 1e9
  } catch {
    return null
  }
}
