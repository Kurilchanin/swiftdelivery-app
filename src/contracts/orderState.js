// Pure order-state checks, shared by the app (orders.js) and the invite server
// (functions/). No network, no browser APIs: callers pass the Marketplace.
import { Address, Cell, beginCell } from '@ton/core'
import { Order, OrderExtra, OrderJetton, OrderStorage } from '../../contract/wrappers-ts/Order.gen'

// Base64 hash of the Order code this build knows. Accounts with another hash run
// another Order version (e.g. orders of a previous Marketplace) and are ignored.
export const ORDER_CODE_HASH_B64 = Order.CodeCell.hash().toString('base64')

// The address of an order's INITIAL state, the one the Marketplace deploys, from
// the fields fixed at create time (`f`: Address / Cell / bigint values).
// `marketplace` is the Address of the Marketplace that deploys it.
export function initialOrderAddress(f, marketplace) {
  return Order.fromStorage({
    client: f.client,
    courier: null,
    description: f.description,
    area: f.area,
    origin: f.origin,
    reward: f.reward,
    // Every order is deployed Funding; it turns Open when its USDT arrives.
    status: 5n,
    nonce: f.nonce,
    createdAt: f.createdAt,
    deliveryTime: f.deliveryTime,
    // 0 in the initial state, so it does not affect the order's address.
    acceptedAt: 0n,
    // owner + contacts live in a referenced cell (Cell<OrderExtra>) so the root
    // storage cell stays under 1023 bits. courierContact is empty at deploy
    // time; the client's contact and owner are part of the init data and so
    // must be included to match the on-chain address.
    extra: {
      ref: OrderExtra.create({
        owner: f.owner,
        clientContact: f.clientContact,
        courierContact: beginCell().storeStringTail('').endCell(),
        secretHash: f.secretHash,
        referral: f.referral,
        // The Marketplace that deploys the order is part of its init data, and
        // so is the client's invite key; the order's USDT wallet is not (null
        // until the Marketplace hands it over).
        jetton: {
          ref: OrderJetton.create({ marketplace, wallet: null, acceptKey: f.acceptKey }),
        },
      }),
    },
  }).address
}

// True when the order stored at `address` (`s`, a parsed OrderStorage) is one the
// Marketplace `marketplace` (Address) deployed. Anyone can deploy our Order code
// with made-up data — status Open, a big reward, no USDT behind it, themselves as
// owner — and send a courier a link to it; the code hash alone cannot tell. So we
// rebuild the order's initial state from its create-time fields, with OUR
// Marketplace in it, and require that it hashes to this very address.
//
// The owner is taken from the storage and needs no network check: a fake owner
// gives either a different address, or an order our Marketplace never deployed
// — and only that Marketplace can give an order its USDT wallet, so such an
// order stays Funding forever and can never be accepted.
export function isGenuineOrder(address, s, marketplace) {
  try {
    const x = s.extra.ref
    if (!x.jetton.ref.marketplace.equals(marketplace)) return false
    return initialOrderAddress(
      {
        client: s.client,
        description: s.description,
        area: s.area,
        origin: s.origin,
        reward: s.reward,
        nonce: s.nonce,
        createdAt: s.createdAt,
        deliveryTime: s.deliveryTime,
        owner: x.owner,
        clientContact: x.clientContact,
        secretHash: x.secretHash,
        referral: x.referral,
        acceptKey: x.jetton.ref.acceptKey,
      },
      marketplace,
    ).equals(Address.parse(address))
  } catch {
    return false
  }
}

// Parse an account from toncenter v3 /accountStates (`acc`) into OrderStorage
// when it is a genuine order of `marketplace`, else null.
export function genuineOrderStorage(address, acc, marketplace) {
  if (!acc || acc.status !== 'active' || !acc.data_boc) return null
  if (acc.code_hash !== ORDER_CODE_HASH_B64) return null
  try {
    const s = OrderStorage.fromSlice(Cell.fromBase64(acc.data_boc).beginParse())
    return isGenuineOrder(address, s, marketplace) ? s : null
  } catch {
    return null
  }
}
