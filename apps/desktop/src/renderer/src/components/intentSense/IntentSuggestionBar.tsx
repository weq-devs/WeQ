/**
 * 回复建议条 —— composer 上方的一行候选回复 pills。
 *
 * 仅当「意图感知开启 + 回复建议开启 + api 引擎可用」时由 chatPane 渲染。
 * 点击一条把文本填进 composer 草稿（onInsert）。刷新按钮走 refetch()（绕过
 * staleTime；后端侧还有同消息 90s 的请求级缓存，由 getSuggestions 自己把关）。
 */

import { useState, type ReactElement } from 'react';
import { Lightbulb, RefreshCw } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useIntentSenseStatus } from './context';

interface SuggestionWire {
  text: string;
  tone?: string;
}

export function IntentSuggestionBar({
  kind,
  conv,
  onInsert,
}: {
  kind: 'c2c' | 'group';
  conv: string;
  onInsert: (text: string) => void;
}): ReactElement | null {
  const [busy, setBusy] = useState(false);
  const status = useIntentSenseStatus();
  const overridden = status.data?.conversationOverrides?.[`${kind}:${conv}`];
  const active =
    !!status.data?.enabled &&
    overridden !== false &&
    status.data?.engine === 'api' &&
    !!status.data?.apiConfigured &&
    !!status.data?.suggestionsEnabled;
  const suggestions = trpc.account.intentSense.getSuggestions.useQuery(
    { kind, conv },
    {
      enabled: active,
      refetchOnWindowFocus: false,
      staleTime: 90_000,
      retry: false,
    },
  );

  const list = (suggestions.data ?? []) as SuggestionWire[];
  const loading = suggestions.isFetching || busy;
  if (list.length === 0 && !loading) return null;

  return (
    <div className="weq-int-suggest">
      <Lightbulb size={13} style={{ opacity: 0.55, flexShrink: 0 }} aria-hidden />
      {loading && list.length === 0
        ? Array.from({ length: 3 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 固定三条占位骨架，顺序恒定。
            <span key={`skeleton-${i}`} className="weq-int-suggest-pill" style={{ minWidth: 96 }}>
              <span>…</span>
            </span>
          ))
        : list.map((s) => (
            <button
              key={`${s.tone ?? ''}:${s.text}`}
              type="button"
              className="weq-int-suggest-pill"
              title="点击填入输入框"
              onClick={() => onInsert(s.text)}
            >
              {s.tone ? <span className="weq-int-suggest-tone">{s.tone}</span> : null}
              <span>{s.text}</span>
            </button>
          ))}
      <button
        type="button"
        className={`weq-int-suggest-refresh${loading ? ' is-busy' : ''}`}
        title="换一批"
        aria-label="换一批建议"
        onClick={async () => {
          setBusy(true);
          try {
            await suggestions.refetch();
          } finally {
            setBusy(false);
          }
        }}
      >
        <RefreshCw size={13} />
      </button>
    </div>
  );
}
