/**
 * 助手最终答复的 Markdown 渲染。
 *
 * M3 起换用 streamdown（Vercel AI SDK 生态，专为 LLM 流式输出设计）替代 react-markdown。
 * 相比逐 token 整段重解析，streamdown 的 `parseIncompleteMarkdown` 会把流式中途「未闭合的
 * 语法」（半截的 **加粗**、``` 代码块、| 表格、链接）平滑收尾，不再跳变闪烁；GFM 表格/列表
 * 也更稳。历史气泡仍由 AssistantBubble 的 memo 隔离，不受流式重渲影响。
 *
 * 代码高亮走自建的 shiki 插件（shikiHighlighter.ts）——streamdown 本身不带高亮引擎，需注入；
 * 且必须用 shiki 的纯 JS 引擎，因为本应用 CSP 是 `script-src 'self'`，WASM 引擎会被拦下。
 *
 * 外链统一新窗打开（Electron 里 target=_blank 会走 setWindowOpenHandler 交给系统浏览器）。
 * streamdown 自带元素样式（streamdown/styles.css，在 styles/index.css 里 import），代码块的
 * 明/暗配色由 `dark:` 工具类切换（styles/index.css 顶部的 @custom-variant 桥接到 data-theme）。
 */

import { memo, type ReactElement } from 'react';
import { Streamdown, type Components } from 'streamdown';
import remarkGfm from 'remark-gfm';
import { shikiCodeHighlighter } from './shikiHighlighter';

const COMPONENTS: Components = {
  // 外链新窗打开（与原手写渲染器一致；{...props} 保留 streamdown 的链接 hardening 属性）。
  a: ({ children, ...props }) => (
    <a {...props} className="weq-asst-md-link" target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

const REMARK_PLUGINS = [remarkGfm];
const PLUGINS = { code: shikiCodeHighlighter };

/**
 * text/streaming 相同则不重渲——流式期间父组件频繁 setTurns，靠这层挡住无关重解析。
 * `streaming` 为 true 时开启 parseIncompleteMarkdown（流式宽松），定稿时关闭做完整重解析。
 */
export const AssistantMessage = memo(function AssistantMessage({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}): ReactElement {
  return (
    <div className="weq-asst-md">
      <Streamdown
        remarkPlugins={REMARK_PLUGINS}
        components={COMPONENTS}
        plugins={PLUGINS}
        parseIncompleteMarkdown={streaming}
      >
        {text}
      </Streamdown>
    </div>
  );
});
