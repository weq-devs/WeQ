import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { snapshotWeqClones, relocateWeqCloneAssets } from '../src/bootstrap/backup_clones';
import { buildWeqBackup, readWeqBackup, summarizeWeqBackup } from '../src/bootstrap/backup_bundle';

const roots: string[] = [];
const scope = '10001_1234abcd';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJRkAAAAASUVORK5CYII=',
  'base64',
);
const wav = Buffer.alloc(46);
wav.write('RIFF', 0);
wav.writeUInt32LE(38, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24);
wav.writeUInt32LE(32000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(2, 40);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-clone-backup-'));
  roots.push(root);
  const agentlab = join(root, 'agentlab');
  const account = join(agentlab, scope);
  for (const dir of [
    account,
    join(account, 'stickers'),
    join(account, 'voice'),
    join(account, 'agentvoice'),
  ])
    mkdirSync(dir, { recursive: true });
  return { root, agentlab, account };
}
function save(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value));
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('共享账号目录中的助手状态与报告一并快照，可直接打包校验', () => {
  const f = fixture();
  mkdirSync(join(f.account, 'assistant_runs'));
  mkdirSync(join(f.account, 'reports'));
  save(join(f.account, 'assistant.json'), {
    model: { providerId: 'synthetic', model: 'synthetic' },
  });
  save(join(f.account, 'assistant_sessions.json'), [
    { id: 'synthetic-session', title: '合成会话' },
  ]);
  save(join(f.account, 'assistant_runs', 'synthetic-session.json'), {
    schemaVersion: 1,
    sessionId: 'synthetic-session',
    messages: [],
  });
  writeFileSync(join(f.account, 'reports', '合成报告-synthetic.html'), '<h1>合成内容</h1>');
  const snapshot = snapshotWeqClones(f.agentlab);
  expect(snapshot.files).toHaveLength(4);
  expect(readWeqBackup(buildWeqBackup(snapshot.files)).files).toHaveLength(4);
  expect(readFileSync(join(f.account, 'reports', '合成报告-synthetic.html'), 'utf8')).toBe(
    '<h1>合成内容</h1>',
  );
});

it('外部 MP3 参考语音保留真实格式，不误写成 WAV', () => {
  const f = fixture();
  const mp3 = Buffer.from('49443304000000000000', 'hex');
  const source = join(f.root, 'external.mp3');
  writeFileSync(source, mp3);
  save(join(f.account, 'synthetic-persona.json'), {
    persona: {
      id: 'synthetic-persona',
      name: '合成克隆',
      voiceProfile: { refClips: [{ path: source, text: '合成文字' }] },
    },
    pairs: [],
  });
  const snapshot = snapshotWeqClones(f.agentlab);
  const voice = snapshot.files.find((file) => file.path.includes('/voice/'))!;
  expect(voice.path.endsWith('.mp3')).toBe(true);
  expect(voice.data).toEqual(mp3);
  expect(readWeqBackup(buildWeqBackup(snapshot.files)).files).toHaveLength(2);
});

