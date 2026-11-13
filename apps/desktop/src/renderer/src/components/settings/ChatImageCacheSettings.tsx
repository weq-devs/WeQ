import { useNumericSettingDraft } from './useNumericSettingDraft';
import { Image } from 'lucide-react';
import { AutoSave } from './AutoSave';
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
  const [draft, setDraft] = useNumericSettingDraft(
    'image-cache:draft',
    settings.data?.chatImageCacheMiB,
    current,
  );
  const value = draft.trim() === '' ? NaN : Number(draft);
  const valid = Number.isInteger(value) && value >= 0 && value <= MAX_CHAT_IMAGE_CACHE_MIB;

  async function apply(text: string | number) {
    const miB = await save.mutateAsync({ miB: Number(text) });
    utils.bootstrap.getSettings.setData(undefined, (previous) =>
      previous ? { ...previous, chatImageCacheMiB: miB } : previous,
    );
    await utils.bootstrap.getSettings.invalidate();
  }

  return (
    <Card title="图片与表情" icon={<Image size={16} />}>
      <Row
        settingId="chat-image-cache"
        label="图片预览内存预算"
        desc="按解码后像素估算，优先保留最近查看的图片与表情，超额时淘汰离屏项。0 表示不保留离屏预览。可见图片和动画额外帧可能使实际内存高于预算。"
        control={
          <AutoSave
            value={draft.trim() ? Number(draft) : ''}
            saved={current}
            ready={!!settings.data}
            valid={valid}
            save={apply}
            reset={() => setDraft(String(current))}
          >
            <div className="weq-image-cache-setting">
              <input
                type="number"
                min={0}
                max={MAX_CHAT_IMAGE_CACHE_MIB}
                step={1}
                value={draft}
                aria-label="图片预览内存预算"
                aria-invalid={!valid}
                disabled={!settings.data}
                onChange={(event) => {
                  setDraft(event.target.value);
                }}
              />
              <span>MiB</span>
            </div>
          </AutoSave>
        }
      />
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
