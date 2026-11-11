import { createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/** 为实际使用共享查询的组件提供独立、可随用例释放的缓存。 */
export function createQueryRoot(host: Element) {
  const root = createRoot(host);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    render: (node: ReactNode) =>
      root.render(createElement(QueryClientProvider, { client: cache }, node)),
    unmount: () => {
      root.unmount();
      cache.clear();
    },
  };
}