describe('克隆备份的真实文件与资产关系', () => {
  it('保留会话、记忆和生成语音，外部表情／参考语音变为包内相对引用且原件不变', () => {
    const f = fixture();
    const image = join(f.root, 'external-image.png');
    const voice = join(f.root, 'external-voice.wav');
    writeFileSync(image, png);
    writeFileSync(voice, wav);
    const personaPath = join(f.account, 'persona.json');
    const original = {
      persona: {
        id: 'persona',
        stickers: [{ md5: 'abcd', localPath: image }],
        voiceProfile: { refClips: [{ path: voice, text: '保留转录文本', durationMs: 1 }] },
      },
      pairs: [{ text: '保留原始样本' }],
    };
    save(personaPath, original);
    save(join(f.account, 'usage.json'), []);
    save(join(f.account, 'memories.json'), { persona: [{ text: '合成记忆' }] });
    save(join(f.account, 'conversations.json'), {
      persona: [{ role: 'user', text: '合成对话', ts: 1 }],
    });
    writeFileSync(
      join(f.account, 'agentvoice', 'abcd.mp3'),
      Buffer.from('49443304000000000000', 'hex'),
    );
    const snapshot = snapshotWeqClones(f.agentlab);
    expect(snapshot.warnings).toEqual([]);
    const bundle = readWeqBackup(buildWeqBackup(snapshot.files));
    expect(summarizeWeqBackup(bundle).warnings).toEqual([]);
    expect(bundle.files.some((file) => file.path.endsWith('/memories.json'))).toBe(true);
    expect(bundle.files.some((file) => file.path.endsWith('/conversations.json'))).toBe(true);
    expect(bundle.files.some((file) => file.path.endsWith('/agentvoice/abcd.mp3'))).toBe(true);
    const file = bundle.files.find((file) => file.path.endsWith('/persona.json'))!;
    const portable = JSON.parse(file.data.toString());
    expect(portable.persona.stickers[0].localPath).toMatch(/^stickers\/[0-9a-f]{64}\.png$/);
    expect(portable.persona.voiceProfile.refClips[0].path).toMatch(/^voice\/[0-9a-f]{64}\.wav$/);
    expect(portable.pairs).toEqual(original.pairs);
    const destination = join(f.root, 'restored');
    const relocated = JSON.parse(relocateWeqCloneAssets(file, destination).data.toString());
    expect(relocated.persona.stickers[0].localPath).toBe(
      join(destination, scope, portable.persona.stickers[0].localPath),
    );
    expect(relocated.persona.voiceProfile.refClips[0].text).toBe('保留转录文本');
    expect(JSON.parse(readFileSync(personaPath, 'utf8'))).toEqual(original);
    expect(readFileSync(image)).toEqual(png);
    expect(readFileSync(voice)).toEqual(wav);
  });

  it('本来就在克隆目录的资产只收一次，不制造哈希命名的大副本', () => {
    const f = fixture();
    const image = join(f.account, 'stickers', 'abcd.png');
    const voice = join(f.account, 'voice', 'abcd.wav');
    writeFileSync(image, png);
    writeFileSync(voice, wav);
    save(join(f.account, 'persona.json'), {
      persona: {
        id: 'persona',
        stickers: [{ md5: 'abcd', localPath: image }],
        voiceProfile: { refClips: [{ path: voice }] },
      },
      pairs: [],
    });
    const snapshot = snapshotWeqClones(f.agentlab);
    expect(snapshot.files).toHaveLength(3);
    expect(snapshot.files.filter((file) => file.path.includes('/stickers/'))).toHaveLength(1);
    expect(snapshot.files.filter((file) => file.path.includes('/voice/'))).toHaveLength(1);
    expect(summarizeWeqBackup(readWeqBackup(buildWeqBackup(snapshot.files))).warnings).toEqual([]);
  });

  it('缺失资产明确反馈，参考语音的文本等独有元数据仍保留', () => {
    const f = fixture();
    save(join(f.account, 'persona.json'), {
      persona: {
        id: 'persona',
        stickers: [{ md5: 'abcd', localPath: join(f.root, 'missing.png') }],
        voiceProfile: {
          refClips: [{ path: join(f.root, 'missing.wav'), text: '不能丢弃的转录', score: 1 }],
        },
      },
      pairs: [],
    });
    const snapshot = snapshotWeqClones(f.agentlab);
    expect(snapshot.warnings).toHaveLength(2);
    const bundle = readWeqBackup(buildWeqBackup(snapshot.files));
    expect(summarizeWeqBackup(bundle).warnings).toHaveLength(1);
    const persona = JSON.parse(bundle.files[0]!.data.toString()).persona;
    expect(persona.voiceProfile.refClips[0].text).toBe('不能丢弃的转录');
    expect(persona.voiceProfile.refClips[0].score).toBe(1);
    expect(persona.voiceProfile.refClips[0].path).not.toContain(f.root);
  });

  it('不把同目录 QQ 数据库、机器人运行凭据或模型装进备份', () => {
    const f = fixture();
    save(join(f.account, 'persona.json'), { persona: { id: 'persona' }, pairs: [] });
    const db = join(f.account, 'nt_msg.db');
    writeFileSync(db, 'SQLite format 3\0synthetic');
    save(join(f.account, 'bot_exports.json'), { key: 'synthetic-server-token' });
    writeFileSync(join(f.account, 'voice', 'weights.bin'), 'synthetic-model');
    const snapshot = snapshotWeqClones(f.agentlab);
    expect(snapshot.files.map((file) => file.path)).toEqual([`clones/${scope}/persona.json`]);
    expect(snapshot.warnings).toHaveLength(1);
    expect(readFileSync(db, 'utf8')).toContain('SQLite format 3');
  });

  it('伪装成克隆资产的数据库内容仍被拒绝', () => {
    const f = fixture();
    writeFileSync(join(f.account, 'stickers', 'abcd.png'), 'SQLite format 3\0synthetic');
    expect(() => snapshotWeqClones(f.agentlab)).toThrow('图片');
  });

  it('不跟随文件或目录中的链接，也不接受越界账号标识', () => {
    const f = fixture();
    const image = join(f.root, 'external.png');
    writeFileSync(image, png);
    symlinkSync(image, join(f.account, 'stickers', 'abcd.png'));
    expect(() => snapshotWeqClones(f.agentlab)).toThrow('普通文件');
    expect(() => snapshotWeqClones(f.agentlab, ['../outside'])).toThrow('标识');
    expect(readFileSync(image)).toEqual(png);
    const other = '10002';
    symlinkSync(f.account, join(f.agentlab, other), 'dir');
    expect(() => snapshotWeqClones(f.agentlab, [other])).toThrow('普通目录');
  });

  it.each([
    '/private/secret.wav',
    '../secret.wav',
    'voice/../../secret.wav',
    'voice\\abcd.wav',
    'stickers/abcd.png',
  ])('恢复参考语音不接受目标 %s', (path) => {
    const file = {
      path: `clones/${scope}/persona.json`,
      data: Buffer.from(
        JSON.stringify({
          persona: { id: 'persona', voiceProfile: { refClips: [{ path }] } },
          pairs: [],
        }),
      ),
    };
    expect(() => relocateWeqCloneAssets(file, '/synthetic/agentlab')).toThrow();
    expect(() => buildWeqBackup([file])).toThrow();
  });

  it('只读选择的账号；缺少目录不创建替代数据', () => {
    const f = fixture();
    save(join(f.account, 'persona.json'), { persona: { id: 'persona' }, pairs: [] });
    expect(snapshotWeqClones(f.agentlab, ['10002']).files).toEqual([]);
    expect(snapshotWeqClones(join(f.root, 'missing')).files).toEqual([]);
    expect(snapshotWeqClones(f.agentlab, [scope]).files).toHaveLength(1);
  });
});
