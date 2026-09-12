import { defineConfig } from 'vitest/config';

export default defineConfig({
  // vite 5's builtin list predates `node:sqlite` — force it to the Node loader.
  ssr: { external: ['node:sqlite'] },
});
