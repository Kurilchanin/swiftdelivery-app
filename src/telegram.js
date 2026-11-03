// Thin wrapper over the Telegram WebApp SDK (loaded in index.html).
// All Telegram access goes through here so the rest of the app stays clean.

const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : null

// Call once at startup. Tells Telegram we are ready and locks the dark theme.
export function initTelegram() {
  if (!tg) return
  tg.ready()
  tg.expand?.()
  // The app uses a fixed dark theme (see index.css). We intentionally do NOT
  // copy Telegram's theme colors — that would override our palette. We only
  // tint the native header/bottom bars so they match our dark background
  // instead of flashing white. Hex args fail on old clients, so guard them.
  document.documentElement.dataset.theme = 'dark'
  // Each native-bar tint landed in a specific Bot API version; calling it on an
  // older client just logs a warning. Gate by version so old clients stay quiet
  // (they simply keep the default bars — the in-app content is still dark).
  const PAGE_BG = '#14161b' // = --bg in index.css; keep the two equal
  const supports = (v) => tg.isVersionAtLeast?.(v)
  if (supports('6.1')) tg.setBackgroundColor?.(PAGE_BG)
  if (supports('6.9')) tg.setHeaderColor?.(PAGE_BG)
  if (supports('7.10')) tg.setBottomBarColor?.(PAGE_BG)
}

// The Telegram user (name, id), or null when run outside Telegram.
export function getUser() {
  return tg?.initDataUnsafe?.user || null
}

// The start parameter from the mini-app link (t.me/<bot>/<app>?startapp=<value>),
// or null. Telegram only passes it when the app is opened via such a direct
// link — a launch from the bot's menu button carries none. Used for the
// referral chat's wallet address (see src/referral.js).
export function getStartParam() {
  return tg?.initDataUnsafe?.start_param || null
}

// The app language, picked from the Telegram client locale. Telegram gives an
// ISO code like "ru" or "en-US" in user.language_code. We map a few prefixes to
// the languages we ship; everyone else gets English. Outside Telegram (no user)
// we fall back to English. To add more languages later, extend this mapping and
// the dictionaries in i18n.js.
//   ru → Russian, es → Spanish (Cuba, Venezuela), fa → Persian (Iran),
//   ar → Arabic (Syria). fa and ar are right-to-left (see i18n.js / index.css).
export function getLanguage() {
  const code = (tg?.initDataUnsafe?.user?.language_code || '').toLowerCase()
  if (code.startsWith('ru')) return 'ru'
  if (code.startsWith('es')) return 'es'
  if (code.startsWith('fa') || code.startsWith('pe')) return 'fa' // fa / fa-IR (some clients send "pes")
  if (code.startsWith('ar')) return 'ar'
  return 'en'
}

// Reject Telegram initData older than 24 hours.
// Note: we do NOT verify the signature in the client (that needs the bot
// token, which must never live in client code). The trusted identity is the
// TON wallet via ton_proof (Phase 2). This is only a freshness sanity check.
export function isInitDataFresh() {
  const authDate = tg?.initDataUnsafe?.auth_date
  if (!authDate) return false
  const ageSeconds = Date.now() / 1000 - Number(authDate)
  return ageSeconds >= 0 && ageSeconds < 24 * 60 * 60
}

// Native Telegram confirm dialog. Use this for destructive actions instead of
// building our own modal. Falls back to window.confirm outside Telegram.
export function confirmAction(message) {
  return new Promise((resolve) => {
    if (tg?.showConfirm) tg.showConfirm(message, resolve)
    else resolve(window.confirm(message))
  })
}

