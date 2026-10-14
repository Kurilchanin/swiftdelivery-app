# SwiftDelivery

**Smart contract (mainnet):** [`EQC1TC10dI1a52wWyqv0wVqy3GUcvGSzamRlBvJo1_Nca_Gp`](https://tonviewer.com/EQC1TC10dI1a52wWyqv0wVqy3GUcvGSzamRlBvJo1_Nca_Gp)

SwiftDelivery is a Telegram Mini App for peer-to-peer parcel delivery on the
TON blockchain. Clients post delivery orders with a reward in **USDT**;
couriers accept and complete them. The service fees and all network fees are
paid in TON. The reward is held in escrow by a smart contract — the platform
never holds or controls the money.

- **App:** [t.me/SwiftDelivery_bot/app](https://t.me/SwiftDelivery_bot/app)
- **Web:** [swiftdelivery.pages.dev](https://swiftdelivery.pages.dev)
- **Contracts:** [github.com/Kurilchanin/swiftdelivery-contracts](https://github.com/Kurilchanin/swiftdelivery-contracts)

## How it works

1. A client creates an order with one USDT transfer: destination and origin
   cities, description, contact, and the reward. The Marketplace deploys a
   dedicated Order contract and moves the USDT into that order's own USDT
   wallet.
2. A courier browses the feed and accepts an order.
3. On handoff, the client gives the courier a secret code. The courier submits
   it on-chain; the contract verifies it against the stored hash and sends the
   USDT reward to the courier.
4. If the courier does not deliver within the delivery time the client picked
   (1–14 days from the accept), the client claims the reward back. An order
   nobody has taken can be cancelled.

Every payout path is enforced by the contract code, which is frozen at deploy
time — no message can change it. See the
[contracts repository](https://github.com/Kurilchanin/swiftdelivery-contracts)
for the full fee table and escrow rules.

## Fees

One service fee per action, paid in TON, with every network fee inside it:
create 0.1, accept 0.1, courier gives up 0.2, cancel 0.3. Nothing is added on
top and nothing comes back. Confirm, claim and cancelling an order whose USDT
never arrived have no service fee: before signing, the app emulates the call
against the order's current state (the way wallets do) and attaches only its
network fee (~0.0007 TON). The order pays the USDT payout from the fees it
holds.

## Tech stack

- **Frontend:** React 19 + Vite, Telegram Web App SDK (`telegram-web-app.js`)
- **Wallet:** TON Connect (`@tonconnect/ui-react`)
- **Chain access:** toncenter API (`@ton/ton`, `@ton/core`)
- **Fee emulation:** the TON emulator from `@ton/sandbox`, loaded only when an
  action needs it
- **Tests:** Vitest
- **Contracts:** Tolk, built with acton — included as the `contract/` git submodule

## Development

```bash
npm install
cp .env.example .env   # fill in network, contract addresses, Toncenter API keys
npm run dev
```

Set a Toncenter API key for each network (`VITE_TONCENTER_API_KEY` and
`VITE_TONCENTER_API_KEY_MAINNET`, from @tonapibot). Without one, Toncenter
allows about one request per second and the app gets HTTP 429 errors: slow
syncs and missing data.

`npm run build` produces the production bundle; `npm run lint` runs ESLint;
`npm test` runs the unit tests (they also check that the app computes the same
order address and create payload as the contracts).

## License

MIT — see [LICENSE](LICENSE).
