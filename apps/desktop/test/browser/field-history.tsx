import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FieldHistoryContent } from '../../src/renderer/src/components/contactProfile/FieldHistoryContent';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import type { FieldHistoryRow } from '../../src/renderer/src/lib/contactFieldPresentation';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/contact-workspace.css';
ensureThemeInitialized();
const cases: Record<string, unknown[]> = {
  likes: [10240, 10010, 9950, 10000, 0],
  memberCount: [0, null, 2048, 1024],
  birthday: [
    { birthYear: 2000, birthMonth: 2, birthDay: 3 },
    { birthMonth: 2, birthDay: 2 },
  ],
  signature: ['新签名\n第二行' + '很长的签名内容'.repeat(12), '', '旧签名'],
  role: [2, 0, 1],
  labels: [
    ['音乐', '阅读'],
    ['阅读', '运动'],
  ],
  commonGroups: [
    [
      { groupCode: '10001', name: '新的群名称' },
      { groupCode: '10003', name: '新群' },
    ],
    [
      { groupCode: '10001', name: '旧的群名称' },
      { groupCode: '10002', name: '旧群' },
    ],
  ],
  school: [
    [{ index: 0, schoolName: '示例大学', degree: 6, enrollmentYear: 2020, graduationYear: 2024 }],
    [],
  ],
  marks: [
    {
      categories: [
        {
          marks: [
            {
              id: '1',
              name: '火花',
              level: 2,
              isLightup: true,
              count: 15,
              lightupDays: 12,
              isWearing: true,
            },
          ],
        },
      ],
    },
    { categories: [{ marks: [{ id: '1', name: '火花', level: 1, isLightup: true, count: 7 }] }] },
  ],
  dress: [
    { items: [{ appId: 15, itemId: 1, kind: '气泡', name: '示例气泡' }] },
    { items: [{ appId: 15, itemId: 0, kind: '气泡', name: '默认' }] },
  ],
  privileges: [[{ bizId: 1, level: 3, opened: true }], [{ bizId: 1, level: 2, opened: false }]],
  questions: [
    [{ id: '1', question: '最近在看什么书？', answer: '一本很有意思的小说。' }],
    [{ id: '1', question: '最近在看什么书？', answer: null }],
  ],
  photos: [
    [
      { photoId: 'old', urls: [{ url: 'https://example.invalid/old.png' }] },
      { photoId: 'missing' },
    ],
    [],
  ],
  qqShow: ['https://images.qqshow.gtimg.com/old.png', null],
  avatar: ['https://qh.qlogo.cn/old.png', 'https://qh.qlogo.cn/older.png'],
};
const names: Record<string, string> = {
  likes: '累计获赞',
  memberCount: '群成员数',
  birthday: '生日',
  signature: '个性签名',
  role: '群角色',
  labels: '标签',
  commonGroups: '共同群',
  school: '学校',
  marks: '互动标识',
  dress: '个性装扮',
  privileges: '已开通特权',
  questions: '匿问我答',
  photos: '精选照片',
  qqShow: 'QQ 秀',
  avatar: '头像',
};
const qa = {
  setField: (_field: string) => {},
  setRecords: (_field: string, _rows: FieldHistoryRow[]) => {},
  theme: useThemeStore,
};
Object.assign(window, { fieldHistoryQa: qa });
function App() {
  const [field, setField] = useState('likes');
  const [records, setRecords] = useState<FieldHistoryRow[] | null>(null);
  qa.setField = (field) => {
    setRecords(null);
    setField(field);
  };
  qa.setRecords = (field, rows) => {
    setField(field);
    setRecords(rows);
  };
  const rows: FieldHistoryRow[] =
    records ??
    (cases[field] ?? []).map((value, i) => ({
      id: i + 1,
      first_at: 1704038400000 - i * 86400000 * (i + 1),
      last_at: 1704038460000 - i * 86400000 * (i + 1),
      value,
    }));
  return (
    <main style={{ width: 'min(440px, 100%)', margin: '20px auto', padding: 8 }}>
      <section
        className="weq-field-history-dialog"
        style={{
          border: '1px solid var(--weq-border-subtle)',
          background: 'var(--weq-bg-surface)',
          borderRadius: 8,
        }}
        aria-label="字段历史"
      >
        <header className="weq-field-history-header">
          <h3>{names[field] ?? field}历史</h3>
        </header>
        <div className="weq-field-history-body">
          <FieldHistoryContent
            key={field}
            field={field}
            label={names[field] ?? field}
            rows={rows}
          />
        </div>
      </section>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
