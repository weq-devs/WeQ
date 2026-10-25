import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ExportViewer } from '../src/renderer/src/views/ExportViewer';
import { useDialog } from '../src/renderer/src/components/Dialog';

const f = vi.hoisted(() => ({
  pick: vi.fn(),
  scan: vi.fn(),
  close: vi.fn(async () => true),
  jump: vi.fn(async () => true),
  local: { kind: 'group', conv: '777', uin: '10001', configId: 'source-a' } as object | null,
  page: {
    messages: [
      {
        key: 'msg:0',
        msgId: '9001',
        msgSeq: '12',
        sendTime: 1792771200,
        sender: '合成发送人',
        parts: [
          { key: 'part:0', type: 'text', text: '<script>synthetic</script>' },
          {
            key: 'part:1',
            type: 'forward',
            text: '合并转发',
            messages: [
              {
                key: 'nested:0',
                msgId: '9002',
                msgSeq: '1',
                sendTime: 1,
                sender: '内部发送人',
                parts: [{ key: 'nested:text', type: 'text', text: '嵌套正文' }],
              },
            ],
          },
        ],
      },
    ],
    total: 1,
  },
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    exportViewer: {
      pick: { mutate: f.pick },
      scan: { mutate: f.scan },
      close: { mutate: f.close },
      jump: { mutate: f.jump },
    },
  },
  trpc: {
    exportViewer: {
      page: { useQuery: () => ({ data: f.page, isFetching: false }) },
      local: { useQuery: () => ({ data: f.local }) },
    },
  },
}));
vi.mock('../src/renderer/src/components/ImageLightbox', () => ({ openLightbox: vi.fn() }));
const source = {
  id: 'synthetic-id',
  name: '合成归档',
  path: '/synthetic/chat.jsonl',
  root: '/synthetic',
  format: 'jsonl',
  conversation: { kind: 'group', conv: '777' },
  bytes: 100,
  updatedAt: 1792771200000,
  fileMtimeMs: 0,
  messageCount: 1,
  baselineDirectory: '/synthetic/.weq-export',
};
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const navigate = vi.fn(),
  increment = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  f.pick.mockReset().mockResolvedValue({ sources: [source], truncated: false });
  f.scan.mockReset().mockResolvedValue({ sources: [source], truncated: false });
  f.close.mockClear();
  f.jump.mockClear();
  f.local = { kind: 'group', conv: '777', uin: '10001', configId: 'source-a' };
  navigate.mockClear();
  increment.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function mount() {
  await act(async () =>
    root.render(h(ExportViewer, { onNavigate: navigate, onIncrement: increment })),
  );
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === label || b.getAttribute('aria-label') === label,
  );
  if (!button) throw new Error(`button missing: ${label}`);
  await act(async () => button.click());
}
it('只提供文件夹与 JSON/JSONL 打开入口，显示嵌套正文且不执行文本 HTML', async () => {
  await mount();
  await click('打开文件夹');
  expect(f.pick).toHaveBeenCalledWith({ directory: true });
  expect(host.textContent).toContain('合成归档');
  expect(host.textContent).toContain('嵌套正文');
  expect(host.querySelector('script')).toBeNull();
  expect(host.textContent).toContain('<script>synthetic</script>');
  expect(host.querySelectorAll('details')).toHaveLength(1);
  expect(host.querySelectorAll('[aria-label="定位本机消息"]')).toHaveLength(1);
});
it('打开会话绑定当前账号与数据源，增量入口传递原基线', async () => {
  await mount();
  await click('打开 JSON / JSONL');
  await click('打开会话');
  expect(f.jump).toHaveBeenCalledWith({
    id: source.id,
    expectedUin: '10001',
    expectedConfigId: 'source-a',
    msgId: undefined,
  });
  expect(navigate).toHaveBeenCalledOnce();
  await click('增量导出');
  expect(increment).toHaveBeenCalledWith(
    expect.objectContaining({ baselineDirectory: source.baselineDirectory }),
  );
});
it('旧 QQ 号关联本机 UID 后，增量入口传递解析后的 UID', async () => {
  f.pick.mockResolvedValue({
    sources: [{ ...source, conversation: { kind: 'c2c', conv: '456' } }],
    truncated: false,
  });
  f.local = { kind: 'c2c', conv: 'u_peer', uin: '10001', configId: 'source-a' };
  await mount();
  await click('打开文件夹');
  await click('增量导出');
  expect(increment).toHaveBeenCalledWith(
    expect.objectContaining({
      conversation: { kind: 'c2c', conv: 'u_peer' },
      baselineDirectory: source.baselineDirectory,
    }),
  );
});
it('无本机会话或基线时禁用对应操作，不显示嵌套原消息跳转', async () => {
  f.local = null;
  f.pick.mockResolvedValue({
    sources: [{ ...source, baselineDirectory: undefined }],
    truncated: false,
  });
  await mount();
  await click('打开文件夹');
  expect(
    [...host.querySelectorAll('button')]
      .filter((b) => b.textContent === '打开会话' || b.textContent === '增量导出')
      .every((b) => b.disabled),
  ).toBe(true);
  expect(host.querySelector('[aria-label="定位本机消息"]')).toBeNull();
});
it('关闭撤销已打开来源', async () => {
  await mount();
  await click('打开文件夹');
  await click('关闭导出');
  expect(f.close).toHaveBeenCalledWith({ ids: [source.id] });
  expect(host.textContent).toContain('尚未打开导出');
});
it('浅层空目录提示递归，确认后使用选择授权继续扫描', async () => {
  const confirm = vi.spyOn(useDialog.getState(), 'confirm').mockResolvedValue(true);
  f.pick.mockResolvedValueOnce({ sources: [], scanToken: 'synthetic-token', truncated: false });
  await mount();
  await click('打开文件夹');
  expect(confirm).toHaveBeenCalledOnce();
  expect(f.scan).toHaveBeenCalledWith({ token: 'synthetic-token', recursive: true });
  expect(host.textContent).toContain('合成归档');
});
it('取消递归会释放选择授权而不替换原列表', async () => {
  vi.spyOn(useDialog.getState(), 'confirm').mockResolvedValue(false);
  f.pick.mockResolvedValueOnce({ sources: [], scanToken: 'synthetic-token', truncated: false });
  f.scan.mockResolvedValueOnce(null);
  await mount();
  await click('打开文件夹');
  expect(f.scan).toHaveBeenCalledWith({ token: 'synthetic-token', recursive: false });
  expect(host.textContent).toContain('尚未打开导出');
});
it('卸载后迟到的文件选择结果也会释放，不保留后台媒体能力', async () => {
  const result = { sources: [source], truncated: false };
  let finish = (_value: typeof result) => {};
  f.pick.mockReturnValueOnce(
    new Promise<typeof result>((resolve) => {
      finish = resolve;
    }),
  );
  await mount();
  await click('打开文件夹');
  await act(async () => root.unmount());
  await act(async () => finish(result));
  expect(f.close).toHaveBeenCalledWith({ ids: [source.id] });
});
