import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildZip, readZipEntries } from '../src/common/zip';
import {
  buildWeqBackup,
  readWeqBackup,
  summarizeWeqBackup,
  weqBackupPart,
  WEQ_BACKUP_LIMITS,
  WEQ_BACKUP_VERSION,
  type WeqBackupFile,
} from '../src/bootstrap/backup_bundle';

const at = '2026-10-22T04:30:00+08:00';
const json = (path: string, data: unknown): WeqBackupFile => ({
  path,
  data: Buffer.from(JSON.stringify(data)),
});
const scope = '10001_1234abcd';
const account = json(`accounts/${scope}.json`, {
  configId: scope,
  uin: '10001',
  dbKey: 'synthetic-key',
  algos: {},
  dataDir: '/synthetic/QQ',
  lastLoginAt: 1,
});
const clone = json(`clones/${scope}/persona-one.json`, {
  persona: { id: 'persona-one', name: '合成克隆体' },
  pairs: [],
});

function rewriteArchive(
  change: (entries: Array<{ name: string; data: Buffer }>) => void,
  source = buildWeqBackup([account, clone], at),
): Buffer {
  const entries = readZipEntries(source);
  change(entries);
  return buildZip(entries);
}

function rewriteManifest(change: (value: Record<string, unknown>) => void): Buffer {
  return rewriteArchive((entries) => {
    const metadata = entries.find((entry) => entry.name === 'manifest.json')!;
    const value: Record<string, unknown> = JSON.parse(metadata.data.toString());
    change(value);
    metadata.data = Buffer.from(JSON.stringify(value));
  });
}