// Open Telegram's built-in QR scanner and resolve with the scanned text, or null
// if the user closes it without scanning (or scanning is unsupported). Used by the
// courier to read the client's delivery code at hand-off — no camera library is
// needed, the scanner is part of the Telegram client. `text` is the small caption
// shown above the scanner. Outside Telegram (dev in a browser) we fall back to a
// prompt so the flow can still be tested.
export function scanQr(text) {
  return new Promise((resolve) => {
    if (tg?.showScanQrPopup) {
      let done = false
      const finish = (value) => {
        if (done) return
        done = true
        try { tg.closeScanQrPopup?.() } catch { /* ignore */ }
        resolve(value)
      }
      try {
        // Telegram rejects a caption longer than 64 chars and the popup never
        // opens, so clamp it. The callback fires for each decoded QR; returning
        // true closes the popup.
        tg.showScanQrPopup({ text: (text || '').slice(0, 64) }, (scanned) => {
          finish(scanned || null)
          return true
        })
      } catch {
        finish(null)
      }
    } else {
      // Browser dev fallback: ask for the code by hand.
      resolve(window.prompt(text || 'Delivery code') || null)
    }
  })
}

// Open a Telegram link (e.g. https://t.me/<username>) to start a chat. Inside
// Telegram this uses the native opener and switches to the chat; in a browser
// it falls back to a new tab with noopener.
export function openTelegramLink(url) {
  if (tg?.openTelegramLink) tg.openTelegramLink(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}

// True when running inside the real Telegram client.
export const inTelegram = Boolean(tg && tg.initData)

// ─── Telegram CloudStorage (Bot API 6.9+) ────────────────────────────────────
//
// Per-user key/value store synced by Telegram across all the user's devices (up
// to 1024 keys, 4096 bytes each). We use it to back up the client's delivery
// codes so they survive clearing localStorage or switching devices — the local
// store stays the fast path, the cloud is the recovery fallback. Keys must be
// 1–128 chars of [A-Za-z0-9_-]. All three calls degrade to a no-op (resolve
// null/false) outside Telegram or on clients without CloudStorage.

const cloud = tg?.CloudStorage

// Resolve the stored string for a key, or null if missing / unavailable.
export function cloudGet(key) {
  return new Promise((resolve) => {
    if (!cloud?.getItem) return resolve(null)
    try {
      cloud.getItem(key, (err, value) => resolve(err ? null : value || null))
    } catch {
      resolve(null)
    }
  })
}

// Like cloudGet, but tells "nothing stored" apart from "could not ask": resolves
// { ok: true, value } (value null when the key is missing) or { ok: false } when
// CloudStorage is unavailable or answered with an error. A caller that may only
// write when the key is truly empty needs that difference.
export function cloudRead(key) {
  return new Promise((resolve) => {
    if (!cloud?.getItem) return resolve({ ok: false })
    try {
      cloud.getItem(key, (err, value) => resolve(err ? { ok: false } : { ok: true, value: value || null }))
    } catch {
      resolve({ ok: false })
    }
  })
}

// Store a string under a key. Resolves true on success, false otherwise.
export function cloudSet(key, value) {
  return new Promise((resolve) => {
    if (!cloud?.setItem) return resolve(false)
    try {
      cloud.setItem(key, value, (err, ok) => resolve(!err && Boolean(ok)))
    } catch {
      resolve(false)
    }
  })
}

// Read several keys in one call. Resolves { key: value } (an empty string for a
// missing key), or null when CloudStorage cannot answer.
export function cloudGetItems(keys) {
  return new Promise((resolve) => {
    if (!cloud?.getItems) return resolve(null)
    try {
      cloud.getItems(keys, (err, values) => resolve(err ? null : values || {}))
    } catch {
      resolve(null)
    }
  })
}

// List every key this bot stored for this user. Resolves an array of keys, or
// null when CloudStorage is unavailable — null means "cannot ask", which is a
// different answer from [] ("asked, nothing stored"), and the diagnostics
// screen shows the two differently.
export function cloudGetKeys() {
  return new Promise((resolve) => {
    if (!cloud?.getKeys) return resolve(null)
    try {
      cloud.getKeys((err, keys) => resolve(err ? null : keys || []))
    } catch {
      resolve(null)
    }
  })
}

// Delete a key. Resolves true on success, false otherwise.
export function cloudRemove(key) {
  return new Promise((resolve) => {
    if (!cloud?.removeItem) return resolve(false)
    try {
      cloud.removeItem(key, (err, ok) => resolve(!err && Boolean(ok)))
    } catch {
      resolve(false)
    }
  })
}
