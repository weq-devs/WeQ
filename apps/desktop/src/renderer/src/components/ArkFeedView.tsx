import { useMemo } from 'react';
import type { Message } from '../im-template/template';

interface ArkFeedViewProps {
  conversationId: string;
  title: string;
  onBack: () => void;
}

export function ArkFeedView({ conversationId, title, onBack }: ArkFeedViewProps) {
  // TODO: 从后端查询该 conversationId 的消息列表
  const messages: Message[] = [];
  const arkMessages = useMemo(() => {
    return messages.filter((msg) => msg.body && msg.body.startsWith('<?xml'));
  }, [messages]);

  return (
    <div className="flex flex-col items-center gap-4 px-4 py-6">
      {arkMessages.map((msg) => {
        const prompt = extractPromptFromArk(msg.body);
        return (
          <div
            key={msg.id}
            className="w-full max-w-2xl rounded-xl bg-slate-800/50 border border-slate-700/50 p-4 shadow-lg"
          >
            <div className="text-sm text-slate-300">{prompt}</div>
            <div className="mt-2 text-xs text-slate-500">
              {new Date(msg.createdAt).toLocaleString('zh-CN')}
            </div>
          </div>
        );
      })}
      {arkMessages.length === 0 && (
        <div className="text-center text-slate-500 py-12">暂无消息</div>
      )}
    </div>
  );
}

function extractPromptFromArk(body: string | null): string {
  if (!body) return '';
  const match = body.match(/<prompt>(.*?)<\/prompt>/);
  return match?.[1] ?? body.substring(0, 100);
}
