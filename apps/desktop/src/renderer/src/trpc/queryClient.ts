import { QueryClient } from '@tanstack/react-query';

export function createQueryClient(isWeb: boolean): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // 桌面请求走本机 IPC；系统断网不能暂停本地读取、保存和重试。
      queries: {
        networkMode: isWeb ? 'online' : 'always',
        staleTime: 5 * 60_000,
        cacheTime: 30 * 60_000,
        // Native 探测可能短暂阻塞主进程，窗口重新聚焦时不重复执行。
        refetchOnMount: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
      },
      mutations: { networkMode: isWeb ? 'online' : 'always' },
    },
  });
}