describe('WeQ 版本化备份格式', () => {
  it('四个可选分区原样往返，摘要不回显凭据和克隆正文', () => {
    const files = [
      account,
      clone,
      json('settings/app.json', { renderTextMarkdown: false }),
      json('settings/client.json', { 'weq.theme-preference': 'dark' }),
      json('api/settings.json', { agentLab: { providers: [{ apiKey: 'synthetic-secret' }] } }),
      json(`clones/${scope}/usage.json`, []),
      {
        path: `clones/${scope}/stickers/0123abcd.png`,
        data: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
      },
      {
        path: `clones/${scope}/agentvoice/0123abcd.mp3`,
        data: Buffer.from('49443304000000000000', 'hex'),
      },
    ];
    const restored = readWeqBackup(buildWeqBackup(files, at));
    expect(restored.manifest.version).toBe(WEQ_BACKUP_VERSION);
    expect(restored.files).toHaveLength(files.length);
    for (const original of files)
      expect(restored.files.find((entry) => entry.path === original.path)?.data).toEqual(
        original.data,
      );
    const summary = summarizeWeqBackup(restored);
    expect(summary.createdAt).toBe(at);
    expect(summary.parts.map((part) => part.part)).toEqual([
      'settings',
      'accounts',
      'api',
      'clones',
    ]);
    expect(summary.accountConfigIds).toEqual([scope]);
    expect(summary.cloneConfigIds).toEqual([scope]);
    expect(JSON.stringify(summary)).not.toContain('synthetic-secret');
    expect(JSON.stringify(summary)).not.toContain('合成克隆体');
  });

  it.each([
    '../config.json',
    '/config.json',
    'C:/config.json',
    'clones/../config.json',
    'clones/10001/voice/../../nt_msg.db',
    'accounts/10001.json/extra',
    'clones/10001/nt_msg.db',
    'clones/10001/bot_exports.json',
    'config.json',
    'settings/unknown.json',
    'api/credentials.db',
    'clones/10001/voice/file.exe',
    'clones/10001/stickers/file.svg',
    'clones\\10001\\voice\\abcd.wav',
    'clones/10001/./voice/abcd.wav',
    'clones/10001/voice/abcd.wav:stream',
    'clones/10001/voice/abcd.wav\0',
    'clones/10001/CON.json',
    'clones/10001/reports/NUL.html',
    'clones/10001/reports/COM¹.txt',
  ])('拒绝非白名单路径 %s', (path) => {
    expect(() => weqBackupPart(path)).toThrow();
  });

  it.each([
    'usage.json',
    'conversations.json',
    'memories.json',
    'notes.json',
    'groups.json',
    'relations.json',
    'sessions.json',
    'group_session_messages.json',
    'assistant.json',
    'assistant_sessions.json',
  ])('接受真实克隆存储 %s 的结构', (name) => {
    const file = json(
      `clones/${scope}/${name}`,
      name === 'usage.json' || name === 'assistant_sessions.json' ? [] : {},
    );
    expect(readWeqBackup(buildWeqBackup([file], at)).files[0]?.data).toEqual(file.data);
  });

  it('包含助手配置、会话、断点与中文报告，不把报告当作图片或 persona', () => {
    const files = [
      json(`clones/${scope}/assistant.json`, {
        model: { providerId: 'synthetic', model: 'synthetic' },
      }),
      json(`clones/${scope}/assistant_sessions.json`, [
        { id: 'synthetic-session', title: '合成会话' },
      ]),
      json(`clones/${scope}/assistant_runs/synthetic-session.json`, {
        sessionId: 'synthetic-session',
        schemaVersion: 1,
        messages: [],
      }),
      {
        path: `clones/${scope}/reports/合成报告-synthetic.html`,
        data: Buffer.from('<h1>合成报告</h1>'),
      },
    ];
    const restored = readWeqBackup(buildWeqBackup(files));
    expect(restored.files).toHaveLength(files.length);
    for (const file of files)
      expect(restored.files.find((row) => row.path === file.path)?.data).toEqual(file.data);
    expect(() =>
      buildWeqBackup([
        { path: `clones/${scope}/reports/合成报告.html`, data: Buffer.from([0xff]) },
      ]),
    ).toThrow('UTF-8');
  });

  it('报告路径仍拒绝转向控制符和规范化后重名，防止跨平台覆盖', () => {
    expect(() => weqBackupPart(`clones/${scope}/reports/合成\u202e报告.html`)).toThrow('路径');
    expect(() =>
      buildWeqBackup([
        { path: `clones/${scope}/reports/é.html`, data: Buffer.from('synthetic') },
        { path: `clones/${scope}/reports/e\u0301.html`, data: Buffer.from('synthetic') },
      ]),
    ).toThrow('冲突');
  });

  it('群聊历史表情引用同样必须在包内，缺失时计入警告', () => {
    const messages = {
      messages: {
        g: [
          {
            actions: [
              { kind: 'sticker', sticker: { md5: 'abcd', localPath: 'stickers/abcd.png' } },
            ],
          },
        ],
      },
    };
    const payload = json(`clones/${scope}/groups.json`, messages);
    expect(
      summarizeWeqBackup(readWeqBackup(buildWeqBackup([payload]))).warnings.join(' '),
    ).toContain('groups.json');
    messages.messages.g[0]!.actions[0]!.sticker.localPath = '/synthetic/old-machine/abcd.png';
    expect(() => buildWeqBackup([json(payload.path, messages)])).toThrow('相对路径');
  });

  it('拒绝未知版本、损坏清单、未声明负载及缺失文件', () => {
    expect(() =>
      readWeqBackup(
        rewriteManifest((value) => {
          value.version = WEQ_BACKUP_VERSION + 1;
        }),
      ),
    ).toThrow('版本');
    expect(() =>
      readWeqBackup(
        rewriteManifest((value) => {
          value.files = null;
        }),
      ),
    ).toThrow('结构');
    expect(() =>
      readWeqBackup(
        rewriteManifest((value) => {
          value.createdAt = 'broken';
        }),
      ),
    ).toThrow('结构');
    expect(() =>
      readWeqBackup(
        rewriteArchive((entries) => {
          entries.push({ name: 'extra.txt', data: Buffer.from('extra') });
        }),
      ),
    ).toThrow('数量');
    expect(() =>
      readWeqBackup(
        rewriteArchive((entries) => {
          entries.pop();
        }),
      ),
    ).toThrow('数量');
  });

  it('在 ZIP 的 CRC 仍然匹配时也拒绝被替换的正文', () => {
    const modified = rewriteArchive((entries) => {
      const file = entries.find((entry) => entry.name === clone.path)!;
      file.data = Buffer.from(file.data.toString().replace('合成克隆体', '伪造克隆体'));
    });
    expect(() => readWeqBackup(modified)).toThrow('内容校验');
  });

  it('拒绝清单重复条目与大小写冲突，避免跨平台覆盖', () => {
    expect(() => buildWeqBackup([account, account])).toThrow('重复');
    const second = json(`clones/${scope}/Persona-one.json`, {
      persona: { id: 'Persona-one' },
      pairs: [],
    });
    expect(() => buildWeqBackup([clone, second])).toThrow('大小写');
    expect(() =>
      readWeqBackup(
        rewriteManifest((value) => {
          value.files = [
            value.files && (value.files as unknown[])[0],
            value.files && (value.files as unknown[])[0],
          ];
        }),
      ),
    ).toThrow('重复');
  });

  it.each([
    json('accounts/10001.json', {
      configId: '10002',
      uin: '10002',
      dbKey: '',
      algos: {},
      lastLoginAt: 1,
    }),
    json('accounts/10001.json', {
      configId: '10001',
      uin: '10002',
      dbKey: '',
      algos: {},
      lastLoginAt: 1,
    }),
    json('accounts/10001.json', {
      configId: '10001',
      uin: '10001',
      dbKey: '',
      algos: [],
      lastLoginAt: 1,
    }),
    json('clones/10001/persona.json', { persona: { id: 'other' }, pairs: [] }),
    json('clones/10001/persona.json', { persona: { id: 'persona' }, pairs: {} }),
    json('clones/10001/usage.json', {}),
    json('settings/app.json', []),
  ])('拒绝无效业务容器 $path', (file) => {
    expect(() => buildWeqBackup([file])).toThrow();
  });

  it('拒绝损坏 UTF-8、异常嵌套和原型属性，不把错误 JSON 交给恢复服务', () => {
    expect(() =>
      buildWeqBackup([{ path: 'settings/app.json', data: Buffer.from([0xff]) }]),
    ).toThrow('UTF-8');
    expect(() =>
      buildWeqBackup([
        { path: 'settings/app.json', data: Buffer.from('{"__proto__":{"bad":true}}') },
      ]),
    ).toThrow('属性');
    expect(() =>
      buildWeqBackup([
        {
          path: 'settings/app.json',
          data: Buffer.from(`{"nested":${'['.repeat(66)}0${']'.repeat(66)}}`),
        },
      ]),
    ).toThrow('复杂');
  });

  it('拒绝无清单、截断 ZIP、过多文件和空选择', () => {
    expect(() =>
      readWeqBackup(buildZip([{ name: 'something.json', data: Buffer.from('{}') }])),
    ).toThrow('缺少清单');
    expect(() => readWeqBackup(Buffer.from('broken'))).toThrow();
    expect(() => buildWeqBackup([])).toThrow('没有选择');
    expect(() =>
      buildWeqBackup(Array.from({ length: WEQ_BACKUP_LIMITS.maxEntries }, () => account)),
    ).toThrow('数量');
  });

  it('通过重新计算校验的畸形清单也不能引入任意目标文件', () => {
    const file = { name: 'nt_msg.db', data: Buffer.from('not-a-database') };
    const bytes = buildZip([
      {
        name: 'manifest.json',
        data: Buffer.from(
          JSON.stringify({
            format: 'weq-backup',
            version: WEQ_BACKUP_VERSION,
            createdAt: at,
            files: [
              {
                path: file.name,
                bytes: file.data.length,
                sha256: createHash('sha256').update(file.data).digest('hex'),
              },
            ],
          }),
        ),
      },
      file,
    ]);
    expect(() => readWeqBackup(bytes)).toThrow('不支持');
  });
});
