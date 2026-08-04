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

import { memo, type JSX, type ReactElement } from 'react';
import { Streamdown } from 'streamdown';
import remarkGfm from 'remark-gfm';
import { shikiCodeHighlighter } from '../views/agentlab/shikiHighlighter';
import { openLink } from '../lib/linkify';
import { imageSizeHint, normalizeBotMarkdown } from './qqBotMarkdown';

const REMARK_PLUGINS = [remarkGfm];
const PLUGINS = { code: shikiCodeHighlighter };

/**
 * 尊重 QQ 写在 alt 里的渲染尺寸（`![img#18px #18px](…)`）。不这么做的话 @ 提及
 * 前面那个 18px 的小头像会按原图铺满整行 —— 机器人卡片里最扎眼的一处错位。
 *
 * 高度必须走 aspect-ratio 而不是内联 height：气泡宽度不够时 max-width 会把宽度收窄，
 * 而内联 height 的优先级压过样式表里的 height:auto，图就被压扁了。
 */
function MarkdownImage({ src, alt, ...rest }: JSX.IntrinsicElements['img']): ReactElement | null {
  if (!src) return null;
  const hint = imageSizeHint(alt);
  return (
    <img
      {...rest}
      src={src}
      alt={alt ?? ''}
      width={hint?.width}
      height={hint?.height}
      style={
        hint
          ? {
              width: hint.width,
              maxWidth: '100%',
              height: 'auto',
              aspectRatio: hint.height ? `${hint.width} / ${hint.height}` : undefined,
            }
          : undefined
      }
    />
  );
}

/**
 * markdown 里的链接。复用纯文本链接那条边界（lib/linkify 的 openLink：只放行
 * http(s)、可执行后缀先确认、交系统浏览器），并套上 `qq-link` 的配色 —— streamdown
 * 默认渲染成一个只带 Tailwind 类的 <button>，而本项目的 @source 不扫 node_modules，
 * 那些类编译不出来，链接会看起来跟纯文本一模一样。
 */
function MarkdownLink({ children, href }: JSX.IntrinsicElements['a']): ReactElement {
  return (
    <button
      type="button"
      className="qq-link"
      title={href}
      onClick={(e) => {
        e.stopPropagation();
        if (href) openLink(href);
      }}
    >
      {children}
    </button>
  );
}

const COMPONENTS = { img: MarkdownImage, a: MarkdownLink };

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

/**
 * @param bot 机器人卡片正文。会先把 QQ 私有方言（版本标记 / mqqapi 提及链接）翻成
 *   标准 markdown，否则 streamdown 的 rehype-harden 会把它们渲染成「[blocked]」。
 */
export const QqMarkdown = memo(function QqMarkdown({
  text,
  bot = false,
}: {
  text: string;
  bot?: boolean;
}): ReactElement {
  const body = bot ? normalizeBotMarkdown(text) : text;
  return (
    <div className={bot ? 'qq-md weq-asst-md qq-md-bot' : 'qq-md weq-asst-md'}>
      <Streamdown
        remarkPlugins={REMARK_PLUGINS}
        plugins={PLUGINS}
        components={COMPONENTS}
        parseIncompleteMarkdown={false}
      >
        {body}
      </Streamdown>
    </div>
  );
});
