import { lazy, memo, type ReactNode, Suspense } from 'react';
import { ContentErrorBoundary } from './ContentErrorBoundary';

const Content = lazy(() =>
  import('./QqMarkdownContent').then((module) => ({ default: module.QqMarkdown })),
);

/** 普通聊天启动不下载 Markdown 与高亮引擎；首次遇到对应内容时再加载。 */
export interface QqMarkdownProps {
  text: string;
  bot?: boolean;
  plainText?: string;
  renderLink?: (href: string, children: ReactNode) => ReactNode;
}

export const QqMarkdown = memo(function QqMarkdown(props: QqMarkdownProps) {
  const plain = (
    <div className="qq-md weq-asst-md whitespace-pre-wrap">{props.plainText ?? props.text}</div>
  );
  return (
    <ContentErrorBoundary fallback={plain} resetKey={props.text}>
      <Suspense fallback={plain}>
        <Content {...props} />
      </Suspense>
    </ContentErrorBoundary>
  );
});
