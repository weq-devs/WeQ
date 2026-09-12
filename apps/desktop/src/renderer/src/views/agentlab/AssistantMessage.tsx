/**
 * 助手最终答复的 Markdown 渲染。
 *
 * M3 起换用 streamdown（Vercel AI SDK 生态，专为 LLM 流式输出设计）替代 react-markdown。
 * 相比逐 token 整段重解析，streamdown 的流式模式会把中途「未闭合的语法」（半截的 **加粗**、
 * ``` 代码块、| 表格、链接）平滑收尾，不再跳变闪烁；GFM 表格/列表也更稳。历史气泡仍由
 * AssistantBubble 的 memo 隔离，不受流式重渲影响。
 *
 * 流式观感由三个 prop 一起给：`mode` 显式区分 streaming（走 remend 收尾半截语法）/ static
 * （定稿做一次完整解析）；`animated` + `isAnimating` 打开逐字淡入（只在流式期间生效，定稿后
 * 插件不再挂载，不给长文档添开销）；`caret` 在末尾给一个跟随闪烁的光标。注意 `animated` 的
 * 默认切分是「词」，中文等无空格文本会被当成一整词而不逐字动画，故显式改成按字符切分。
 *
 * 代码高亮走自建的 shiki 插件（shikiHighlighter.ts）——streamdown 本身不带高亮引擎，需注入；
 * 且必须用 shiki 的纯 JS 引擎，因为本应用 CSP 是 `script-src 'self'`，WASM 引擎会被拦下。
 *
 * 外链统一新窗打开（Electron 里 target=_blank 会走 setWindowOpenHandler 交给系统浏览器）。
 * streamdown 的元素/控件样式全是 Tailwind 工具类，靠 styles/index.css 里的 @source 扫它的
 * node_modules 产物生成；代码块的明/暗配色由 `dark:` 工具类切换（同文件顶部的 @custom-variant
 * 桥接到 data-theme）。本组件只补场景定制（字号/间距/配色），见 `.weq-asst-md` 那一段。
 */

import { memo, type ReactElement } from 'react';
import { Streamdown, type Components, type AnimateOptions } from 'streamdown';
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
/** 逐字淡入：按字符切分（默认的「词」对中文等于不生效），错峰小一点避免看起来在追帧。 */
const ANIMATE: AnimateOptions = { sep: 'char', duration: 150, stagger: 6 };

/**
 * text/streaming 相同则不重渲——流式期间父组件频繁 setTurns，靠这层挡住无关重解析。
 * `streaming` 为 true 时用 streamdown 的流式模式（宽松收尾半截语法 + 逐字动画 + 光标）。
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
        mode={streaming ? 'streaming' : 'static'}
        remarkPlugins={REMARK_PLUGINS}
        components={COMPONENTS}
        plugins={PLUGINS}
        animated={ANIMATE}
        isAnimating={streaming}
        caret={streaming ? 'block' : undefined}
      >
        {text}
      </Streamdown>
    </div>
  );
});
