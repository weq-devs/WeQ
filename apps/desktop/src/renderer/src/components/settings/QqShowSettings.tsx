/**
 * 「自定义消息显示」里的 QQ 秀两行：开关 + 本地映射有效期。
 *
 * 开关只影响聊天头像的展示（开启时用全身像替换头像，也不再叠挂件）；有效期决定
 * uin → 形象 URL 的本地缓存多久后重新向 QQ 查询，个性主页共用同一份缓存。
 */

import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { DEFAULT_CHAT_QQ_SHOW_DAYS } from '../../lib/chatQqShow';
import { Row, Toggle } from './controls';

const MAX_DAYS = 365;

export function QqShowSettings() {
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const setShow = trpc.bootstrap.setShowChatQqShow.useMutation();
  const setDays = trpc.bootstrap.setQqShowCacheDays.useMutation();
  const utils = trpc.useUtils();
  const current = settings.data?.qqShowCacheDays ?? DEFAULT_CHAT_QQ_SHOW_DAYS;
  const [draft, setDraft] = useState(String(current));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(String(current));
  }, [current]);

  const value = draft.trim() === '' ? Number.NaN : Number(draft);
  const valid = Number.isInteger(value) && value >= 1 && value <= MAX_DAYS;

  async function applyDays() {
    if (!valid || !settings.data || setDays.isLoading) return;
    setError(null);
    try {
      await setDays.mutateAsync({ days: value });
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
        desc="换掉消息头像与头像挂件，改用成员的 QQ 秀全身像（比头像略宽，不挤动消息布局）。只查询当前消息里出现的成员，已有缓存不重复请求；关闭后照常显示头像与挂件。"
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
        desc="本地按账号保存成员与 QQ 秀形象的映射，逾期后才重新向 QQ 查询；个性主页也读这份缓存。"
        control={
          <form
            className="weq-image-cache-setting"
            onSubmit={(event) => {
              event.preventDefault();
              void applyDays();
            }}
          >
            <input
              type="number"
              min={1}
              max={MAX_DAYS}
              step={1}
              value={draft}
              aria-label="QQ 秀缓存有效期（天）"
              aria-invalid={!valid}
              disabled={!settings.data || setDays.isLoading}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
              }}
            />
            <span>天</span>
            <button
              type="submit"
              title="保存 QQ 秀缓存有效期"
              aria-label="保存 QQ 秀缓存有效期"
              disabled={!settings.data || setDays.isLoading || !valid || value === current}
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
