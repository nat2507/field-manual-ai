import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  build: {
    outDir: '../backend/public',
    emptyOutDir: true,
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png'],
      manifest: {
        name: 'Field Manual AI',
        short_name: 'FieldAI',
        description: 'VESDA Fire Detection Field Support',
        theme_color: '#1a1d2e',
        background_color: '#1a1d2e',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: 'icon-192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/field-manual-ai-production\.up\.railway\.app\/api/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              networkTimeoutSeconds: 10,
            }
          }
        ]
      }
    })
  ],
  server: {
    proxy: {
      '/chat': 'http://localhost:3001',
      '/corrections': 'http://localhost:3001',
      '/documents': 'http://localhost:3001',
      '/health': 'http://localhost:3001',
      '/feedback': 'http://localhost:3001',
    }
  }
})