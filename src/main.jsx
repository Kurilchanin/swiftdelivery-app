// Must be first: sets up the global Buffer that @ton/core needs.
import './polyfills'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TonConnectUIProvider } from '@tonconnect/ui-react'
import './index.css'
import App from './App.jsx'
import { initTelegram } from './telegram'
import { captureReferral, APP_LINK } from './referral'
import { openLinkedOrder } from './orderLink'
import { LANG, DIR } from './i18n'
import { MANIFEST_URL } from './ton/network'
import { purgeForeignNamespaces, sweepCloudSecrets } from './contracts/myOrders'
import { watchCspViolations } from './cspReport'

// First thing: record every CSP violation for the /debug screen, so the policy
// can be checked inside Telegram, where there is no console (see cspReport.js).
watchCspViolations()

// Drop any localStorage namespace from another Marketplace deploy. Must run
// before render so the first read of My Orders / History / Feed sees only the
// current data. See MARKETPLACE_TAG in ton/network.js.
purgeForeignNamespaces()

// Tell Telegram we are ready and pull in its theme colors.
initTelegram()

// Drop delivery codes whose orders the chain says are over. This needs no wallet
// and no page: it compares the cloud store with the chain, so it must NOT sit
// behind the My Orders sync (that one runs only for a connected wallet, and a
// user who never connects one would keep dead keys forever). One batched request
// per app start, in the background — nothing on screen waits for it.
sweepCloudSecrets().catch(() => {}) // a cleanup that fails is not worth a crash

// Load the user's referral (Telegram CloudStorage first, then the mini-app
// link): the first one ever captured is kept for good (see referral.js). It runs
// in the background; creating an order waits for it (referralReady).
captureReferral()

// Opened through a shared order link? Go straight to that order (see orderLink.js).
openLinkedOrder()

// Set the document language and writing direction for the session. DIR is
// 'rtl' for Persian and Arabic, which flips the whole layout (see index.css).
document.documentElement.lang = LANG
document.documentElement.dir = DIR

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <TonConnectUIProvider
      manifestUrl={MANIFEST_URL}
      // Where the wallet sends the user back after it answers. This is the
      // documented setting for a mini app, and it matters for wallets that are
      // themselves Telegram mini apps. It does NOT cure the duplicated connect
      // window of the native Tonkeeper app — that was measured and ruled out on
      // 2026-08-25 (it is a Telegram for Android bug).
      actionsConfiguration={{ twaReturnUrl: APP_LINK }}
    >
      <App />
    </TonConnectUIProvider>
  </StrictMode>,
)
