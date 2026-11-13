import { lazy, memo, Suspense } from 'react';

export { looksLikeMarkdown } from '../state/textMarkdown';

const Content = lazy(() =>
  import('./QqMarkdownContent').then((module) => ({ default: module.QqMarkdown })),
);

/** 普通聊天启动不下载 Markdown 与高亮引擎；首次遇到对应内容时再加载。 */
export const QqMarkdown = memo(function QqMarkdown(props: { text: string; bot?: boolean }) {
  return (
    <Suspense fallback={<div className="qq-md weq-asst-md whitespace-pre-wrap">{props.text}</div>}>
      <Content {...props} />
    </Suspense>
  );
});
