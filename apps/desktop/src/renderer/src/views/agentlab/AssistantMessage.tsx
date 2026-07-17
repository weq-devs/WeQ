/**
 * 助手最终答复的 Markdown 渲染。
 *
 * M2 起换用 react-markdown + remark-gfm（表格 / 任务列表 / 删除线 / 自动链接）
 * + rehype-highlight（代码块语法高亮）替代原先的手写正则渲染器——覆盖更全、更稳，
 * 且天然吃「流式逐字增长的字符串」（每次 text 变化整体重解析，答复通常不长，可接受；
 * 历史气泡由 AssistantBubble 的 memo 隔离，不受流式重渲影响）。
 *
 * 外链统一新窗打开（Electron 里 target=_blank 会走 setWindowOpenHandler 交给系统浏览器）。
 * 语法高亮主题在 styles/index.css 里随 .weq-asst-md 注入（highlight.js 的 hljs-* class）。
 */

import { memo, type ReactElement } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

const COMPONENTS: Components = {
  // 外链新窗打开（与原手写渲染器一致）。
  a: ({ children, ...props }) => (
    <a {...props} className="weq-asst-md-link" target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];

/** text 相同则不重渲——流式期间父组件频繁 setTurns，靠这层挡住无关重解析。 */
export const AssistantMessage = memo(function AssistantMessage({ text }: { text: string }): ReactElement {
  return (
    <div className="weq-asst-md">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
