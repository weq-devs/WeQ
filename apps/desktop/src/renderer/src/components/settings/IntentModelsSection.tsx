import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
import { useDialog } from '../Dialog';
import { QueryError, Row } from './controls';
import { EnhancementPacksLink } from './RecognitionSettingsSection';

export function IntentModelsSection() {
  const active = useTabActive();
  const utils = trpc.useUtils();
  const showError = useDialog((state) => state.showError);
  const resources = trpc.bootstrap.localModelResources.useQuery(undefined, { enabled: active });
  const engine = trpc.bootstrap.getLocalEngine.useQuery(undefined, {
    enabled: active,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const select = trpc.bootstrap.setLocalModelResource.useMutation();
  const selected = resources.data?.selected.intent ?? 'auto';
  async function choose(modelId: string) {
    try {
      await select.mutateAsync({ kind: 'intent', modelId });
      await Promise.all([
        utils.bootstrap.localModelResources.invalidate(),
        utils.bootstrap.getLocalEngine.invalidate(),
        utils.bootstrap.getSettings.invalidate(),
        utils.account.intentSense.getStatus.invalidate(),
      ]);
    } catch (error) {
      showError('选择模型失败', String(error));
    }
  }
  return (
    <>
      <Row
        settingId="intent-model-resources"
        label="本地模型资源"
        control={
          <select
            className="weq-set-input"
            aria-label="意图模型资源"
            value={selected}
            disabled={
              select.isLoading ||
              !resources.data ||
              !engine.data?.available ||
              !engine.data.models.length
            }
            onChange={(event) => void choose(event.target.value)}
          >
            {!engine.data?.models.some((model) => model.id === selected) ? (
              <option value={selected}>
                {selected === 'auto' ? '自动选择' : selected} · 当前不可用
              </option>
            ) : null}
            {(engine.data?.models ?? []).map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
                {model.downloaded ? ' · 已下载' : ''}
              </option>
            ))}
          </select>
        }
      />
      <Row label="本地增强资源" control={<EnhancementPacksLink />} />
      {resources.error || engine.error ? (
        <QueryError
          message={(resources.error ?? engine.error)!.message}
          retryLabel="重新读取意图模型资源"
          retrying={resources.isFetching || engine.isFetching}
          onRetry={() => {
            void resources.refetch();
            void engine.refetch();
          }}
        />
      ) : null}
    </>
  );
}
