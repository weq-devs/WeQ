/**
 * `csrutil status` 输出解析测试 —— 只喂样本字符串，不执行任何命令。
 *
 * 判定错了的代价是不对称的：
 *   - 把「开着」读成 `null`/`false` → 用户被要一次密码、再等一次注定失败的读取；
 *   - 把「关着」读成 `true` → 明明能读却被我们自己拦下，功能直接消失。
 *
 * 所以 `null` 只允许出现在**真的问不出来**时（非 macOS、没有 csrutil、输出不认识）
 * —— 绝不能靠猜。
 */

import { describe, expect, it } from 'vitest';
import { parseSipStatus } from '../src/darwin/sip';

describe('parseSipStatus', () => {
  it('reads the summary line for the two known states', () => {
    expect(parseSipStatus('System Integrity Protection status: enabled.\n')).toBe(true);
    expect(parseSipStatus('System Integrity Protection status: disabled.\n')).toBe(false);
  });

  it('ignores case and the detail lines that follow the summary', () => {
    const enabled = [
      'System Integrity Protection status: enabled.',
      '',
      'Configuration:',
      '\tApple Internal: disabled',
      '\tKext Signing: enabled',
      '',
    ].join('\n');
    expect(parseSipStatus(enabled)).toBe(true);

    const disabled = [
      'System Integrity Protection status: disabled.',
      '',
      'Configuration:',
      '\tApple Internal: enabled',
      '\tKext Signing: disabled',
      '',
    ].join('\n');
    expect(parseSipStatus(disabled)).toBe(false);
  });

  it('does not let per-area detail lines decide the answer', () => {
    // 整体关着、但某项明细写着 enabled —— 按明细猜就会判反。
    const output = [
      'System Integrity Protection status: disabled.',
      'Filesystem Protections: enabled',
      'Kext Signing: enabled',
    ].join('\n');
    expect(parseSipStatus(output)).toBe(false);
  });

  it('returns null for unknown words and unrelated output', () => {
    expect(parseSipStatus('System Integrity Protection status: unknown')).toBeNull();
    expect(parseSipStatus('csrutil: command not found')).toBeNull();
    expect(parseSipStatus('')).toBeNull();
  });
});
