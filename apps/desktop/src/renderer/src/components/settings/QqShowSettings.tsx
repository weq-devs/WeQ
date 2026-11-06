/**
 * 「自定义消息显示」里的 QQ 秀两行：开关 + 本地映射有效期。
 *
 * 开关只影响聊天头像的展示（开启时用全身像替换头像，也不再叠挂件）；有效期决定
 * uin → 形象 URL 的本地缓存多久后重新向 QQ 查询，个性主页共用同一份缓存。
 */

import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { DEFAULT_CHAT_QQ_SHOW_MINUTES } from '../../lib/chatQqShow';
import { Row, Toggle } from './controls';

const MAX_MINUTES = 365 * 1440;

export function QqShowSettings() {
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const setShow = trpc.bootstrap.setShowChatQqShow.useMutation();
  const setMinutes = trpc.bootstrap.setQqShowCacheMinutes.useMutation();
  const utils = trpc.useUtils();
  const current = settings.data?.qqShowCacheMinutes ?? DEFAULT_CHAT_QQ_SHOW_MINUTES;
  const [draft, setDraft] = useState(String(current));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(String(current));
  }, [current]);

  const value = draft.trim() === '' ? Number.NaN : Number(draft);
  const valid = Number.isInteger(value) && value >= 1 && value <= MAX_MINUTES;

  async function applyMinutes() {
    if (!valid || !settings.data || setMinutes.isLoading) return;
    setError(null);
    try {
      await setMinutes.mutateAsync({ minutes: value });
      await utils.bootstrap.getSettings.invalidate();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <>
      <Row
        settingId="chat-qqshow"
        label="聊天 QQ 秀替换头像"
        desc="用成员的 QQ 秀全身像替换头像与挂件。"
        control={
          <Toggle
            checked={settings.data?.showChatQqShow ?? true}
            disabled={!settings.data || setShow.isLoading}
            onChange={(enabled) => {
              setError(null);
              setShow.mutate(
                { enabled },
                {
                  onSuccess: () => void utils.bootstrap.getSettings.invalidate(),
                  onError: (reason) => setError(reason.message),
                },
              );
            }}
            label="聊天 QQ 秀替换头像"
          />
        }
      />
      <Row
        settingId="chat-qqshow-days"
        label="QQ 秀缓存有效期"
        desc="默认 5 分钟，聊天与个性主页共用。"
        control={
          <form
            className="weq-image-cache-setting"
            onSubmit={(event) => {
              event.preventDefault();
              void applyMinutes();
            }}
          >
            <input
              type="number"
              min={1}
              max={MAX_MINUTES}
              step={1}
              value={draft}
              aria-label="QQ 秀缓存有效期（分钟）"
              aria-invalid={!valid}
              disabled={!settings.data || setMinutes.isLoading}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
              }}
            />
            <span>分钟</span>
            <button
              type="submit"
              title="保存 QQ 秀缓存有效期"
              aria-label="保存 QQ 秀缓存有效期"
              disabled={!settings.data || setMinutes.isLoading || !valid || value === current}
            >
              <Save size={16} aria-hidden />
            </button>
          </form>
        }
      />
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
