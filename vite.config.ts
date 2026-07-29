import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// tauri.conf.json is the single source of truth for the app's name and version.
// The UI reads these constants rather than repeating the strings, so a rename
// cannot leave the window title and the header disagreeing.
const tauri = JSON.parse(readFileSync('./src-tauri/tauri.conf.json', 'utf8')) as {
  productName: string
  version: string
}

// Tauri expects a fixed port and must not have its output cleared.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  // Vite 8 resolves tsconfig `paths` natively — no vite-tsconfig-paths plugin.
  resolve: { tsconfigPaths: true },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  define: {
    __APP_NAME__: JSON.stringify(tauri.productName),
    __APP_VERSION__: JSON.stringify(tauri.version),
  },
  build: {
    // NOT Tauri's default 'safari13' — Tailwind v4 needs @property + color-mix().
    target: ['chrome111', 'safari16'],
    // Vite 8 ships oxc; 'esbuild' is deprecated and needs a separate install.
    minify: process.env.TAURI_ENV_DEBUG ? false : 'oxc',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
})
