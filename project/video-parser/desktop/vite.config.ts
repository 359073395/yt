import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // This installer targets Windows WebView2; Safari 13 cannot represent the
    // BigInt operations required by the existing ONNX translation worker.
    target: ['es2021', 'chrome105'],
    minify: 'oxc',
    sourcemap: false,
  },
  worker: {
    format: 'es',
  },
})
