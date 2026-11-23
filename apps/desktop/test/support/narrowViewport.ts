import { vi } from 'vitest';

export function stubNarrowViewport() {
  vi.stubGlobal('innerWidth', 390);
  vi.stubGlobal('innerHeight', 844);
  vi.stubGlobal('matchMedia', (query: string) =>
    Object.assign(new EventTarget(), { matches: query === '(max-width: 760px)' }),
  );
}
