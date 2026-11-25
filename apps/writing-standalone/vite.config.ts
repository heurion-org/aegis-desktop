import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 1430,
  },
  build: {
    target: 'es2022',
  },
})
