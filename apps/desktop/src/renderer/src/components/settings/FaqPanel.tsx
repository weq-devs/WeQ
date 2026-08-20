/**
 * 设置 → 帮助 → 常见问题。
 *
 * 展示 resources/help/faq.md 的渲染结果（本地 Markdown，跟随深浅模式）。
 */

import type { ReactElement } from 'react';
import { BookOpen, FileText, Loader2 } from 'lucide-react';
import { Streamdown } from 'streamdown';
import remarkGfm from 'remark-gfm';
import { trpc } from '../../trpc/client';
import { shikiCodeHighlighter } from '../../views/agentlab/shikiHighlighter';

const REMARK_PLUGINS = [remarkGfm];
const PLUGINS = { code: shikiCodeHighlighter };

export function FaqPanel(): ReactElement {
  const faq = trpc.help.getFaqMarkdown.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  return (
    <div className="weq-help-faq">
      <header className="weq-help-faq-head">
        <span className="weq-help-faq-icon">
          <BookOpen size={15} strokeWidth={1.9} aria-hidden />
        </span>
        <div>
          <strong>常见问题</strong>
          <p>内容来自本地资源文件，随版本更新。以下条目正在陆续整理中。</p>
        </div>
        <span className="weq-help-faq-file" title={faq.data?.path ?? 'resources/help/faq.md'}>
          <FileText size={12} aria-hidden />
          faq.md
        </span>
      </header>

      {faq.isLoading ? (
        <div className="weq-help-faq-loading">
          <Loader2 size={14} className="weq-help-log-spin" aria-hidden />
          正在读取…
        </div>
      ) : faq.data?.ok ? (
        <div className="weq-help-md weq-help-faq-body">
          <Streamdown
            remarkPlugins={REMARK_PLUGINS}
            plugins={PLUGINS}
            parseIncompleteMarkdown={false}
          >
            {faq.data.text}
          </Streamdown>
        </div>
      ) : (
        <div className="weq-help-faq-loading">常见问题文件缺失或读取失败，请检查资源文件。</div>
      )}
    </div>
  );
}
