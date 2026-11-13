import { useQuery } from '@tanstack/react-query';

function query(path: 'details' | 'logs') {
  return {
    useQuery: (input: { updatedAt: number }, options: object) =>
      useQuery({
        queryKey: [path, input],
        queryFn: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return path === 'details'
            ? []
            : [
                {
                  ts: 1700000000000,
                  seq: 0,
                  stage: 'friends',
                  level: 'info',
                  text: '好友合成日志：已更新资料',
                },
                ...Array.from({ length: 40 + input.updatedAt }, (_, index) => ({
                  ts: 1700000000000 + index * 1000,
                  seq: index + 1,
                  stage: 'groups',
                  level: index === 3 ? 'error' : index === 5 ? 'warn' : 'info',
                  text: `群成员名单 ${index + 1}：${index === 3 ? '失败：合成错误' : index === 5 ? '等待重试' : '已更新 8 名成员'}`,
                })),
              ];
        },
        retry: false,
        ...options,
      }),
  };
}
export const trpc = { backgroundTasks: { details: query('details'), logs: query('logs') } };
export const client = {};
