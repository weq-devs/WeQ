import { useEffect, useState } from 'react';
import { Activity, Check, Copy } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { useDialog } from '../Dialog';
import { useToast } from '../Toast';
import { Card, Row, SectionHeader, Toggle } from './controls';

export function AssistantSection() {
  const refresh = useQQAutoRefresh(true);
  const status = trpc.bootstrap.getWeqAssistantStatus.useQuery(undefined, refresh);
  const setEnabled = trpc.bootstrap.setWeqAssistantEnabled.useMutation();
  const setPort = trpc.bootstrap.setWeqAssistantPort.useMutation();
  const showError = useDialog((state) => state.showError);
  const pushToast = useToast((state) => state.push);
  const [portDraft, setPortDraft] = useState('');
  const [copied, setCopied] = useState(false);
  const data = status.data;
  const busy = setEnabled.isLoading || setPort.isLoading;
  useEffect(() => {
    if (data?.port != null) setPortDraft(String(data.port));
  }, [data?.port]);
  async function toggle(enabled: boolean) {
    try {
      await setEnabled.mutateAsync({ enabled });
      await status.refetch();
    } catch (error) {
      showError('切换 WeQ 助手失败', error instanceof Error ? error.message : '服务状态未知');
      await status.refetch();
    }
  }
  async function savePort() {
    const port = Number(portDraft);
    if (!Number.isInteger(port) || port < 20000 || port > 65535) {
      showError('端口无效', '请输入 20000–65535 之间的端口号。');
      return;
    }
    try {
      const result = await setPort.mutateAsync({ port });
      await status.refetch();
      pushToast({
        tone: 'success',
        title: result.port === port ? '端口已更新' : '端口已自动调整',
        message: `WeQ 助手现监听 ${result.port}`,
      });
    } catch (error) {
      showError('修改端口失败', error instanceof Error ? error.message : '服务状态未知');
      await status.refetch();
    }
  }
  async function copyUrl() {
    if (!data?.url) return;
    try {
      await navigator.clipboard.writeText(data.url);
      setCopied(true);
    } catch (error) {
      showError('复制失败', error instanceof Error ? error.message : '无法访问剪贴板');
    }
  }
  return (
    <div className="weq-set">
      <SectionHeader icon={<Activity size={16} />} title="QQ 公众号推送" />
      <Card title="WeQ 助手">
        <Row
          label="启用 WeQ 助手"
          desc="推文写入当前账号，卡片资源仅在 WeQ 运行期间提供。"
          control={
            <Toggle
              label="启用 WeQ 助手"
              checked={data?.enabled ?? false}
              disabled={busy || status.isLoading || !!status.error}
              onChange={(enabled) => void toggle(enabled)}
            />
          }
        />
        <Row
          label="资源服务"
          desc={status.error ? '读取失败' : data?.running ? '运行中' : '已停止'}
          control={
            <button
              type="button"
              className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
              disabled={!data?.running}
              onClick={() => void copyUrl()}
              title="复制本机服务地址"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}复制地址
            </button>
          }
        />
        <Row
          label="端口"
          desc="20000–65535"
          control={
            <div className="weq-set-btn-group">
              <input
                className="weq-set-input weq-set-input-sm weq-number"
                value={portDraft}
                inputMode="numeric"
                spellCheck={false}
                disabled={busy}
                onChange={(event) => setPortDraft(event.target.value.replace(/[^0-9]/g, ''))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void savePort();
                }}
                aria-label="WeQ 助手端口"
              />
              <button
                type="button"
                className="weq-set-btn weq-set-btn-sm"
                disabled={busy || status.isLoading || !data}
                onClick={() => void savePort()}
              >
                保存
              </button>
            </div>
          }
        />
        {status.error && <p className="weq-set-note weq-set-note-warn">{status.error.message}</p>}
      </Card>
    </div>
  );
}
