import { Address, beginCell, Cell, loadTransaction, storeMessage, storeShardAccount, toNano } from '@ton/core'
import { TONCENTER, TONCENTER_V3, TONCENTER_API_KEY } from './network'

// What running an order's code costs, measured the way wallets measure it: the
// app runs the real message against the order's CURRENT on-chain state and the
// network's CURRENT config in a local TON emulator (the same one @ton/sandbox
// uses) and reads the gas fee off the emulated transaction. Nothing is cached.
//
// Used for the actions that carry no service fee — confirm, claim, and cancelling
// an order whose USDT never arrived. The caller attaches exactly this fee, with
// no headroom: once the caller is checked, the order pays for its own gas
// (setGasLimitToMaximum in Order.tolk), so if the real run needs a little more
// than the emulation, the order's fee pool covers it. The USDT payout the action
// triggers is paid by the order too.

const HEADERS = TONCENTER_API_KEY ? { headers: { 'X-API-Key': TONCENTER_API_KEY } } : undefined

// GET with the same backoff on 429 the other Toncenter readers use.
async function getJson(url, attempt = 0) {
  const r = await fetch(url, HEADERS)
  if (r.status === 429 && attempt < 3) {
    await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt + Math.random() * 400))
    return getJson(url, attempt + 1)
  }
  if (!r.ok) throw new Error('toncenter ' + r.status)
  return r.json()
}

// The emulator is several MB of WebAssembly, so it is loaded only the first time
// an action needs it, and created once. A failed load (a flaky network drops the
// big chunk) is not kept: the next action tries again. Kept, it would block every
// confirm and claim — how a courier gets paid — until Telegram restarts the app.
let executorPromise = null
export function getExecutor() {
  executorPromise ??= import('@ton/sandbox/dist/executor/Executor')
    .then((m) => m.Executor.create())
    .catch((err) => {
      executorPromise = null
      throw err
    })
  return executorPromise
}

// The contract rejected the emulated message (wrong status, not the courier,
// bad code, …): the real one would fail the same way, so it is never sent.
export class EmulationRejected extends Error {
  constructor(exitCode) {
    super('the order rejects this action (exit code ' + exitCode + ')')
    this.exitCode = exitCode
  }
}

// The nanoGRAM to attach to a message with `body` from `from` to the order at
// `to`: exactly the gas fee of the order's own emulated transaction.
export async function emulateCallFee({ from, to, body }) {
  const [executor, config, state] = await Promise.all([
    getExecutor(),
    getJson(`${TONCENTER}/getConfigAll`).then((d) => d?.result?.config?.bytes),
    getJson(`${TONCENTER_V3}/accountStates?address=${encodeURIComponent(to)}&include_boc=true`).then(
      (d) => d?.accounts?.[0],
    ),
  ])
  if (!config) throw new Error('no network config')
  if (!state || state.status !== 'active' || !state.code_boc || !state.data_boc) {
    throw new Error('order account not active')
  }

  const now = Math.floor(Date.now() / 1000)
  const address = Address.parse(to)
  // The same shape @ton/sandbox builds (createShardAccount): only code, data and
  // balance matter for the gas. The emulator refuses ("can't unpack shard
  // account") the real last-transaction fields, and with no storage used there
  // is no rent to charge, so they are zero.
  const shardAccount = beginCell()
    .store(
      storeShardAccount({
        account: {
          addr: address,
          storage: {
            lastTransLt: 0n,
            balance: { coins: BigInt(state.balance) },
            state: {
              type: 'active',
              state: { code: Cell.fromBase64(state.code_boc), data: Cell.fromBase64(state.data_boc) },
            },
          },
          // Rent is paid from the order's balance in the real transaction, not
          // from the attached coin, so the emulation charges none.
          storageStats: {
            used: { cells: 0n, bits: 0n },
            lastPaid: 0,
            duePayment: null,
            storageExtra: null,
          },
        },
        lastTransactionLt: 0n,
        lastTransactionHash: 0n,
      }),
    )
    .endCell()

  // The value only sets the emulation's gas limit (the handlers never read it),
  // so it is generous: the measured gas is the same with any value that covers it.
  const lt = BigInt(state.last_transaction_lt) + 1000n
  const message = beginCell()
    .store(
      storeMessage({
        info: {
          type: 'internal',
          ihrDisabled: true,
          bounce: true,
          bounced: false,
          src: Address.parse(from),
          dest: address,
          value: { coins: toNano('1') },
          ihrFee: 0n,
          forwardFee: 0n,
          createdLt: lt,
          createdAt: now,
        },
        body,
      }),
    )
    .endCell()

  const res = await executor.runTransaction({
    config,
    libs: null,
    verbosity: 'short',
    shardAccount: shardAccount.toBoc().toString('base64'),
    now,
    lt,
    randomSeed: null,
    ignoreChksig: false,
    debugEnabled: false,
    message,
  })
  if (!res.result.success) throw new Error('emulation failed: ' + res.result.error)

  const tx = loadTransaction(Cell.fromBase64(res.result.transaction).beginParse())
  const d = tx.description
  if (d.type !== 'generic' || d.computePhase.type !== 'vm') throw new Error('emulation: no compute phase')
  if (!d.computePhase.success || d.aborted) throw new EmulationRejected(d.computePhase.exitCode)

  return d.computePhase.gasFees
}
