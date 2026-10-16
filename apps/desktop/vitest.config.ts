import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';

/**
 * 桌面端离线单测（`apps/desktop/test/*.test.ts`）。
 *
 * 渲染进程的投影器（`lib/qzone.ts` 等）直接吃 `DOMParser`，所以默认环境给
 * happy-dom；主进程的纯逻辑单测不依赖 DOM，在 happy-dom 下同样能跑。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    // 渲染层源码用 `@renderer/*` 别名（见 electron.vite.config.ts），组件单测也得认。
    alias: { '@renderer': resolve(__dirname, 'src/renderer/src') },
  },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
  },
});
