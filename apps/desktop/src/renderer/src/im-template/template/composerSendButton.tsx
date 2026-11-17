import { useEffect, useReducer } from 'react';
import { MessageSquareOff, SendHorizontal } from 'lucide-react';
import { cn } from './classNames';
import '../../styles/composer-send-status.css';
import { muteCountdownText } from './composerSendButton.shared';

export type ComposerSpeechRestriction = { kind: 'personal'; until: number } | { kind: 'all' };

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
