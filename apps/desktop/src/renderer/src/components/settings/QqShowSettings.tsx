/**
 * 「自定义消息显示」里的 QQ 秀两行：开关 + 本地映射有效期。
 *
 * 开关只影响聊天头像的展示（开启时用全身像替换头像，也不再叠挂件）；有效期决定
 * uin → 形象 URL 的本地缓存多久后重新向 QQ 查询，个性主页共用同一份缓存。
 */

import { useState } from 'react';
import { useNumericSettingDraft } from './useNumericSettingDraft';
import { AutoSave } from './AutoSave';
import { trpc } from '../../trpc/client';
import { DEFAULT_CHAT_QQ_SHOW_MINUTES } from '../../lib/chatQqShow';
import { Row } from './controls';
import { SharedDisplayToggle } from './SharedDisplayToggle';

const MAX_MINUTES = 365 * 1440;

export function QqShowSettings() {
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const setMinutes = trpc.bootstrap.setQqShowCacheMinutes.useMutation();
  const utils = trpc.useUtils();
  const current = settings.data?.qqShowCacheMinutes ?? DEFAULT_CHAT_QQ_SHOW_MINUTES;
  const [draft, setDraft] = useNumericSettingDraft(
    'qqshow:minutes',
    settings.data?.qqShowCacheMinutes,
    current,
  );
  const [error, setError] = useState<string | null>(null);

  const value = draft.trim() === '' ? Number.NaN : Number(draft);
  const valid = Number.isInteger(value) && value >= 1 && value <= MAX_MINUTES;

  async function applyMinutes(text: string | number) {
    setError(null);
    try {
      await setMinutes.mutateAsync({ minutes: Number(text) });
      await utils.bootstrap.getSettings.invalidate();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
  }

  return (
    <>
      <Row
        settingId="chat-qqshow"
        label="聊天 QQ 秀替换头像"
        desc="用成员的 QQ 秀全身像替换头像与挂件。"
        control={
          <SharedDisplayToggle
            name="showChatQqShow"
            fallback={settings.data?.showChatQqShow ?? true}
            disabled={!settings.data}
            label="聊天 QQ 秀替换头像"
          />
        }
      />
      <Row
        settingId="chat-qqshow-days"
        label="QQ 秀缓存有效期"
        desc="默认 5 分钟，聊天与个性主页共用。"
        control={
          <AutoSave
            resetKeys={['qqShowCacheMinutes']}
            value={draft.trim() ? Number(draft) : ''}
            saved={current}
            ready={!!settings.data}
            valid={valid}
            save={applyMinutes}
            reset={() => setDraft(String(current))}
          >
            <div className="weq-image-cache-setting">
              <input
                type="number"
                min={1}
                max={MAX_MINUTES}
                step={1}
                value={draft}
                aria-label="QQ 秀缓存有效期（分钟）"
                aria-invalid={!valid}
                disabled={!settings.data}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setError(null);
                }}
              />
              <span>分钟</span>
            </div>
          </AutoSave>
        }
      />
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
