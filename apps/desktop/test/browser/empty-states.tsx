import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Images, SearchX, Sticker } from 'lucide-react';
import { EmptyState } from '../../src/renderer/src/components/EmptyState';
import { AppSearchResults } from '../../src/renderer/src/components/search/AppSearchResults';
import { FieldHistoryContent } from '../../src/renderer/src/components/contactProfile/FieldHistoryContent';
import { ContributionHeatmap } from '../../src/renderer/src/components/analyticsCharts';
import { ConversationPicker } from '../../src/renderer/src/views/export/ConversationPicker';
import { SingleSelectPicker } from '../../src/renderer/src/views/export/SingleSelectPicker';
import { DatabasePicker } from '../../src/renderer/src/views/export/DatabasePicker';
import { State } from '../../src/renderer/src/views/qzoneShared';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/export.css';
import '../../src/renderer/src/styles/database-plain-export.css';

const noop = () => {};
function Fixture() {
  const [picked, setPicked] = useState(new Set<string>());
  const [restored, setRestored] = useState(false);
  return (
    <main>
      <style>{`
        html,body,#root{margin:0;min-height:100%;background:var(--background);color:var(--weq-fg-primary)}
        main{max-width:1080px;margin:auto;padding:20px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
        section{min-width:0;border-bottom:1px solid var(--weq-border-subtle)}
        h2{margin:0;padding:8px 0;font-size:13px;font-weight:600}
        @media(max-width:600px){main{grid-template-columns:minmax(0,1fr);padding:12px;gap:12px}}
      `}</style>
      <section data-fixture="search">
        <h2>搜索分组</h2>
        <AppSearchResults keyword="合成无结果" entries={[]} onSelect={noop} onExpand={noop} />
      </section>
      <section data-fixture="scope">
        <h2>范围选择</h2>
        <EmptyState
          compact
          icon={<SearchX />}
          title="未选择搜索范围"
          body={
            <button type="button" className="weq-set-btn" onClick={() => setRestored(true)}>
              {restored ? '已恢复' : '恢复全部范围'}
            </button>
          }
        />
      </section>
      <section data-fixture="conversations">
        <h2>会话选择</h2>
        <ConversationPicker items={[]} loading={false} selected={picked} onChange={setPicked} />
      </section>
      <section data-fixture="single">
        <h2>单选列表</h2>
        <SingleSelectPicker
          items={[]}
          loading={false}
          selectedId={null}
          onSelect={noop}
          emptyText="暂无空间目标"
          hint="合成说明文字"
        />
      </section>
      <section data-fixture="databases">
        <h2>数据库选择</h2>
        <DatabasePicker items={[]} loading={false} selected={picked} onChange={setPicked} />
      </section>
      <section data-fixture="history">
        <h2>资料历史</h2>
        <FieldHistoryContent field="nickname" label="昵称" rows={[]} />
      </section>
      <section data-fixture="analytics">
        <h2>活跃图表</h2>
        <ContributionHeatmap data={[]} />
      </section>
      <section data-fixture="emoji">
        <h2>表情列表</h2>
        <EmptyState
          compact
          icon={<Sticker />}
          title="还没有添加商城表情包"
          body="点右上「添加」去搜索"
        />
      </section>
      <section data-fixture="qzone">
        <h2>空间内容</h2>
        <State loading={false} error="" empty="暂时没有可查看的动态" progress="已读取 1 页" />
      </section>
      <section data-fixture="panel">
        <h2>资源面板</h2>
        <EmptyState icon={<Images />} title="未找到关联表情资源" />
      </section>
      <section data-fixture="long">
        <h2>长文案</h2>
        <EmptyState
          variant="inline"
          icon={<SearchX />}
          title="这是一条用于验证窄屏换行和超长文本排版的空状态说明文字"
          body="unbroken_identifier_abcdefghijklmnopqrstuvwxyz_0123456789_abcdefghijklmnopqrstuvwxyz"
        />
      </section>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
