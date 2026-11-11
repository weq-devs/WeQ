import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PageSnapshots } from '../../src/renderer/src/components/PageSnapshots';
import { MailPage } from '../../src/renderer/src/views/mail/MailPage';
import type { MailApi } from '../../src/renderer/src/views/mail/api';
import type { MailDetail, MailFolder, MailPage as MailPageData } from '@weq/service/mail';
import { useThemeStore } from '../../src/renderer/src/state/theme';
import { useViewState } from '../../src/renderer/src/state/view';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/mobile-web.css';

const params = new URLSearchParams(location.search);
const scenario = params.get('scenario') ?? 'ready';
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
useViewState.setState({ openedUin: '10001' });
Object.assign(window, { mailAuditQa: { theme: useThemeStore, view: useViewState } });

const folders: MailFolder[] = [
  { id: 1, name: '收件箱', unread: 4, total: 9, locked: false },
  { id: 2, name: '星标邮件', unread: 0, total: 2, locked: false },
  { id: 3, name: '已发送', unread: 0, total: 12, locked: false },
  { id: 4, name: '草稿箱', unread: 0, total: 1, locked: false },
  { id: 5, name: '广告邮件', unread: 0, total: 3, locked: false },
];

const items = [
  {
    id: 'm1',
    subject: '关于下周三产品评审的时间调整与材料准备事项',
    snippet:
      '各位好，原定周三上午十点的评审改为下午两点，会议地点不变。请提前准备各自负责模块的演示材料，并把风险点整理到共享文档里。',
    sender: { name: '产品经理 · 合成', email: 'pm@example.invalid' },
    time: 1763000000,
    unread: true,
    starred: true,
    hasAttachments: true,
    draft: false,
  },
  {
    id: 'm2',
    subject: 'WeQ 打包产物校验结果（2.6.0）',
    snippet: '全部平台产物校验通过，附上校验摘要。',
    sender: { name: '构建机器人', email: 'ci@example.invalid' },
    time: 1762990000,
    unread: true,
    starred: false,
    hasAttachments: false,
    draft: false,
  },
  {
    id: 'm3',
    subject: 'Re: 跨端设置统一后，旧版本地覆盖值如何处理',
    snippet: '我们只需要保留共享值，本机覆盖已经去掉。旧备份仍然可读。',
    sender: { name: '同事甲', email: 'a@example.invalid' },
    time: 1762980000,
    unread: true,
    starred: false,
    hasAttachments: false,
    draft: false,
  },
  {
    id: 'm4',
    subject: '订阅确认：每周摘要',
    snippet: '你已成功订阅每周摘要。',
    sender: { name: '通知中心', email: 'notice@example.invalid' },
    time: 1762970000,
    unread: false,
    starred: false,
    hasAttachments: false,
    draft: false,
  },
  {
    id: 'm5',
    subject: '(无回执) 附件已过期提醒',
    snippet: '附件将在 7 天后过期，请及时下载。',
    sender: { name: '文件服务', email: 'files@example.invalid' },
    time: 1762960000,
    unread: false,
    starred: false,
    hasAttachments: true,
    draft: false,
  },
];

const listPage: MailPageData = {
  items: items as MailPageData['items'],
  page: 0,
  total: items.length,
  unread: items.filter((item) => item.unread).length,
  hasMore: false,
};

const detail: MailDetail = {
  id: 'm1',
  folderId: 1,
  messageId: 'fixture@example.invalid',
  subject: '关于下周三产品评审的时间调整与材料准备事项',
  snippet: '',
  sender: { name: '产品经理 · 合成', email: 'pm@example.invalid' },
  to: [{ name: '', email: 'self@example.invalid' }],
  cc: [],
  bcc: [],
  time: 1763000000,
  size: 1024,
  unread: false,
  starred: true,
  hasAttachments: true,
  draft: false,
  html: '<p>各位好：</p><p>原定周三上午十点的评审改为下午两点，会议地点不变。</p><p>请提前准备演示材料。</p>',
  replyTo: null,
  attachments: [],
};

const status =
  scenario === 'error'
    ? {
        state: 'error' as const,
        unread: 0,
        notifications: false,
        lastSync: null,
        error: 'QQ 邮箱登录状态已失效，请重新连接。',
      }
    : scenario === 'connecting'
      ? {
          state: 'connecting' as const,
          unread: 0,
          notifications: false,
          lastSync: null,
          error: null,
        }
      : scenario === 'empty'
        ? {
            state: 'ready' as const,
            unread: 0,
            notifications: false,
            lastSync: 1763000000,
            error: null,
          }
        : {
            state: 'ready' as const,
            unread: 4,
            notifications: true,
            lastSync: 1763000000,
            error: null,
          };

const api: MailApi = {
  status: async () => status,
  connect: async () => status,
  disconnect: async () => {},
  folders: async () => (scenario === 'empty' ? folders.map((f) => ({ ...f, unread: 0 })) : folders),
  list: async () =>
    scenario === 'empty' ? { ...listPage, items: [], total: 0, unread: 0 } : listPage,
  read: async () => detail,
  action: async () => {},
  send: async () => ({ state: 'accepted', id: 'fixture', messageId: 'fixture' }),
  notifications: async () => status,
  upload: async () => null,
  download: async () => true,
  save: async () => 'fixture',
  exportMessages: async () => 'fixture',
  image: async () => ({ mime: 'image/png', base64: '' }),
  subscribe: () => () => {},
  openLink: async () => {},
  dispose: () => {},
};

function Fixture() {
  return (
    <QueryClientProvider client={queryClient}>
      <PageSnapshots scope="mail-audit-fixture">
        <div className="weq-web-shell" style={{ height: '100dvh', width: '100%' }}>
          <div style={{ height: '100%' }}>
            <MailPage api={api} selfEmail="self@example.invalid" onOpenSettings={() => {}} />
          </div>
        </div>
      </PageSnapshots>
    </QueryClientProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
