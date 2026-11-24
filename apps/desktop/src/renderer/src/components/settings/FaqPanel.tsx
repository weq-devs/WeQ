/**
 * 设置 → 帮助 → 常见问题。
 *
 * 展示 resources/help/faq.md 的渲染结果（本地 Markdown，跟随深浅模式）。
 */

import type { MouseEvent, ReactElement } from 'react';
import { BookOpen, Loader2 } from 'lucide-react';
import { type Components, Streamdown } from 'streamdown';
import remarkGfm from 'remark-gfm';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs.shared';
import { shikiCodeHighlighter } from '../../views/agentlab/shikiHighlighter';
import '../../styles/help-markdown.css';
import { Card, SectionHeader } from './controls';

const REMARK_PLUGINS = [remarkGfm];
const PLUGINS = { code: shikiCodeHighlighter };
const LINK_SAFETY = { enabled: false };

function jumpToSection(event: MouseEvent<HTMLAnchorElement>) {
  // 页内跳转不占用 Web 移动端用于返回设置上一级的浏览历史。
  event.preventDefault();
  const link = event.currentTarget;
  const headings = link.closest('.weq-help-md')?.querySelectorAll<HTMLHeadingElement>('h2[id]');
  const section = Array.from(headings ?? []).find(
    (heading) => `#${encodeURI(heading.id)}` === link.hash,
  );
  section?.focus({ preventScroll: true });
  section?.scrollIntoView({ block: 'start' });
}

const FAQ_COMPONENTS: Components = {
  h2: ({ children }) => (
    <h2
      id={typeof children === 'string' ? children.toLowerCase().replaceAll(' ', '-') : undefined}
      tabIndex={-1}
    >
      {children}
    </h2>
  ),
  a: ({ href, title, children }) =>
    href?.startsWith('#') ? (
      <a href={href} title={title} onClick={jumpToSection}>
        {children}
      </a>
    ) : (
      <a href={href} title={title} target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
};

export function FaqPanel(): ReactElement {
  const active = useTabActive();
  const faq = trpc.help.getFaqMarkdown.useQuery(undefined, {
    enabled: active,
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  return (
    <div className="weq-set weq-help-faq">
      <SectionHeader
        title="常见问题"
        icon={<BookOpen size={15} strokeWidth={1.9} />}
        desc="内容来自本地资源文件，随版本更新。以下条目正在陆续整理中。"
      />
      <Card
        title="帮助文档"
        icon={<BookOpen size={15} strokeWidth={1.8} />}
        action={
          <code data-privacy-title title={faq.data?.path ?? 'resources/help/faq.md'}>
            faq.md
          </code>
        }
      >
        {faq.isLoading ? (
          <div className="weq-help-faq-loading">
            <Loader2 size={14} className="weq-help-log-spin" aria-hidden />
            正在读取…
          </div>
        ) : faq.data?.ok ? (
          <div className="weq-help-md">
            <Streamdown
              components={FAQ_COMPONENTS}
              remarkPlugins={REMARK_PLUGINS}
              plugins={PLUGINS}
              linkSafety={LINK_SAFETY}
              parseIncompleteMarkdown={false}
            >
              {faq.data.text}
            </Streamdown>
          </div>
        ) : (
          <div className="weq-help-faq-loading">常见问题文件缺失或读取失败，请检查资源文件。</div>
        )}
      </Card>
    </div>
  );
}
