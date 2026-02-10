import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { copyFile } from "wpsjs/vite_plugins"

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const enableHmr = ['1', 'true', 'yes'].includes(String(env.VITE_ENABLE_HMR || '').trim().toLowerCase())

  return {
  // WPS Taskpane kernel is often behind modern Chromium; avoid ES2020+ syntax
  // (e.g. optional chaining / nullish coalescing) to prevent "Unexpected token" crashes.
  esbuild: {
    target: 'es2015'
  },
  // Dev stability switch: keep HMR off by default so WPS taskpane won't auto-reload while debugging.
  // Toggle via `ah32-ui-next/.env`: VITE_ENABLE_HMR=true|false (restart dev server to apply).
  plugins: [
    vue(),
    // 复制 WPS 加载项文件到根目录
    copyFile({ src: './manifest.xml', dest: 'manifest.xml' }),
    copyFile({ src: './ribbon.xml', dest: 'ribbon.xml' }),
    copyFile({ src: './index.html', dest: 'index.html' }),
    copyFile({ src: './taskpane.html', dest: 'taskpane.html' }),
    copyFile({ src: './js', dest: 'js' }),
    copyFile({ src: './assets', dest: 'assets' }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@/components': resolve(__dirname, 'src/components'),
      '@/stores': resolve(__dirname, 'src/stores'),
      '@/services': resolve(__dirname, 'src/services'),
      '@/utils': resolve(__dirname, 'src/utils'),
      '@/styles': resolve(__dirname, 'src/styles')
    }
  },
  server: {
    hmr: enableHmr,
    port: 3889,
    host: '0.0.0.0',
    cors: true,
    strictPort: true
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'es2015'
    }
  },
  build: {
    target: 'es2015',
    outDir: 'wps-plugin',
    sourcemap: true,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/main.ts')
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
        // 禁用代码分割，生成单一 bundle（WPS Taskpane 常见环境下动态 chunk 加载不稳定）
        manualChunks: undefined,
        inlineDynamicImports: true,
        format: 'iife'
      }
    }
  }
  }
})
