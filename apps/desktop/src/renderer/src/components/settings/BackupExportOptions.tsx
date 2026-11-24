import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { WeqBackupSection, WeqSelectiveBackup } from '@weq/service/backup-client';
import { Row, Toggle } from './controls';
import { usePrivacyStore } from '../../state/privacy';
import type { backupApi } from './BackupSection.shared';

type Inventory = Awaited<ReturnType<typeof backupApi.inventory>>;
type Account = Inventory['accounts'][number];

export const BACKUP_SECTION_LABELS: Record<WeqBackupSection, string> = {
  appearance: '外观与显示',
  preferences: '日常功能偏好',
  account: '账号与会话偏好',
  models: 'API 模型与语音服务',
  services: 'WeQ 服务与外部连接',
  database: 'QQ 数据库接入配置',
  layout: '当前设备的界面布局',
  paths: '自定义目录',
  device: '启动、应用锁与诊断偏好',
  drafts: '未发送草稿',
  assistant: 'WeQ 助手会话与报告',
  clones: '克隆体与对话',
};

const descriptions: Record<WeqBackupSection, string> = {
  appearance: '主题、背景、主页、名片显示和共享装扮。',
  preferences: '通知、角标、隐私模式、聊天、空间、邮箱、媒体加载和 AI 功能偏好。',
  account: '指定会话的提醒、防撤回、隐藏输入状态、群关键词和装扮。',
  models: '模型和语音服务商、默认模型、输出长度和音色。',
  services: 'Web、Remote、QQ 代理、MCP、OneBot、SSE、公众号推送及外部 rKey。',
  database: '包含数据库密钥及解密参数。',
  layout: '当前设备的侧栏宽度、输入区尺寸和工具位置。',
  paths: '导出、录音、图片及缓存等目录。',
  device: '开机启动、窗口行为、应用锁和调试设置。',
  drafts: 'WeQ 已保存的草稿正文及图片。',
  assistant: '助手对话、运行记录及生成的报告。',
  clones: '克隆体、对话、记忆、表情和参考语音。',
};

export function createBackupSelection(inventory: Inventory): WeqSelectiveBackup {
  const active = inventory.accounts.find(({ configId }) => configId === inventory.activeConfigId);
  return {
    sections: ['appearance', 'preferences', ...(active ? ['account' as const] : [])],
    accountConfigIds: active ? [active.configId] : [],
    databaseConfigIds: [],
    draftConfigIds: [],
    cloneConfigIds: [],
    includeApiKeys: false,
    includeServiceTokens: false,
  };
}

export function canExportBackup(selection: WeqSelectiveBackup) {
  const { sections } = selection;
  return (
    sections.length > 0 &&
    (!sections.includes('account') || selection.accountConfigIds.length > 0) &&
    (!sections.includes('database') || selection.databaseConfigIds.length > 0) &&
    (!sections.includes('drafts') || selection.draftConfigIds.length > 0) &&
    (!(sections.includes('assistant') || sections.includes('clones')) ||
      selection.cloneConfigIds.length > 0)
  );
}

export function selectedBackupSecrets(selection: WeqSelectiveBackup): string[] {
  return [
    selection.sections.includes('database') && selection.databaseConfigIds.length
      ? '数据库密钥'
      : '',
    selection.sections.includes('models') && selection.includeApiKeys ? 'API Key' : '',
    selection.sections.includes('services') && selection.includeServiceTokens ? '服务令牌' : '',
  ].filter(Boolean);
}

export function BackupAccountName({ account }: { account: Account }) {
  const privacy = usePrivacyStore((state) => state.effective);
  return (
    <>
      {privacy
        ? '账号已隐藏'
        : account.displayName === account.uin
          ? account.uin
          : `${account.displayName} · ${account.uin}`}
      <small className="weq-set-row-desc">
        {account.static ? '静态备份' : 'QQ 账号'}
        {account.dataDir && !privacy ? ` · ${account.dataDir}` : null}
      </small>
    </>
  );
}

function AccountChoices({
  accounts,
  picked,
  onChange,
}: {
  accounts: Account[];
  picked: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <div className="weq-backup-choice-details">
      {accounts.map((account) => (
        <label key={account.configId} className="weq-backup-account-choice">
          <input
            type="checkbox"
            checked={picked.includes(account.configId)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...picked, account.configId]
                  : picked.filter((id) => id !== account.configId),
              )
            }
          />
          <span>
            <BackupAccountName account={account} />
          </span>
        </label>
      ))}
    </div>
  );
}

export function BackupDisclosure({ children }: { children: ReactNode }) {
  return (
    <summary className="weq-disclosure-summary">
      <ChevronRight className="weq-disclosure-chevron" size={14} aria-hidden />
      <span>{children}</span>
    </summary>
  );
}

