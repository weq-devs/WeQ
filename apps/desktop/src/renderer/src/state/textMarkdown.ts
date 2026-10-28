import { create } from 'zustand';
import { createContext } from 'react';

export const TextMarkdownContext = createContext(true);

/** 廉价检测，避免给普通聊天文本启动 Markdown 渲染管线。 */
export function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)(#{1,6} |[-*+] |\d+\. |> |```)|\*\*|~~|\[[^\]\n]+\]\(/.test(text);
}

export function autoTextMarkdownBody(
  elements: readonly { type?: string; data?: Record<string, unknown> }[],
): string | null {
  if (!elements.length || !elements.every((element) => element.type === 'text')) return null;
  const body = elements.map((element) => String(element.data?.textContent ?? '')).join('');
  return looksLikeMarkdown(body) ? body : null;
}

export function textMarkdownKey(message: { conversationId: string; id: string }): string {
  return JSON.stringify([message.conversationId, message.id]);
}

/** 仅保存本次打开期间的单条选择，不改变全局设置或消息内容。 */
export const useTextMarkdownStore = create<{
  rawKeys: ReadonlySet<string>;
  toggle: (key: string) => void;
}>((set) => ({
  rawKeys: new Set(),
  toggle: (key) =>
    set((state) => {
      const rawKeys = new Set(state.rawKeys);
      if (rawKeys.has(key)) rawKeys.delete(key);
      else rawKeys.add(key);
      return { rawKeys };
    }),
}));
