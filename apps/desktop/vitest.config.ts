import { defineConfig } from 'vitest/config';

/**
 * 桌面端离线单测（`apps/desktop/test/*.test.ts`）。
 *
 * 渲染进程的投影器（`lib/qzone.ts` 等）直接吃 `DOMParser`，所以默认环境给
 * happy-dom；主进程的纯逻辑单测不依赖 DOM，在 happy-dom 下同样能跑。
 */
export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
  },
});
