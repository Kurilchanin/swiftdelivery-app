// @ton/core uses the global `Buffer`. The Pages function imports this first
// (an import of its own, so it runs before @ton/core is evaluated).
import { Buffer } from 'node:buffer'

if (!globalThis.Buffer) {
  globalThis.Buffer = Buffer
}
