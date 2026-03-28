import { defineConfig } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/session': 'http://127.0.0.1:8085',
      '/credentials': 'http://127.0.0.1:8085',
      '/proxy': 'http://127.0.0.1:8085',
      '/healthz': 'http://127.0.0.1:8085',
    },
  },
})
