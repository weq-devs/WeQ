import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { usePageSnapshotReset } from '../PageSnapshots';
import type {
  CapabilityProbeResult,
  AgentLabProviderModel,
  ModelMetadata,
  ReasoningProbeResult,
} from '@weq/agentlab';
import { modelReasoningEfforts } from '@weq/agentlab/model-metadata';
import {
  Boxes,
  CheckCheck,
  DownloadCloud,
  FlaskConical,
  Image,
  Layers,
  Loader2,
  MessageSquare,
  Plus,
  Save,
  Server,
  Sparkles,
  Square,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { trpc, client } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
import { useAppDialog } from '../../lib/dialogUtils';
import { Modal } from '../../components/Dialog';
import { Card, CheckPillGroup, QueryError, Row, SectionHeader } from './controls';
import { useDraftClose } from '../../lib/draftClose';
import { providerDisplayLabels } from '../../lib/providerDisplayLabels';
import {
  connectionTestKey,
  runConnectionTest,
  useConnectionTestTasks,
} from '../../lib/connectionTestTask';
import { useToast } from '../Toast';
import { DefaultApiModelRow } from './DefaultApiModelRow';
import { DefaultVisionModelRow } from './AiImageSettings';
import '../../styles/search-scope.css';
import '../../styles/provider-settings.css';

type Capability = 'chat' | 'embedding' | 'vision';
const CAPABILITIES: { value: Capability; label: string; Icon: LucideIcon }[] = [
  { value: 'chat', label: '聊天', Icon: MessageSquare },
  { value: 'embedding', label: '向量', Icon: Layers },
  { value: 'vision', label: '视觉', Icon: Image },
];

type ModelForm = {
  rowKey: string;
  metadata?: ModelMetadata;
  overrides?: AgentLabProviderModel['overrides'];
  reasoningEfforts?: string[];
  reasoningEffortsText?: string;
  id: string;
  label: string;
  capabilities: Capability[];
  probe?: CapabilityProbeResult[];
  reasoningProbe?: ReasoningProbeResult;
};
type ProviderForm = {
  id: string;
  name: string;
  vendor: string;
  baseUrl: string;
  apiKey: string;
  models: ModelForm[];
};

function clearModelMetadata(model: ModelForm): ModelForm {
  return {
    ...model,
    metadata: undefined,
    probe: undefined,
    reasoningProbe: undefined,
    ...(!model.overrides?.reasoning && model.metadata ? { reasoningEfforts: undefined } : {}),
    ...(model.metadata
      ? {
          capabilities: model.capabilities.filter(
            (value) =>
              model.overrides?.capabilities?.includes(value) ||
              model.metadata?.capabilities[value] === 'unknown',
          ),
        }
      : {}),
  };
}

/** 新建表单默认选中的厂商模板。 */
const DEFAULT_VENDOR = 'siliconflow';

function emptyForm(): ProviderForm {
  return {
    id: crypto.randomUUID(),
    name: '',
    vendor: DEFAULT_VENDOR,
    baseUrl: '',
    apiKey: '',
    models: [],
  };
}

/** 模板标签去掉括号说明后的显示名：硅基流动 SiliconFlow（推荐）→ 硅基流动 SiliconFlow。 */
function templateDisplayName(label: string | undefined): string {
  return label?.replace(/（.*?）/g, '').trim() ?? '';
}

export function AgentLabSection(): ReactElement {
  const active = useTabActive();
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const catalog = trpc.bootstrap.getAgentLabCatalog.useQuery(undefined, {
    enabled: active,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const catalogRef = useRef(catalog.data);
  catalogRef.current = catalog.data;
  const providers = trpc.bootstrap.listAgentLabProviders.useQuery(undefined, {
    enabled: active,
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const saveProvider = trpc.bootstrap.saveAgentLabProvider.useMutation();
  const providerLabels = providerDisplayLabels(providers.data ?? []);
  const deleteProvider = trpc.bootstrap.deleteAgentLabProvider.useMutation();
  const fetchModels = trpc.bootstrap.fetchAgentLabModels.useMutation();

  const [selectedId, setSelectedId] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ProviderForm>(emptyForm);
  const legacyOpen = usePageSnapshotReset('provider:open');
  const legacyForm = usePageSnapshotReset('provider:form');
  useEffect(() => {
    // 编辑器由自身的关闭确认保护，不再将打开、载入与关闭动作登记为页面草稿。
    legacyOpen.reset();
    legacyForm.reset();
  }, [legacyOpen, legacyForm]);
  const formRef = useRef(form);
  formRef.current = form;
  const [detectingKey, setDetectingKey] = useState<string | null>(null);
  const detectingModel =
    detectingKey === null ? null : form.models.findIndex((model) => model.rowKey === detectingKey);
  const inspectionQueue = useRef(Promise.resolve());
  const inspected = useRef(new Set<string>());
  const asked = useRef(new Set<string>());
  const testKey = connectionTestKey('llm', form.id);
  const testing = useConnectionTestTasks((state) => state.running.has(testKey));
  const [fetchingModels, setFetchingModels] = useState(false);
  /** 从 base_url 拉回来的模型清单（待用户勾选导入）；null = 未拉取。 */
  const [fetchedModels, setFetchedModels] = useState<ModelForm[] | null>(null);
  /** 拉取清单里已勾选要导入的模型 id。 */
  const [checkedModelIds, setCheckedModelIds] = useState<string[]>([]);
  const guard = useDraftClose(
    () => setOpen(false),
    form,
    saveProvider.isLoading || deleteProvider.isLoading || fetchingModels || detectingModel !== null,
  );

  /** 上一次由模板带入的 base_url / 名称：表单值与之相同 = 用户没改过，可以跟着模板切换。 */
  const templateDefaultsRef = useRef<{ baseUrl: string; name: string }>({ baseUrl: '', name: '' });
  /** 表单里属于「模板推荐」的模型 id：切换模板时整批替换，用户自己加的会保留。 */
  const templateModelIdsRef = useRef<Set<string>>(new Set());

  /** 把已保存的 provider 数据填进表单（并按模板重新标定基线，避免切换模板时覆盖自定义值）。 */
  const fillFormFrom = useCallback(
    (item: {
      id: string;
      name: string;
      vendor: string;
      baseUrl: string;
      apiKey: string;
      models: AgentLabProviderModel[];
    }) => {
      const entry = catalogRef.current?.find((c) => c.vendor === item.vendor);
      const presetIds = new Set((entry?.models ?? []).map((m) => m.id));
      // 只有 id 与模板推荐一致的模型算「模板模型」；用户自己加的不算，切换模板时保留。
      templateModelIdsRef.current = new Set(
        item.models.map((m) => m.id).filter((modelId) => presetIds.has(modelId)),
      );
      templateDefaultsRef.current = {
        baseUrl: (entry?.baseUrl ?? '').trim(),
        name: templateDisplayName(entry?.label),
      };
      const next: ProviderForm = {
        id: item.id,
        name: item.name,
        vendor: item.vendor,
        baseUrl: item.baseUrl,
        apiKey: item.apiKey,
        models: item.models.map((m) => ({
          rowKey: crypto.randomUUID(),
          id: m.id,
          label: m.label ?? '',
          capabilities: m.capabilities as Capability[],
          reasoningEfforts: m.reasoningEfforts,
          metadata: m.metadata,
          overrides:
            m.overrides ??
            (!m.metadata && m.reasoningEfforts !== undefined ? { reasoning: true } : undefined),
        })),
      };
      setForm(next);
      guard.reset(next);
    },
    // 模板查询迟到只更新模板来源，不重新灌入并覆盖正在编辑的草稿。
    [guard.reset, setForm],
  );

  const vendorEntry = useMemo(
    () => catalog.data?.find((item) => item.vendor === form.vendor),
    [catalog.data, form.vendor],
  );

  function update<K extends keyof ProviderForm>(key: K, value: ProviderForm[K]): void {
    if (key === 'baseUrl' || key === 'apiKey') {
      setFetchedModels(null);
      setCheckedModelIds([]);
    }
    setForm((current) => ({
      ...current,
      [key]: value,
      ...(key === 'baseUrl' || key === 'apiKey'
        ? {
            models: current.models.map(clearModelMetadata),
          }
        : {}),
    }));
  }

  /** 点「新建」：在新开的灯箱卡片里填一个空表单（并应用默认厂商模板）。 */
  function toggleCreate(): void {
    inspected.current.clear();
    asked.current.clear();
    setSelectedId('');
    setFetchedModels(null);
    setCheckedModelIds([]);
    templateDefaultsRef.current = { baseUrl: '', name: '' };
    templateModelIdsRef.current = new Set();
    // 表单默认选中了 DEFAULT_VENDOR 模板，这里实际应用一次模板，
    // 带入 base_url / 名称 / 推荐模型，避免「显示选中了模板但字段是空的」造成误导。
    const next = withVendorTemplate(emptyForm(), DEFAULT_VENDOR);
    setForm(next);
    guard.reset(next);
    setOpen(true);
  }

  /** 点已有 provider：在灯箱卡片里打开编辑表单。 */
  function editProvider(id: string): void {
    const current = providers.data?.find((item) => item.id === id);
    if (!current) return;
    inspected.current.clear();
    asked.current.clear();
    setFetchedModels(null);
    setCheckedModelIds([]);
    fillFormFrom(current);
    setSelectedId(id);
    setOpen(true);
  }

  /**
   * 合并模板推荐模型：先摘掉上一批模板带来的模型，再补上当前模板的推荐模型。
   * 用户手动添加（或改过 id）的模型不在模板集合里，会原样保留，因此切换模板不会叠加。
   */
  function applyTemplateModels(base: ModelForm[], vendor: string): ModelForm[] {
    const entry = catalog.data?.find((item) => item.vendor === vendor);
    const preset: ModelForm[] = (entry?.models ?? []).map((m) => ({
      rowKey: crypto.randomUUID(),
      id: m.id,
      label: m.label ?? '',
      capabilities: m.capabilities as Capability[],
    }));
    // 没有推荐模型的模板（如「OpenAI 兼容（自定义）」）不动现有列表。
    if (preset.length === 0) return base;
    const templateIds = templateModelIdsRef.current;
    const kept = base.filter((m) => !templateIds.has(m.id));
    const keptIds = new Set(kept.map((m) => m.id));
    const added = preset.filter((m) => !keptIds.has(m.id));
    templateModelIdsRef.current = new Set(preset.map((m) => m.id));
    return [...kept, ...added];
  }

  /**
   * 应用厂商模板：带入 base_url / 名称，并同步模板推荐模型。
   * 只有「空值」或「仍等于上次模板带入的值」才会跟着换，用户手填过的值一律保留。
   */
  function withVendorTemplate(base: ProviderForm, vendor: string): ProviderForm {
    const entry = catalog.data?.find((item) => item.vendor === vendor);
    const presetBaseUrl = (entry?.baseUrl ?? '').trim();
    const presetName = templateDisplayName(entry?.label);
    const defaults = templateDefaultsRef.current;
    const baseUrlUntouched = base.baseUrl.trim() === '' || base.baseUrl.trim() === defaults.baseUrl;
    const nameUntouched = base.name.trim() === '' || base.name.trim() === defaults.name;
    const baseUrl = baseUrlUntouched && presetBaseUrl ? presetBaseUrl : base.baseUrl;
    const name = nameUntouched && presetName ? presetName : base.name;
    // 模板没提供该字段（自定义厂商）时以当前值为新基线，之后切模板仍能刷新。
    templateDefaultsRef.current = {
      baseUrl: presetBaseUrl || baseUrl.trim(),
      name: presetName || name.trim(),
    };
    return {
      ...base,
      vendor,
      baseUrl,
      name,
      models: applyTemplateModels(
        base.vendor !== vendor || base.baseUrl !== baseUrl
          ? base.models.map(clearModelMetadata)
          : base.models,
        vendor,
      ),
    };
  }

  function applyVendor(vendor: string): void {
    setFetchedModels(null);
    setCheckedModelIds([]);
    setForm((current) => withVendorTemplate(current, vendor));
  }

  function importTemplateModels(): void {
    const current = formRef.current;
    const next = {
      ...current,
      models: applyTemplateModels(current.models, current.vendor),
    };
    formRef.current = next;
    setForm(next);
    inspectModels(
      next,
      next.models.filter((model) => !current.models.includes(model)).map((model) => model.rowKey),
    );
  }

  /**
   * 按当前表单里的 Base URL (+ API Key) 拉取厂商可用模型列表（参考 MaiBot 的 /models 代理）。
   * 拉回来后先列出来让用户勾选，再「导入选中」合并进模型列表——不直接覆盖用户已配的内容。
   */
  async function onFetchModels(): Promise<void> {
    const snapshot = form;
    const baseUrl = form.baseUrl.trim();
    if (!baseUrl) {
      dialog.error('无法拉取', '请先填写 Base URL。');
      return;
    }
    setFetchingModels(true);
    try {
      const models = await fetchModels.mutateAsync({
        baseUrl,
        apiKey: form.apiKey.trim(),
        vendor: form.vendor,
      });
      if (
        formRef.current.id !== snapshot.id ||
        formRef.current.baseUrl !== snapshot.baseUrl ||
        formRef.current.apiKey !== snapshot.apiKey ||
        formRef.current.vendor !== snapshot.vendor
      )
        return;
      const list: ModelForm[] = models.map((m) => ({
        ...m,
        rowKey: crypto.randomUUID(),
        id: m.id,
        label: m.label ?? '',
        capabilities: m.capabilities as Capability[],
      }));
      setFetchedModels(list);
      // 默认全选「表单里还没有的」模型，已经加过的不重复拉进来。
      const existing = new Set(form.models.map((m) => m.id.trim()).filter(Boolean));
      setCheckedModelIds(list.filter((m) => !existing.has(m.id)).map((m) => m.id));
      if (list.length === 0) {
        dialog.error('没有拉取到模型', '接口可达，但返回的模型列表为空。');
      }
    } catch (error) {
      setFetchedModels(null);
      setCheckedModelIds([]);
      dialog.error('拉取模型列表失败', error instanceof Error ? error.message : String(error));
    } finally {
      setFetchingModels(false);
    }
  }

  /** 把勾选的拉取结果合并进模型列表（已有的同 id 跳过，不覆盖用户手配的能力）。 */
  function importFetchedModels(): void {
    if (!fetchedModels) return;
    const current = formRef.current;
    const seen = new Set(current.models.map((m) => m.id.trim()).filter(Boolean));
    const added = fetchedModels.filter((m) => checkedModelIds.includes(m.id) && !seen.has(m.id));
    const next = { ...current, models: [...current.models, ...added] };
    formRef.current = next;
    setForm(next);
    inspectModels(
      next,
      added.map((m) => m.rowKey),
      ['ollama', 'openai', 'anthropic', 'gemini', 'mistral'].includes(current.vendor)
        ? undefined
        : added,
    );
    setFetchedModels(null);
    setCheckedModelIds([]);
  }

  /** 模板中有多少个模型尚未添加（用于按钮 badge）。 */
  const newModelCount = useMemo(() => {
    const entry = catalog.data?.find((item) => item.vendor === form.vendor);
    if (!entry?.models.length) return 0;
    const seen = new Set(form.models.map((m) => m.id));
    return entry.models.filter((m) => !seen.has(m.id)).length;
  }, [catalog.data, form.vendor, form.models]);

  function addModel(): void {
    setForm((c) => ({
      ...c,
      models: [...c.models, { rowKey: crypto.randomUUID(), id: '', label: '', capabilities: [] }],
    }));
  }
  function removeModel(index: number): void {
    setForm((c) => ({ ...c, models: c.models.filter((_, i) => i !== index) }));
  }
  function updateModel(
    index: number,
    patch: Partial<ModelForm>,
    manualCapability?: Capability,
  ): void {
    setForm((c) => ({
      ...c,
      models: c.models.map((m, i) =>
        i === index
          ? {
              ...(patch.id === undefined ? m : clearModelMetadata(m)),
              ...patch,
              ...(manualCapability
                ? {
                    overrides: {
                      ...m.overrides,
                      capabilities: [
                        ...new Set([...(m.overrides?.capabilities ?? []), manualCapability]),
                      ],
                    },
                  }
                : {}),
              ...(patch.reasoningEffortsText === undefined
                ? {}
                : { overrides: { ...m.overrides, reasoning: true } }),
            }
          : m,
      ),
    }));
  }

  function inspectModels(
    snapshot: ProviderForm,
    keys: string[],
    known?: AgentLabProviderModel[],
    retry = false,
  ): void {
    const identity = (model: ModelForm) =>
      JSON.stringify([
        snapshot.id,
        snapshot.baseUrl.trim(),
        snapshot.apiKey.trim(),
        snapshot.vendor,
        model.id.trim(),
      ]);
    const targets = snapshot.models.filter(
      (model) =>
        keys.includes(model.rowKey) &&
        model.id.trim() &&
        (retry || !inspected.current.has(identity(model)) || !model.metadata),
    );
    if (!snapshot.baseUrl.trim() || !targets.length) return;
    for (const model of targets) inspected.current.add(identity(model));
    const sameEndpoint = (current: ProviderForm) =>
      current.id === snapshot.id &&
      current.baseUrl === snapshot.baseUrl &&
      current.apiKey === snapshot.apiKey &&
      current.vendor === snapshot.vendor;
    const merge = (
      model: ModelForm,
      metadata: ModelMetadata,
      probe?: CapabilityProbeResult[],
      reasoningProbe?: ReasoningProbeResult,
    ) => {
      setForm((current) => {
        if (!sameEndpoint(current)) return current;
        const next = {
          ...current,
          models: current.models.map((item) => {
            if (item.rowKey !== model.rowKey || item.id.trim() !== model.id.trim()) return item;
            const reasoningEfforts = modelReasoningEfforts(metadata);
            return {
              ...item,
              metadata,
              probe: probe ?? item.probe,
              reasoningProbe: reasoningProbe ?? item.reasoningProbe,
              capabilities: CAPABILITIES.filter(({ value }) =>
                item.overrides?.capabilities?.includes(value) ||
                metadata.capabilities[value] === 'unknown'
                  ? item.capabilities.includes(value)
                  : metadata.capabilities[value] === 'supported',
              ).map(({ value }) => value),
              ...(!item.overrides?.reasoning && reasoningEfforts !== undefined
                ? {
                    reasoningEfforts,
                    reasoningEffortsText: undefined,
                  }
                : {}),
            };
          }),
        };
        formRef.current = next;
        return next;
      });
    };
    inspectionQueue.current = inspectionQueue.current.then(async () => {
      if (!sameEndpoint(formRef.current)) return;
      setDetectingKey(targets[0]!.rowKey);
      try {
        let models = known;
        let error: string | undefined;
        if (!models) {
          try {
            models = await fetchModels.mutateAsync({
              baseUrl: snapshot.baseUrl.trim(),
              apiKey: snapshot.apiKey.trim(),
              vendor: snapshot.vendor,
              modelIds: targets.map((model) => model.id.trim()),
            });
          } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
          }
        }
        if (!sameEndpoint(formRef.current)) return;
        const pending = targets
          .filter((model) =>
            formRef.current.models.some(
              (item) => item.rowKey === model.rowKey && item.id.trim() === model.id.trim(),
            ),
          )
          .map((model) => {
            const metadata: ModelMetadata = models?.find((item) => item.id === model.id.trim())
              ?.metadata ?? {
              capabilities: { chat: 'unknown', embedding: 'unknown', vision: 'unknown' },
              reasoning: { controls: [] },
              raw: {},
              source: 'models',
              fetchedAt: Date.now(),
              error,
            };
            merge(model, metadata);
            const capabilities = CAPABILITIES.filter(
              ({ value }) => metadata.capabilities[value] === 'unknown',
            ).map(({ value }) => value);
            const reasoning =
              metadata.capabilities.chat !== 'unsupported' &&
              metadata.reasoning.supported !== false &&
              metadata.reasoning.controls.length === 0;
            return { model, metadata, capabilities, reasoning };
          })
          .filter(
            ({ model, capabilities, reasoning }) =>
              (capabilities.length || reasoning) && (retry || !asked.current.has(identity(model))),
          );
        if (!pending.length) return;
        for (const { model } of pending) asked.current.add(identity(model));
        const parts = [
          pending.some((item) => item.capabilities.length) ? '能力' : '',
          pending.some((item) => item.reasoning) ? '思考控制与合法档位' : '',
        ]
          .filter(Boolean)
          .join('、');
        const errors = [...new Set(pending.map((item) => item.metadata.error).filter(Boolean))];
        const confirmed = await dialog.confirm(
          '探测缺失的模型信息？',
          `${pending.length} 个模型缺少${parts}。${errors.length ? `元数据读取情况：${errors.join('；')}。` : ''}是否发送测试请求？仅探测缺失项，可能产生少量 API 费用，使用合成输入，不包含聊天记录。`,
          { okLabel: '开始探测', cancelLabel: '暂不探测' },
        );
        if (!confirmed || !sameEndpoint(formRef.current)) return;
        for (const entry of pending) {
          if (!sameEndpoint(formRef.current)) break;
          const live = formRef.current.models.find(
            (item) =>
              item.rowKey === entry.model.rowKey && item.id.trim() === entry.model.id.trim(),
          );
          if (!live) continue;
          setDetectingKey(live.rowKey);
          const result = await client.bootstrap.detectAgentLabModelCapabilities.mutate({
            providerId: snapshot.id,
            providerName: snapshot.name.trim() || 'API',
            baseUrl: snapshot.baseUrl.trim(),
            apiKey: snapshot.apiKey.trim(),
            model: entry.model.id.trim(),
            capabilities: entry.capabilities,
            reasoning: entry.reasoning,
          });
          const metadata = {
            ...entry.metadata,
            capabilities: { ...entry.metadata.capabilities },
            reasoning: result.reasoning?.reasoning ?? entry.metadata.reasoning,
          };
          for (const item of result.capabilities)
            metadata.capabilities[item.capability] = item.status;
          merge(entry.model, metadata, result.capabilities, result.reasoning);
        }
      } catch (error) {
        dialog.error('模型检测失败', error instanceof Error ? error.message : String(error));
      } finally {
        setDetectingKey(null);
      }
    });
  }
  async function onSave(): Promise<void> {
    // 新建草稿有独立 ID；同名／同模板不覆盖，编辑和重复保存仍沿用原引用。
    const id = form.id;
    const models = form.models
      .map((m) => ({
        id: m.id.trim(),
        label: m.label.trim() || undefined,
        capabilities: m.capabilities,
        metadata: m.metadata,
        overrides: m.overrides,
        reasoningEfforts: m.reasoningEfforts,
        ...(m.reasoningEffortsText === undefined
          ? {}
          : {
              reasoningEfforts: m.reasoningEffortsText.trim()
                ? [
                    ...new Set(
                      m.reasoningEffortsText
                        .split(',')
                        .map((item) => item.trim())
                        .filter(Boolean),
                    ),
                  ]
                : [],
            }),
      }))
      .filter((m) => m.id);
    if (models.length === 0) {
      dialog.error('保存失败', '至少配置一个模型（可点「导入模板推荐」）。');
      return;
    }
    try {
      await saveProvider.mutateAsync({
        id,
        name: form.name.trim() || id,
        vendor: form.vendor,
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim(),
        models,
      });
      guard.reset(form);
      setSelectedId(id);
      setOpen(true);
      await utils.bootstrap.listAgentLabProviders.invalidate();
      await utils.bootstrap.getAgentLabDefaultModel.invalidate();
      await utils.account.intentSense.getStatus.invalidate();
      dialog.success('已保存', `服务商「${form.name.trim() || id}」配置已更新`);
    } catch (error) {
      dialog.error('保存服务商失败', error instanceof Error ? error.message : String(error));
    }
  }

  /** 测试连通性：用表单里第一个带「聊天」能力的模型探活，把详细错误（状态码/响应体）展示出来。 */
  function onTest(): void {
    if (!form.baseUrl.trim()) {
      useToast.getState().push({
        tone: 'warning',
        durationKind: 'success',
        title: '无法测试',
        detail: '请先填写 Base URL。',
      });
      return;
    }
    const chatModel = form.models
      .find((m) => m.capabilities.includes('chat') && m.id.trim())
      ?.id.trim();
    if (!chatModel) {
      useToast.getState().push({
        tone: 'warning',
        title: '无法测试',
        detail: '请先添加并填写一个带「聊天」能力的模型。',
        durationKind: 'success',
      });
      return;
    }
    const input = {
      baseUrl: form.baseUrl.trim(),
      apiKey: form.apiKey.trim(),
      model: chatModel,
      providerId: form.id,
      providerName: form.name.trim() || 'API',
    };
    const label = `${form.name.trim() || 'API'} · ${form.id.slice(-8)} · ${chatModel}`;
    void runConnectionTest(testKey, label, async () => {
      const res = await client.bootstrap.testAgentLabProvider.mutate(input);
      if (!res.ok) throw new Error(res.error ?? '未知错误');
      return {
        detail: `模型「${chatModel}」可正常调用${res.reply ? `，回了：${res.reply}` : '。'}`,
      };
    });
  }

  async function onDelete(): Promise<void> {
    if (!selectedId) return;
    const ok = await dialog.confirm('删除服务商', `确认删除「${selectedId}」？`, {
      okLabel: '删除',
      cancelLabel: '返回',
      tone: 'warning',
    });
    if (!ok) return;
    try {
      const removed = selectedId;
      await deleteProvider.mutateAsync({ id: selectedId });
      setSelectedId('');
      templateDefaultsRef.current = { baseUrl: '', name: '' };
      templateModelIdsRef.current = new Set();
      setForm(emptyForm());
      setOpen(false);
      await utils.bootstrap.listAgentLabProviders.invalidate();
      await utils.bootstrap.getAgentLabDefaultModel.invalidate();
      await utils.account.intentSense.getStatus.invalidate();
      dialog.success('已删除', `服务商「${removed}」已移除`);
    } catch (error) {
      dialog.error('删除服务商失败', error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="weq-set">
      <SectionHeader icon={<Boxes size={18} strokeWidth={1.8} />} title="API 配置" />

      <Card
        title="LLM"
        resetId="api-default"
        icon={<Server size={15} strokeWidth={1.8} />}
        settingId="llm-providers"
        action={
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
            onClick={toggleCreate}
          >
            <Plus size={12} />
            新建
          </button>
        }
      >
        <DefaultApiModelRow />
        <DefaultVisionModelRow />
        <div className="weq-set-card-title">已保存的服务商</div>
        {providers.error ? (
          <QueryError
            message={`API 配置读取失败：${providers.error.message}`}
            retryLabel="重新读取 API 配置"
            retrying={providers.isFetching}
            onRetry={() => void providers.refetch()}
          />
        ) : null}
        {providers.isLoading ? (
          <p className="weq-set-empty" role="status">
            正在读取 API 配置…
          </p>
        ) : (providers.data ?? []).length === 0 ? (
          providers.error ? null : (
            <div className="weq-set-row-desc" style={{ padding: '4px 2px' }}>
              还没有服务商，点右上角「新建」添加一个服务商。
            </div>
          )
        ) : (
          <div className="weq-agentlab-provider-list">
            {(providers.data ?? []).map((item) => (
              <button
                key={item.id}
                type="button"
                title={providerLabels.get(item.id)}
                className={`weq-agentlab-provider-item${open && selectedId === item.id ? ' is-active' : ''}`}
                onClick={() => editProvider(item.id)}
              >
                <span className="weq-agentlab-provider-name">
                  <Server
                    size={14}
                    strokeWidth={1.8}
                    aria-hidden
                    style={{ marginRight: 6, verticalAlign: '-2px', opacity: 0.7 }}
                  />
                  {providerLabels.get(item.id)}
                </span>
                <small>
                  {item.models.length} 个模型 · {item.baseUrl}
                </small>
              </button>
            ))}
          </div>
        )}
      </Card>

      {open ? (
        <Modal
          presentation="panel"
          onClose={guard.requestClose}
          width={620}
          className="weq-provider-window"
        >
          <div className="weq-provider-modal">
            <header className="weq-provider-modal-head">
              <span className="weq-provider-modal-icon">
                <Server size={16} strokeWidth={1.8} aria-hidden />
              </span>
              <strong>{selectedId ? '编辑服务商' : '新建服务商'}</strong>
              <button
                type="button"
                className="weq-set-iconbtn weq-provider-modal-close"
                onClick={guard.requestClose}
                aria-label="关闭"
              >
                <X size={16} />
              </button>
            </header>

            <fieldset className="weq-provider-modal-body weq-provider-fields">
              {catalog.error ? (
                <QueryError
                  message={`服务商模板读取失败：${catalog.error.message}`}
                  retryLabel="重新读取服务商模板"
                  retrying={catalog.isFetching}
                  onRetry={() => void catalog.refetch()}
                />
              ) : null}
              <Row
                label="服务商模板"
                desc="选模板自动带入 base_url 与推荐模型。"
                control={
                  <select
                    className="weq-set-input"
                    aria-label="API 服务商模板"
                    value={form.vendor}
                    disabled={catalog.isLoading}
                    onChange={(e) => applyVendor(e.target.value)}
                  >
                    {!catalog.data?.some((item) => item.vendor === form.vendor) ? (
                      <option value={form.vendor}>{form.vendor}</option>
                    ) : null}
                    {(catalog.data ?? []).map((item) => (
                      <option key={item.vendor} value={item.vendor}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                }
              />
              <Row
                label="显示名称"
                control={
                  <input
                    className="weq-set-input"
                    aria-label="API 显示名称"
                    value={form.name}
                    onChange={(e) => update('name', e.target.value)}
                    placeholder="硅基流动"
                  />
                }
              />
              <Row
                label="Base URL"
                desc={
                  vendorEntry
                    ? `模板默认：${vendorEntry.baseUrl || '（自定义）'}`
                    : 'OpenAI 兼容接口根路径'
                }
                control={
                  <input
                    className="weq-set-input"
                    aria-label="API Base URL"
                    value={form.baseUrl}
                    onChange={(e) => update('baseUrl', e.target.value)}
                    placeholder="https://api.siliconflow.cn/v1"
                  />
                }
              />
              <Row
                label="API Key"
                desc={vendorEntry?.apiKeyHint}
                control={
                  <input
                    className="weq-set-input"
                    type="password"
                    aria-label="API Key"
                    value={form.apiKey}
                    onChange={(e) => update('apiKey', e.target.value)}
                    placeholder="sk-..."
                  />
                }
              />

              <div className="weq-set-card-head" style={{ marginTop: 8 }}>
                <div className="weq-set-card-title">可用模型</div>
                <div className="weq-set-card-action" style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
                    onClick={importTemplateModels}
                    disabled={!vendorEntry?.models.length}
                  >
                    <Sparkles size={12} /> 导入模板推荐
                    {newModelCount > 0 ? ` (${newModelCount})` : ''}
                  </button>
                  <button
                    type="button"
                    className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
                    onClick={() => void onFetchModels()}
                    disabled={fetchingModels}
                    title="按上面的 Base URL 请求 /models，拉取该服务商可用模型"
                  >
                    {fetchingModels ? (
                      <Loader2 size={12} className="weq-spin" />
                    ) : (
                      <DownloadCloud size={12} />
                    )}
                    拉取可用模型
                  </button>
                  <button
                    type="button"
                    className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
                    onClick={addModel}
                  >
                    <Plus size={12} /> 手动添加
                  </button>
                </div>
              </div>

              {fetchedModels ? (
                <div className="weq-provider-fetched">
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                      fontSize: 12,
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>拉取到 {fetchedModels.length} 个模型</span>
                    <span style={{ opacity: 0.7 }}>勾选要导入的（已添加的会跳过）</span>
                    <span style={{ flex: 1 }} />
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
                      onClick={() =>
                        setCheckedModelIds(
                          checkedModelIds.length === fetchedModels.length
                            ? []
                            : fetchedModels.map((m) => m.id),
                        )
                      }
                    >
                      {checkedModelIds.length === fetchedModels.length ? (
                        <Square size={12} aria-hidden="true" />
                      ) : (
                        <CheckCheck size={12} aria-hidden="true" />
                      )}
                      {checkedModelIds.length === fetchedModels.length ? '全不选' : '全选'}
                    </button>
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-sm"
                      onClick={importFetchedModels}
                      disabled={checkedModelIds.length === 0}
                    >
                      <Plus size={12} /> 导入选中 ({checkedModelIds.length})
                    </button>
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
                      onClick={() => {
                        setFetchedModels(null);
                        setCheckedModelIds([]);
                      }}
                      aria-label="关闭模型拉取结果"
                      title="关闭模型拉取结果"
                    >
                      <X size={12} />
                    </button>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 6,
                      maxHeight: 180,
                      overflowY: 'auto',
                    }}
                  >
                    <CheckPillGroup
                      options={fetchedModels.map((model) => ({ value: model.id, label: model.id }))}
                      selected={checkedModelIds}
                      onChange={setCheckedModelIds}
                    />
                  </div>
                </div>
              ) : null}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {form.models.length === 0 ? (
                  <div className="weq-set-row-desc" style={{ padding: '6px 0' }}>
                    还没有模型，点上方按钮添加。
                  </div>
                ) : (
                  form.models.map((model, index) => (
                    <div key={model.rowKey} className="weq-provider-model-row">
                      <input
                        className="weq-set-input weq-provider-model-id"
                        aria-label={`模型 ${index + 1} ID`}
                        value={model.id}
                        onChange={(e) => updateModel(index, { id: e.target.value })}
                        onBlur={() => inspectModels(formRef.current, [model.rowKey])}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            event.currentTarget.blur();
                          }
                        }}
                        placeholder="模型 id，如 deepseek-ai/DeepSeek-V3"
                      />
                      <input
                        className="weq-set-input weq-provider-model-reasoning"
                        aria-label={`模型 ${index + 1} 思考档位`}
                        placeholder={
                          model.metadata?.reasoning.supported === false
                            ? '不支持思考'
                            : model.metadata?.reasoning.controls.length
                              ? model.metadata.reasoning.controls
                                  .map((control) =>
                                    control.kind === 'toggle'
                                      ? `开关：${control.values?.join(', ') ?? '支持'}`
                                      : control.kind === 'budget'
                                        ? `预算：${control.min ?? '?'}–${control.max ?? '?'}`
                                        : control.kind === 'adaptive'
                                          ? '自适应思考'
                                          : '思考档位（逗号分隔）',
                                  )
                                  .join('；')
                              : '思考档位（未知）'
                        }
                        title={
                          model.metadata
                            ? `${model.metadata.reasoning.controls.map((control) => `${control.kind}：${control.values?.join(', ') ?? ''}${control.default === undefined ? '' : `；默认 ${control.default}`}`).join('\n') || '思考控制未知'}\n手动填写命名档位，以逗号分隔；留空不声明档位。`
                            : '思考控制未知；可手动填写命名档位，以逗号分隔'
                        }
                        value={
                          model.reasoningEffortsText ??
                          (model.overrides?.reasoning
                            ? model.reasoningEfforts?.join(', ')
                            : (model.metadata?.reasoning.controls
                                .find((control) => control.kind === 'effort')
                                ?.values?.join(', ') ?? model.reasoningEfforts?.join(', '))) ??
                          ''
                        }
                        onChange={(event) =>
                          updateModel(index, {
                            reasoningEffortsText: event.target.value,
                          })
                        }
                      />
                      <button
                        type="button"
                        className="weq-set-iconbtn weq-provider-model-remove"
                        onClick={() => removeModel(index)}
                        aria-label={`删除模型 ${index + 1}`}
                        title={`删除模型 ${index + 1}`}
                      >
                        <X size={14} />
                      </button>
                      <button
                        type="button"
                        className="weq-set-iconbtn weq-provider-model-detect"
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={() =>
                          inspectModels(formRef.current, [model.rowKey], undefined, true)
                        }
                        disabled={
                          detectingModel !== null || !model.id.trim() || !form.baseUrl.trim()
                        }
                        aria-label={`检测模型 ${index + 1} 能力与思考`}
                        aria-busy={detectingModel === index}
                        title={[
                          detectingModel === index
                            ? '检测中'
                            : '读取模型元数据并探测缺失的能力与思考信息',
                          ...CAPABILITIES.map(
                            ({ value, label }) =>
                              `${label}：${model.metadata?.capabilities[value] === 'supported' ? '服务商声明支持或已验证' : model.metadata?.capabilities[value] === 'unsupported' ? '不支持' : '未知'}`,
                          ),
                          ...(model.probe ?? []).map(
                            (result) =>
                              `${CAPABILITIES.find((item) => item.value === result.capability)?.label}：${result.status === 'supported' ? '已验证' : result.status === 'unsupported' ? '不支持' : '未确定'}；${result.detail}`,
                          ),
                          model.reasoningProbe?.detail,
                          model.metadata?.error,
                        ]
                          .filter(Boolean)
                          .join('\n')}
                      >
                        {detectingModel === index ? (
                          <Loader2 size={12} className="weq-spin" />
                        ) : (
                          <FlaskConical size={12} />
                        )}
                      </button>
                      <div
                        className="weq-search-scope weq-provider-model-capabilities"
                        role="group"
                        aria-label={`模型 ${index + 1} 能力`}
                      >
                        {CAPABILITIES.map(({ value, label, Icon }) => (
                          <button
                            key={value}
                            type="button"
                            aria-pressed={model.capabilities.includes(value)}
                            onClick={() =>
                              updateModel(
                                index,
                                {
                                  capabilities: model.capabilities.includes(value)
                                    ? model.capabilities.filter((item) => item !== value)
                                    : [...model.capabilities, value],
                                },
                                value,
                              )
                            }
                          >
                            <Icon size={14} aria-hidden />
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </fieldset>

            <div className="weq-provider-modal-actions">
              <button
                type="button"
                className="weq-set-btn"
                onClick={() => void onSave()}
                disabled={saveProvider.isLoading || detectingModel !== null}
              >
                <Save size={14} />
                保存服务商
              </button>
              <button
                type="button"
                className="weq-set-btn weq-set-btn-soft"
                onClick={() => void onTest()}
                disabled={testing || detectingModel !== null}
              >
                {testing ? <Loader2 size={14} className="weq-spin" /> : <FlaskConical size={14} />}
                测试连通性
              </button>
              <button
                type="button"
                className="weq-set-btn weq-set-btn-soft"
                onClick={() => void onDelete()}
                disabled={!selectedId || deleteProvider.isLoading || detectingModel !== null}
              >
                <Trash2 size={14} />
                删除
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
