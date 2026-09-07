/**
 * 一组小而关键的纯函数单测：频道头像 URL 规则、文件分类、账号配置迁移。
 * 都是「输入输出一一对应、错了用户直接看得到」的那类。
 */

import { describe, expect, it } from 'vitest';
import { guildAvatarUrlFromMeta } from '../src/account/guild_direct';
import { classifyFile } from '../src/account/file_resource';
import { normalizeAccountConfig } from '../src/account/user_config';

describe('guildAvatarUrlFromMeta', () => {
  it('head=0：thirdqq oidb 头像（k-token 参数透传 + b/s 补齐）', () => {
    expect(guildAvatarUrlFromMeta('0#k-token&kti=abc#60#ts')).toBe(
      'https://thirdqq.qlogo.cn/g?b=oidb&k=k-token&kti=abc&s=0',
    );
  });

  it('head=1：qqchannel profile bucket', () => {
    expect(guildAvatarUrlFromMeta('1#uuid-xyz#31#ts')).toBe(
      'https://qqchannel-profile-1251316161.file.myqcloud.com/uuid-xyz/140',
    );
  });

  it.each([
    ['空串', ''],
    ['未知 head', '9#abc'],
    ['无 # 且非 0/1', 'plain'],
    ['head=0 但 seg 为空', '0#'],
  ])('%s → null', (_label, meta) => {
    expect(guildAvatarUrlFromMeta(meta)).toBeNull();
  });
});

describe('classifyFile', () => {
  it('已知扩展名 → 分类 + 图标', () => {
    expect(classifyFile('setup.exe')).toEqual({ category: 'program', icon: 'exe.png', ext: 'exe' });
    expect(classifyFile('报告.PDF')).toEqual({ category: 'document', icon: 'pdf.png', ext: 'pdf' });
  });

  it('未知扩展名 / 无扩展名 → other + unknown.png', () => {
    expect(classifyFile('x.weird')).toEqual({
      category: 'other',
      icon: 'unknown.png',
      ext: 'weird',
    });
    expect(classifyFile('noext')).toEqual({ category: 'other', icon: 'unknown.png', ext: '' });
  });
});

describe('normalizeAccountConfig', () => {
  it('旧记录：单 algo → algos.nt_msg.db 迁移', () => {
    const migrated = normalizeAccountConfig({
      configId: '123',
      uin: '123',
      dbKey: 'k',
      algo: { page: 1024 } as never,
      lastLoginAt: 0,
    } as never);
    expect(migrated.algos).toEqual({ 'nt_msg.db': { page: 1024 } });
    expect((migrated as { algo?: unknown }).algo).toBeDefined(); // 旧字段保留（浅拷贝）
  });

  it('无 algo 也无 algos → 空 algos', () => {
    const migrated = normalizeAccountConfig({
      configId: '123',
      uin: '123',
      dbKey: '',
      lastLoginAt: 0,
    } as never);
    expect(migrated.algos).toEqual({});
  });

  it('新记录：algos 原样透传', () => {
    const algos = { 'nt_msg.db': { page: 4096 } } as never;
    const raw = { configId: '1', uin: '1', dbKey: '', algos, lastLoginAt: 0 } as never;
    expect(normalizeAccountConfig(raw).algos).toBe(algos);
  });
});
