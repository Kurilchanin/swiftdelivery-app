import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// CSP is sent as an HTTP header from public/_headers (Cloudflare Pages), not
// via a <meta> tag.
// The <meta> approach silently ignores frame-ancestors and cannot set worker-src.

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Do not ship source maps in production.
    sourcemap: false,
  },
  // Unit tests (npm test). jsdom gives us localStorage and window, which the
  // storage helpers under test read directly.
  test: {
    environment: 'jsdom',
  },
})
