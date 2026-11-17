import type { ReactElement } from 'react';
import { FileQuestion } from 'lucide-react';
import type { ReportPageManifest } from '@weq/service';
import { PageFrame } from './pageFrame';

export function UnknownPage({
  page,
  active,
}: {
  page: ReportPageManifest;
  active: boolean;
}): ReactElement {
  return (
    <PageFrame page={page} active={active}>
      <div className="weq-report-unknown">
        <FileQuestion size={40} aria-hidden />
        <p>当前版本暂不支持这个页面。</p>
        <code>{page.id}</code>
      </div>
    </PageFrame>
  );
}
