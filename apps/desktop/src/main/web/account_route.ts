import { AsyncLocalStorage } from 'node:async_hooks';

const requestRoute = new AsyncLocalStorage<string>();

export function withWebAccountRoute<T>(route: string | string[] | undefined, run: () => T): T {
  const valid =
    typeof route === 'string' &&
    /^\/_weq\/account\/[a-z\d][a-z\d_-]{0,127}\/[a-f\d-]{36}$/i.test(route);
  return valid ? requestRoute.run(route, run) : run();
}

export function webAccountRoute(): string {
  return requestRoute.getStore() ?? '';
}
