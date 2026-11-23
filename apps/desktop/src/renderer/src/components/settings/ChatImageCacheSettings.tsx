import { useNumericSettingDraft } from './useNumericSettingDraft';
import { Image } from 'lucide-react';
import { AutoSave } from './AutoSave';
import {
  DEFAULT_CHAT_IMAGE_CACHE_MIB,
  MAX_CHAT_IMAGE_CACHE_MIB,
} from '@weq/service/chat-image-cache';
import {
  DEFAULT_CHAT_MESSAGE_PREWARM_MIB,
  MAX_CHAT_MESSAGE_PREWARM_MIB,
} from '@weq/service/chat-message-prewarm';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs.shared';
import { Card, QueryError, Row } from './controls';
import '../../styles/chat-image-cache-settings.css';

function MemoryBudgetInput({
  label,
  name,
  draftKey,
  value: stored,
  defaultValue,
  max,
  ready,
  save,
}: {
  label: string;
  name: string;
  draftKey: string;
  value: number | undefined;
  defaultValue: number;
  max: number;
  ready: boolean;
  save: (budget: number) => Promise<void>;
}) {
  const current = stored ?? defaultValue;
  const [draft, setDraft] = useNumericSettingDraft(draftKey, ready ? current : undefined, current);
  const value = draft.trim() === '' ? NaN : Number(draft);
  const valid = Number.isInteger(value) && value >= 0 && value <= max;
  return (
    <AutoSave
      value={draft.trim() ? value : ''}
      saved={current}
      ready={ready}
      valid={valid}
      save={(budget) => save(Number(budget))}
      reset={() => setDraft(String(current))}
      resetKeys={[name]}
    >
      <div className="weq-image-cache-setting">
        <input
          type="number"
          min={0}
          max={max}
          step={1}
          value={draft}
          aria-label={label}
          aria-invalid={!valid}
          disabled={!ready}
          onChange={(event) => setDraft(event.target.value)}
        />
        <span>MiB</span>
      </div>
    </AutoSave>
  );
}

export function ChatImageCacheSettings({ embedded = false }: { embedded?: boolean }) {
  const active = useTabActive();
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, { enabled: active });
  const save = trpc.bootstrap.setChatImageCacheMiB.useMutation();
  const utils = trpc.useUtils();
  async function apply(budget: number) {
    const miB = await save.mutateAsync({ miB: budget });
    utils.bootstrap.getSettings.setData(undefined, (previous) =>
      previous ? { ...previous, chatImageCacheMiB: miB } : previous,
    );
    await utils.bootstrap.getSettings.invalidate();
  }

  const rows = (
    <>
      <Row
        settingId="chat-image-cache"
        desc="按解码后像素估算，优先保留最近查看的图片与表情，超额时淘汰离屏项。0 表示不保留离屏预览。可见图片和动画额外帧可能使实际内存高于预算。"
        control={
          <MemoryBudgetInput
            label="图片预览内存预算"
            name="chatImageCacheMiB"
            draftKey="image-cache:draft"
            value={settings.data?.chatImageCacheMiB}
            defaultValue={DEFAULT_CHAT_IMAGE_CACHE_MIB}
            max={MAX_CHAT_IMAGE_CACHE_MIB}
            ready={!!settings.data}
            save={apply}
          />
        }
      />
      {settings.isError ? (
        <QueryError
          message="无法读取图片预览设置"
          retryLabel="重试读取图片预览设置"
          onRetry={() => void settings.refetch()}
        />
      ) : null}
    </>
  );
  return embedded ? (
    rows
  ) : (
    <Card title="图片与表情" icon={<Image size={16} />}>
      {rows}
    </Card>
  );
}

export function ChatMessagePrewarmSettings() {
  const active = useTabActive();
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, { enabled: active });
  const save = trpc.bootstrap.setChatMessagePrewarmMiB.useMutation();
  const utils = trpc.useUtils();

  async function apply(budget: number) {
    const miB = await save.mutateAsync({ miB: budget });
    utils.bootstrap.getSettings.setData(undefined, (previous) =>
      previous ? { ...previous, chatMessagePrewarmMiB: miB } : previous,
    );
    await utils.bootstrap.getSettings.invalidate();
  }

  return (
    <Row
      settingId="chat-message-prewarm"
      desc="用于桌面长聊天空闲时提前准备完整消息。按消息行和媒体像素估算。设为 0 关闭预热。"
      control={
        <MemoryBudgetInput
          label="完整消息预热内存预算"
          name="chatMessagePrewarmMiB"
          draftKey="message-prewarm:draft"
          value={settings.data?.chatMessagePrewarmMiB}
          defaultValue={DEFAULT_CHAT_MESSAGE_PREWARM_MIB}
          max={MAX_CHAT_MESSAGE_PREWARM_MIB}
          ready={!!settings.data}
          save={apply}
        />
      }
    />
  );
}
