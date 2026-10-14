// @ton/core uses the global `Buffer`, which browsers do not provide.
// This MUST run before any module that touches @ton/core is evaluated, so it
// lives in its own file and is imported as the very first line of main.jsx.
// (ES module imports are evaluated before the importing file's own statements,
// so an inline assignment in main.jsx would run too late.)
import { Buffer } from 'buffer'

if (!globalThis.Buffer) {
  globalThis.Buffer = Buffer
}
