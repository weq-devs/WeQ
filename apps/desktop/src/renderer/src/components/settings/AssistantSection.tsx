import { useEffect, useRef, useState } from 'react';
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
  const startup = trpc.bootstrap.getAutostartStatus.useQuery(undefined, refresh);
  const setStartup = trpc.bootstrap.setAutostart.useMutation();
  const confirm = useDialog((state) => state.confirm);
  const showError = useDialog((state) => state.showError);
  const pushToast = useToast((state) => state.push);
  const [portDraft, setPortDraft] = useState('');
  const previousPort = useRef<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [linking, setLinking] = useState(false);
  const linkingRef = useRef(false);
  const data = status.data;
  const busy = setEnabled.isLoading || setPort.isLoading || setStartup.isLoading || linking;
  useEffect(() => {
    if (data?.port == null) return;
    const previous = previousPort.current;
    const next = String(data.port);
    setPortDraft((draft) => (draft === (previous ?? '') ? next : draft));
    previousPort.current = next;
  }, [data?.port]);
  async function toggle(enabled: boolean) {
    if (linkingRef.current) return;
    linkingRef.current = true;
    setLinking(true);
    let applied = false;
    try {
      await setEnabled.mutateAsync({ enabled });
      applied = true;
      await status.refetch();
      if (enabled) {
        const state = (await startup.refetch()).data;
        if (state?.supported && state.requiresApproval) {
          pushToast({
            tone: 'info',
            title: '登录自启仍需系统批准',
            message: '公众号推送已开启，自启是否生效请在开机启动设置中核对。',
          });
        } else if (state?.supported && !state.enabled) {
          const linked = await confirm(
            '同时开启 WeQ 登录自启？',
            'QQ 公众号推送依赖应用运行。当前未开启登录自启，下次登录系统后需要手动打开 WeQ，QQ 中的推文卡片才能加载本机内容。',
            { okLabel: '同时开启自启', cancelLabel: '仅开启推送', tone: 'info' },
          );
          if (linked) {
            const result = await setStartup.mutateAsync({ enabled: true });
            await startup.refetch();
            pushToast({
              tone: result.requiresApproval ? 'info' : 'success',
              title: result.requiresApproval ? '登录自启需要系统批准' : '已同时开启登录自启',
            });
          }
        }
      }
    } catch (error) {
      showError(
        applied && enabled ? '公众号推送已开启，自启设置未完成' : '切换 QQ 公众号推送失败',
        error instanceof Error ? error.message : '服务状态未知',
      );
      await status.refetch();
    } finally {
      linkingRef.current = false;
      setLinking(false);
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
        message: `QQ 公众号推送资源服务现监听 ${result.port}`,
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
      <Card title="推送与资源服务" settingId="assistant-service">
        <Row
          label="启用 QQ 公众号推送"
          desc="推文写入当前账号，卡片资源仅在 WeQ 运行期间提供。"
          control={
            <Toggle
              label="启用 QQ 公众号推送"
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
                aria-label="QQ 公众号推送端口"
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
