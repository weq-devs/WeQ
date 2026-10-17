import { defineConfig } from 'vitest/config';

/**
 * `@weq/native` 的离线单测。
 *
 * 这里只测**不碰二进制**的纯逻辑（如有效期折算 `validity.mjs`）—— 真正 require
 * `.node` 的路径要宿主平台装了原生产物才能跑，不在单测范围内。
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
