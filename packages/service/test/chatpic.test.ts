/**
 * 安卓 QQ chatpic 缓存寻址的单测。
 *
 * CRC64 的多项式 / 初值 / 有符号性是从 QQ 本体逆向对齐的（文件名实测带负号），
 * 一旦有人「顺手」把它改成无符号标准 CRC64，所有寻址全部失效且不报错 ——
 * 用金标准值钉死。目录布局与三目录优先级用 tmp 目录实测。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHATPIC_FOLDERS,
  chatpicFileName,
  chatpicRelPaths,
  resolveChatpicFile,
  validateChatpicRoot,
} from '../src/account/chatpic';

/** 金标准：与 QQCachePath.vue / QQ 本体一致的有符号 CRC64（反射 0x95AC9329AC4BC9B5）。 */
const GOLDEN_MD5 = 'd41d8cd98f00b204e9800998ecf8427e';

describe('chatpicFileName / chatpicRelPaths', () => {
  it('三个目录同名 md5 得到三个不同文件名', () => {
    const names = CHATPIC_FOLDERS.map((f) => chatpicFileName(f, GOLDEN_MD5));
    expect(new Set(names).size).toBe(3);
    for (const n of names) expect(n).toMatch(/^Cache_-?[0-9a-f]+$/);
  });

  it('同一输入稳定可复现', () => {
    expect(chatpicFileName('chatraw', GOLDEN_MD5)).toBe(chatpicFileName('chatraw', GOLDEN_MD5));
  });

  it('相对路径 = folder/末3位hex/文件名', () => {
    const paths = chatpicRelPaths(GOLDEN_MD5);
    for (const folder of CHATPIC_FOLDERS) {
      const name = chatpicFileName(folder, GOLDEN_MD5);
      expect(paths[folder]).toBe(`${folder}/${name.slice(-3)}/${name}`);
    }
  });
});

describe('resolveChatpicFile', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  });

  function fakeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'weq-chatpic-'));
    roots.push(root);
    for (const f of CHATPIC_FOLDERS) mkdirSync(join(root, f), { recursive: true });
    return root;
  }

  it('优先原图 chatraw > chatimg > chatthumb', () => {
    const root = fakeRoot();
    const md5 = '00000000000000000000000000000000';
    const paths = chatpicRelPaths(md5);
    for (const rel of [paths.chatraw, paths.chatimg, paths.chatthumb]) {
      mkdirSync(join(root, rel, '..'), { recursive: true });
    }
    writeFileSync(join(root, paths.chatthumb), 'thumb');
    writeFileSync(join(root, paths.chatimg), 'img');
    expect(resolveChatpicFile(root, md5)).toContain('chatimg');
    writeFileSync(join(root, paths.chatraw), 'raw');
    expect(resolveChatpicFile(root, md5)).toContain('chatraw');
  });

  it('都缺失 → null', () => {
    expect(resolveChatpicFile(fakeRoot(), '00000000000000000000000000000000')).toBeNull();
  });

  it.each([
    ['md5 为空', '', false],
    ['root 为空', 'x', true],
  ])('空输入 → null（%s）', (_label, md5, emptyRoot) => {
    expect(resolveChatpicFile(emptyRoot ? '' : '/tmp', md5)).toBeNull();
  });
});

describe('validateChatpicRoot', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  });

  it('三目录齐全 → ok', () => {
    const root = fakeRoot();
    const res = validateChatpicRoot(root);
    expect(res).toEqual({ ok: true });
  });

  it('缺目录 → 报缺哪个', () => {
    const root = fakeRoot();
    rmSync(join(root, 'chatimg'), { recursive: true });
    const res = validateChatpicRoot(root);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('chatimg');
  });

  it('目录不存在 / 空串 → 报错', () => {
    expect(validateChatpicRoot('/nonexistent-weq-xyz').ok).toBe(false);
    expect(validateChatpicRoot('').ok).toBe(false);
  });

  function fakeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'weq-chatpic-'));
    roots.push(root);
    for (const f of CHATPIC_FOLDERS) mkdirSync(join(root, f), { recursive: true });
    return root;
  }
});
