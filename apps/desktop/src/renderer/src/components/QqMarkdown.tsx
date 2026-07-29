/**
 * 聊天消息里的 Markdown 渲染（QQ 原生 markdownElement，以及开关打开时的纯文本消息）。
 *
 * 用 streamdown 而非手写解析器：原先 im-template 自带的 parseMarkdownBlocks 是手写状态机，
 * 围栏检测正则与段落兜底守卫不一致，遇到 ```(╬◣д◢)``` 这类「以 ``` 开头但不是合法围栏」
 * 的行时 index 不前进 → 无界 push → 渲染进程 10 秒内堆爆。已整体删除。
 *
 * 代码高亮复用 agentlab 的 shiki 插件（shikiHighlighter.ts，模块级惰性单例，跨组件共享
 * 一个 highlighter）。必须用 shiki 的纯 JS 引擎——本应用 CSP 是 `script-src 'self'`，
 * WASM 引擎会被拦下。
 *
 * parseIncompleteMarkdown 关掉：聊天记录都是定稿文本，不是 LLM 流式输出，不需要为
 * 「半截语法」做平滑收尾。
 */

import { memo, type ReactElement } from 'react';
import { Streamdown } from 'streamdown';
import remarkGfm from 'remark-gfm';
import { shikiCodeHighlighter } from '../views/agentlab/shikiHighlighter';

const REMARK_PLUGINS = [remarkGfm];
const PLUGINS = { code: shikiCodeHighlighter };

/**
 * 廉价的 markdown 嫌疑检测：只在命中时才把这条消息交给 streamdown。
 *
 * 存在的理由是性能——几百条气泡各挂一个 remark+shiki 管线会明显卡顿，绝大多数聊天
 * 消息其实是纯文本。刻意写成单条无循环、无回溯的正则（手写状态机的死循环教训就在
 * 这个功能上）。
 */
export function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)(#{1,6} |[-*+] |\d+\. |> |```)|\*\*|~~|\[[^\]\n]+\]\(/.test(text);
}

export const QqMarkdown = memo(function QqMarkdown({ text }: { text: string }): ReactElement {
  return (
    <div className="qq-md weq-asst-md">
      <Streamdown remarkPlugins={REMARK_PLUGINS} plugins={PLUGINS} parseIncompleteMarkdown={false}>
        {text}
      </Streamdown>
    </div>
  );
});
