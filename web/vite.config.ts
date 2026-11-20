import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import qiankun from 'vite-plugin-qiankun';

export default defineConfig({
  plugins: [
    vue(),
    qiankun('pivideo-web', { useDevMode: true }),
  ],
  base: '/video/',
  server: {
    port: 5173,
    // 允许经 nginx 代理的域名访问（Vite host 检查，否则 403）
    allowedHosts: ['ainovel.cloud'],
    // HMR 经 nginx 反代时走 443 同源 websocket
    hmr: {
      protocol: 'wss' as const,
      host: 'ainovel.cloud',
      clientPort: 443,
    },
    proxy: {
      '/video/api': {
        target: 'http://localhost:3100',
        rewrite: (p) => p.replace(/^\/video/, ''),
      },
      '/video/files': {
        target: 'http://localhost:3100',
        rewrite: (p) => p.replace(/^\/video/, ''),
      },
    },
  },
});