function BackupOption({
  id,
  checked,
  onChange,
  disabled,
  children,
}: {
  id: WeqBackupSection;
  checked: boolean;
  onChange: (enabled: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const label = BACKUP_SECTION_LABELS[id];
  return (
    <div className="weq-backup-option">
      <Row
        label={label}
        desc={descriptions[id]}
        control={<Toggle label={label} checked={checked} disabled={disabled} onChange={onChange} />}
      />
      {children}
    </div>
  );
}

export function BackupExportOptions({
  inventory,
  selection,
  onChange,
  disabled,
}: {
  inventory: Inventory;
  selection: WeqSelectiveBackup;
  onChange: (value: WeqSelectiveBackup) => void;
  disabled: boolean;
}) {
  const { sections } = selection;
  const enabled = (id: WeqBackupSection) => sections.includes(id);
  const accounts = inventory.accounts;
  const deviceCount = sections.filter((section) =>
    ['layout', 'paths', 'device'].includes(section),
  ).length;
  const agentCount = sections.filter(
    (section) => section === 'assistant' || section === 'clones',
  ).length;
  const cloneAccounts = inventory.cloneScopes.map(
    (configId) =>
      accounts.find((account) => account.configId === configId) ?? {
        configId,
        uin: configId.split('_')[0]!,
        displayName: configId,
        static: configId.includes('_'),
      },
  );
  const switchSection = (id: WeqBackupSection, checked: boolean) => {
    onChange({
      ...selection,
      sections: checked ? [...sections, id] : sections.filter((section) => section !== id),
    });
  };
  const toggle = (id: WeqBackupSection) => ({
    id,
    checked: enabled(id),
    onChange: (value: boolean) => switchSection(id, value),
    disabled,
  });
  const scoped = (
    id: 'account' | 'database' | 'drafts',
    key: 'accountConfigIds' | 'databaseConfigIds' | 'draftConfigIds',
  ) => (
    <BackupOption {...toggle(id)} disabled={disabled || accounts.length === 0}>
      {enabled(id) ? (
        <details open={selection[key].length === 0 || undefined}>
          <BackupDisclosure>
            {selection[key].length ? `已选 ${selection[key].length} 个数据来源` : '选择数据来源'}
          </BackupDisclosure>
          <AccountChoices
            accounts={accounts}
            picked={selection[key]}
            onChange={(ids) => onChange({ ...selection, [key]: ids })}
          />
        </details>
      ) : null}
    </BackupOption>
  );

  return (
    <fieldset className="weq-backup-options" disabled={disabled}>
      <BackupOption {...toggle('appearance')} />
      <BackupOption {...toggle('preferences')} />
      {scoped('account', 'accountConfigIds')}
      <BackupOption {...toggle('models')}>
        {enabled('models') ? (
          <label className="weq-backup-account-choice weq-backup-choice-details">
            <input
              type="checkbox"
              checked={selection.includeApiKeys}
              onChange={(event) => onChange({ ...selection, includeApiKeys: event.target.checked })}
            />
            包含 API Key
          </label>
        ) : null}
      </BackupOption>
      <BackupOption {...toggle('services')}>
        {enabled('services') ? (
          <label className="weq-backup-account-choice weq-backup-choice-details">
            <input
              type="checkbox"
              checked={selection.includeServiceTokens}
              onChange={(event) =>
                onChange({ ...selection, includeServiceTokens: event.target.checked })
              }
            />
            包含服务令牌
          </label>
        ) : null}
      </BackupOption>
      {scoped('database', 'databaseConfigIds')}
      <details className="weq-backup-option">
        <BackupDisclosure>
          本机设置与布局{deviceCount ? ` · 已选 ${deviceCount} 项` : ''}
        </BackupDisclosure>
        <div className="weq-backup-choice-details">
          <BackupOption {...toggle('layout')} />
          <BackupOption {...toggle('paths')} />
          <BackupOption {...toggle('device')} />
        </div>
      </details>
      {scoped('drafts', 'draftConfigIds')}
      <details className="weq-backup-option">
        <BackupDisclosure>
          助手与克隆数据{agentCount ? ` · 已选 ${agentCount} 项` : ''}
        </BackupDisclosure>
        <div className="weq-backup-choice-details">
          <BackupOption
            {...toggle('assistant')}
            disabled={disabled || cloneAccounts.length === 0}
          />
          <BackupOption {...toggle('clones')} disabled={disabled || cloneAccounts.length === 0} />
          {enabled('assistant') || enabled('clones') ? (
            <AccountChoices
              accounts={cloneAccounts}
              picked={selection.cloneConfigIds}
              onChange={(cloneConfigIds) => onChange({ ...selection, cloneConfigIds })}
            />
          ) : null}
          {!cloneAccounts.length ? <p className="weq-set-note">暂无助手或克隆数据。</p> : null}
        </div>
      </details>
    </fieldset>
  );
}
