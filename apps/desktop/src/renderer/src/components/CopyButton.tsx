import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import { copyTextToClipboard } from '../im-template/template/clipboard';
import { useToast } from './Toast';
import '../styles/copy-feedback.css';

/** 字段复制共用就地反馈，不改变原按钮内容或布局。 */
export function CopyButton({
  text,
  children,
  className = '',
  ...props
}: Omit<ComponentPropsWithoutRef<'button'>, 'onClick'> & { text: string }) {
  const [copied, setCopied] = useState(0);
  const pending = useRef(0);
  useEffect(() => {
    setCopied(0);
    return () => {
      pending.current++;
    };
  }, [text]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(0), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      {...props}
      type={props.type ?? 'button'}
      className={`${className} weq-copy-target`}
      onClick={async (event) => {
        const button = event.currentTarget;
        const selection = button.ownerDocument.getSelection();
        if (selection?.toString() && button.contains(selection.anchorNode)) return;
        if (!text.trimEnd()) return;
        const revision = ++pending.current;
        setCopied(0);
        const ok = await copyTextToClipboard(text, button.ownerDocument);
        if (!button.isConnected || revision !== pending.current) return;
        if (ok) {
          setCopied(revision);
          button.focus({ preventScroll: true });
        } else {
          useToast
            .getState()
            .push({ tone: 'error', title: '复制失败', detail: '无法写入剪贴板，请重试。' });
        }
      }}
    >
      {children}
      {copied ? (
        <span key={copied} role="status" className="weq-copy-feedback">
          已复制
        </span>
      ) : null}
    </button>
  );
}
