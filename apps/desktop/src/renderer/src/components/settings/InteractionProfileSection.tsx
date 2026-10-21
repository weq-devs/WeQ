import { BrainCircuit } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { Card, Row, SectionHeader, Toggle } from './controls';
import { ApiModelSelect } from './ApiModelSelect';
import { IntentTuningPanel } from './IntentTuningPanel';
import { useDialog } from '../Dialog';
import '../../styles/model-settings.css';

export function InteractionProfileSection() {
  const status = trpc.account.intentSense.getStatus.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const save = trpc.account.intentSense.setConfig.useMutation();
  const utils = trpc.useUtils();
  const showError = useDialog((s) => s.showError);
  async function patch(input: Parameters<typeof save.mutateAsync>[0]) {
    try {
      const next = await save.mutateAsync(input);
      utils.account.intentSense.getStatus.setData(undefined, next);
      void utils.account.intentSense.getProfile.invalidate();
    } catch (error) {
      showError('互动画像设置失败', String(error));
    }
  }
  return (
    <div className="weq-set">
      <SectionHeader title="互动画像" icon={<BrainCircuit size={18} />} />
      <Card title="推断模型">
        <Row
          label="启用互动画像"
          control={
            <Toggle
              label="启用互动画像"
              checked={status.data?.profileEnabled ?? false}
              disabled={!status.data || save.isLoading}
              onChange={(profileEnabled) => void patch({ profileEnabled })}
            />
          }
        />
        <Row
          label="运行方式"
          control={
            <select
              className="weq-set-input"
              aria-label="互动画像运行方式"
              disabled={!status.data || save.isLoading}
              value={status.data?.profileEngine ?? 'follow'}
              onChange={(event) => {
                const mode = event.target.value;
                if (mode === 'follow' || mode === 'api' || mode === 'local' || mode === 'heuristic')
                  void patch({ profileEngine: mode });
              }}
            >
              <option value="follow">跟随意图感知</option>
              <option value="heuristic">仅本地统计</option>
              <option value="local">本地模型（共享意图资源）</option>
              <option value="api">独立 API 模型</option>
            </select>
          }
        />
        {status.data?.profileEngine === 'api' ? (
          <Row
            label="API 模型"
            desc="将所选对方文本样本发送至该服务商用于画像推断。"
            control={
              <ApiModelSelect
                label="互动画像 API 模型"
                value={status.data.profileProviderRef}
                disabled={save.isLoading}
                onChange={(profileProviderRef) => void patch({ profileProviderRef })}
              />
            }
          />
        ) : null}
      </Card>
      <p className="weq-set-note">好感度、MBTI 和互动风格均为推断，仅供参考。</p>
      <details className="weq-model-advanced">
        <summary>高级设置</summary>
        <IntentTuningPanel group="profile" />
      </details>
    </div>
  );
}
