import { useEffect, useRef, useState } from 'react';
import { usePageState } from '../PageSnapshots';
import { pageValue } from '../../lib/pageSnapshots';
import { Image, Save } from 'lucide-react';
import {
  DEFAULT_CHAT_IMAGE_CACHE_MIB,
  MAX_CHAT_IMAGE_CACHE_MIB,
} from '@weq/service/chat-image-cache';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
import { Card, QueryError, Row } from './controls';
import '../../styles/chat-image-cache-settings.css';

export function ChatImageCacheSettings() {
  const active = useTabActive();
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, { enabled: active });
  const save = trpc.bootstrap.setChatImageCacheMiB.useMutation();
  const utils = trpc.useUtils();
  const current = settings.data?.chatImageCacheMiB ?? DEFAULT_CHAT_IMAGE_CACHE_MIB;
  const [draft, setDraft] = usePageState(
    'image-cache:draft',
    String(current),
    pageValue.string,
    true,
  );
  const [error, setError] = useState<string | null>(null);
  const previous = useRef(String(current));
  useEffect(() => {
    setDraft((value) => (value === previous.current ? String(current) : value));
    previous.current = String(current);
  }, [current, setDraft]);
  const value = draft.trim() === '' ? NaN : Number(draft);
  const valid = Number.isInteger(value) && value >= 0 && value <= MAX_CHAT_IMAGE_CACHE_MIB;

  async function apply() {
    if (!valid || !settings.data || save.isLoading) return;
    setError(null);
    try {
      const miB = await save.mutateAsync({ miB: value });
      utils.bootstrap.getSettings.setData(undefined, (previous) =>
        previous ? { ...previous, chatImageCacheMiB: miB } : previous,
      );
      await utils.bootstrap.getSettings.invalidate();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <Card title="图片与表情" icon={<Image size={16} />}>
      <Row
        settingId="chat-image-cache"
        label="图片预览内存预算"
        desc="按解码后像素估算，优先保留最近查看的图片与表情，超额时淘汰离屏项。0 表示不保留离屏预览。可见图片和动画额外帧可能使实际内存高于预算。"
        control={
          <form
            className="weq-image-cache-setting"
            onSubmit={(event) => {
              event.preventDefault();
              void apply();
            }}
          >
            <input
              type="number"
              min={0}
              max={MAX_CHAT_IMAGE_CACHE_MIB}
              step={1}
              value={draft}
              aria-label="图片预览内存预算"
              aria-invalid={!valid}
              disabled={!settings.data || save.isLoading}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
              }}
            />
            <span>MiB</span>
            <button
              type="submit"
              title="保存图片预览内存预算"
              aria-label="保存图片预览内存预算"
              disabled={!settings.data || save.isLoading || !valid || value === current}
            >
              <Save size={16} aria-hidden />
            </button>
          </form>
        }
      />
      {error ? <p role="alert">{error}</p> : null}
      {settings.isError ? (
        <QueryError
          message="无法读取图片预览设置"
          retryLabel="重试读取图片预览设置"
          onRetry={() => void settings.refetch()}
        />
      ) : null}
    </Card>
  );
}
