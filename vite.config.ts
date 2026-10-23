import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// 🔥 端口配置：开发环境用 3002，生产环境用 3001
const LOCAL_BACKEND_PORT = process.env.NODE_ENV === 'development' ? 3002 : 3001;

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  // 🔥 Electron 环境配置
  base: mode === 'development' ? '/' : './',
  server: {
    host: "::",
    port: 8080,
    // 🔥 端口被占直接报错退出（fail fast），不静默顺延——Electron 开发模式写死加载
    //    http://localhost:8080（electron/main.ts），顺延到 8081 会导致白屏
    strictPort: true,
    // 🔥 COEP 策略：改为 'credentialless' 而非 'require-corp'
    // 原因：require-corp 会阻止加载无 CORP 头的跨域资源（如 OSS 图片、视频、Excel）
    // credentialless 既保持 SharedArrayBuffer 支持，又允许加载 OSS 等跨域资源
    headers: {
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
    // 🔥 本地开发代理：将 /api/ecs-worker 转发到本地后端
    proxy: {
      '/api/ecs-worker': {
        target: `http://localhost:${LOCAL_BACKEND_PORT}`,
        changeOrigin: true,
        secure: false,
        ws: true, // 🔥 必须开启 WebSocket 代理支持
        rewrite: (path) => path.replace(/^\/api\/ecs-worker/, '')
      },
      // 🔥 表上传代理路由转发
      '/api/table': {
        target: `http://localhost:${LOCAL_BACKEND_PORT}`,
        changeOrigin: true,
        secure: false
      },
      // 🔥 Slidev 代理路由转发
      '/slidev': {
        target: `http://localhost:${LOCAL_BACKEND_PORT}`,
        changeOrigin: true,
        secure: false
      }
    }
  },
  plugins: [
    react(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    target: ['es2015', 'chrome61', 'firefox60', 'safari11'],
    // 🔥 确保 dist 文件夹被创建
    outDir: 'dist',
    // 🔥 Electron 环境：不使用相对路径，使用绝对路径
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // 🔥 性能优化：代码分块
        manualChunks: {
          vendor: ['react', 'react-dom'],
          router: ['react-router-dom'],
          ui: ['@radix-ui/react-dialog', '@radix-ui/react-toast'],
          query: ['@tanstack/react-query'],
        },
      },
    },
    // 🔥 性能优化：启用资源预加载
    assetsInlineLimit: 4096,
    cssCodeSplit: true,
  },
  // 🔥 性能优化：优化依赖预构建
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-router-dom',
      '@tanstack/react-query',
    ],
    // 🔥 排除 FFmpeg.wasm，避免预构建问题
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  // 确保正确处理 WASM 文件的 MIME 类型
  assetsInclude: ['**/*.wasm']
}));