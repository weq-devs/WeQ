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
      <Lightbulb size={12} className="weq-int-suggest-icon" aria-hidden />
      <div
        className="weq-int-suggest-track"
        onWheel={(e) => {
          if (e.deltaY === 0) return;
          const target = (e.target as HTMLElement | null)?.closest(
            '.weq-int-suggest-text',
          ) as HTMLElement | null;
          if (target && target.scrollWidth > target.clientWidth) {
            const canScrollRight =
              e.deltaY > 0 && target.scrollLeft + target.clientWidth < target.scrollWidth - 1;
            const canScrollLeft = e.deltaY < 0 && target.scrollLeft > 0;
            if (canScrollRight || canScrollLeft) {
              target.scrollLeft += e.deltaY;
              e.preventDefault();
              return;
            }
          }
          const track = e.currentTarget;
          if (track.scrollWidth > track.clientWidth) {
            track.scrollLeft += e.deltaY;
            e.preventDefault();
          }
        }}
      >
        {loading && list.length === 0
          ? Array.from({ length: 3 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 固定三条占位骨架，顺序恒定。
              <span
                key={`skeleton-${i}`}
                className="weq-int-suggest-pill is-skeleton"
                style={{ minWidth: 88 }}
              >
                <span>…</span>
              </span>
            ))
          : list.map((s) => (
              <button
                key={`${s.tone ?? ''}:${s.text}`}
                type="button"
                className="weq-int-suggest-pill"
                title={`${s.tone ? `[${s.tone}] ` : ''}${s.text}\n点击填入输入框`}
                onClick={() => onInsert(s.text)}
                onMouseEnter={(e) => {
                  const textEl = e.currentTarget.querySelector(
                    '.weq-int-suggest-text',
                  ) as HTMLElement | null;
                  if (!textEl) return;
                  const overflow = textEl.scrollWidth - textEl.clientWidth;
                  if (overflow > 2) {
                    textEl.scrollTo({ left: overflow, behavior: 'smooth' });
                  }
                }}
                onMouseLeave={(e) => {
                  const textEl = e.currentTarget.querySelector(
                    '.weq-int-suggest-text',
                  ) as HTMLElement | null;
                  if (!textEl || textEl.scrollLeft === 0) return;
                  textEl.scrollTo({ left: 0, behavior: 'smooth' });
                }}
              >
                {s.tone ? <span className="weq-int-suggest-tone">{s.tone}</span> : null}
                <span className="weq-int-suggest-text">{s.text}</span>
              </button>
            ))}
      </div>
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
        <RefreshCw size={12} />
      </button>
    </div>
  );
}
