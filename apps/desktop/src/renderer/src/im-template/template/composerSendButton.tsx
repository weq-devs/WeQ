import { useEffect, useReducer } from 'react';
import { MessageSquareOff, SendHorizontal } from 'lucide-react';
import { cn } from './classNames';
import '../../styles/composer-send-status.css';

export type ComposerSpeechRestriction = { kind: 'personal'; until: number } | { kind: 'all' };

/** 长禁言显示天/时，短禁言精确到秒，保持按钮内的文案紧凑。 */
export function muteCountdownText(until: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.ceil(until - now / 1000));
  const pad = (value: number) => String(value).padStart(2, '0');
  if (seconds >= 86_400)
    return `${Math.floor(seconds / 86_400)}天${Math.floor((seconds % 86_400) / 3600)}时`;
  if (seconds >= 3600)
    return `${Math.floor(seconds / 3600)}时${pad(Math.floor((seconds % 3600) / 60))}分`;
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

export function ComposerSendButton({
  variant,
  disabled,
  title,
  restriction,
  active,
  onSend,
}: {
  variant: 'desktop' | 'expanded';
  disabled: boolean;
  title: string;
  restriction: ComposerSpeechRestriction | null;
  active: boolean;
  onSend: () => void;
}) {
  const [, tick] = useReducer((value: number) => value + 1, 0);
  const until = restriction?.kind === 'personal' ? restriction.until : null;
  useEffect(() => {
    if (!active || until === null || until * 1000 <= Date.now()) return;
    // 倒计时只重绘按钮，不让消息时间线跟着每秒更新。
    const timer = setInterval(() => {
      tick();
      if (until * 1000 <= Date.now()) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [active, until]);

  const muted = restriction !== null;
  const label = muted ? (until === null ? '全员禁言' : `禁言 ${muteCountdownText(until)}`) : '发送';
  const hint = muted ? `${label}，暂时无法发送消息` : title;
  return (
    <button
      type="button"
      className={cn(
        variant === 'desktop' ? 'composer-send composer-desktop-tool' : 'composer-send-expanded',
      )}
      data-muted={muted ? restriction?.kind : undefined}
      title={hint}
      aria-label={hint}
      disabled={disabled || muted}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSend}
    >
      {muted ? (
        <MessageSquareOff size={17} aria-hidden="true" />
      ) : (
        <SendHorizontal size={variant === 'desktop' ? 17 : 28} aria-hidden="true" />
      )}
      {variant === 'desktop' || muted ? <strong>{label}</strong> : null}
    </button>
  );
}
