/**
 * native 产物能力检查的回归。
 *
 * 背景：`nt_helper.node` 不入库，每个平台各自下载。只要某个平台的产物比源码旧，
 * 宽容链路调用时得到的就是 `undefined is not a function` —— 用户开级别、什么都
 * 没变化，日志里也看不出\"这份产物缺接口\"。本文件钉住两件事：
 *
 *  1. **缺接口时的报错要能照着做**：点名缺了哪几个，并给出取产物的命令；
 *  2. **严格模式不受影响**：级别 0 的读取一次都不碰这些新接口，所以旧产物上
 *     \"不开宽容也能正常用\"这条底线必须继续成立。
 */

import { describe, expect, it } from 'vitest';
import {
  SALVAGE_BINDING_METHODS,
  assertSalvageCapable,
  iterateSalvageWindows,
  missingSalvageMethods,
  runSalvageScan,
  wrapBindingForSalvage,
} from '@weq/db';
import type { DatabaseAlgorithms, NtHelperBinding, SqlRow } from '@weq/native';

const DB = '/x/nt_msg.db';
const ALGO = { pageHmacAlgorithm: 'x', kdfHmacAlgorithm: 'y' } as unknown as DatabaseAlgorithms;

/** 一个\"旧产物\"：只有核心查询，一个 salvage 接口都没有。 */
function oldBinding(): NtHelperBinding {
  return {
    executeSql: (): Promise<SqlRow[]> => Promise.resolve([[1n]]),
    executeSqlWithKey: (): Promise<SqlRow[]> => Promise.resolve([[1n]]),
  } as unknown as NtHelperBinding;
}

/** 完整产物：只把清单里的方法补齐成可调用桩。 */
function fullBinding(): NtHelperBinding {
  const bag: Record<string, unknown> = {
    executeSql: (): Promise<SqlRow[]> => Promise.resolve([]),
    executeSqlWithKey: (): Promise<SqlRow[]> => Promise.resolve([]),
  };
  for (const name of SALVAGE_BINDING_METHODS) bag[name] = () => undefined;
  return bag as unknown as NtHelperBinding;
}

describe('native 产物能力检查', () => {
  it('完整产物什么都不缺', () => {
    expect(missingSalvageMethods(fullBinding())).toEqual([]);
    expect(() => assertSalvageCapable(fullBinding(), '分块扫描')).not.toThrow();
  });

  it('旧产物会把缺的接口一个不落地列出来', () => {
    expect(missingSalvageMethods(oldBinding())).toEqual([...SALVAGE_BINDING_METHODS]);
    // 只校验马上要用到的那几个时，不该把无关接口也算成缺失。
    expect(missingSalvageMethods(oldBinding(), ['scanBadPages'])).toEqual(['scanBadPages']);
  });

  it('报错要点名缺失接口并给出取产物的命令', () => {
    expect(() => assertSalvageCapable(oldBinding(), '分块容错扫描')).toThrow(/不支持分块容错扫描/);
    try {
      assertSalvageCapable(oldBinding(), '分块容错扫描', ['executeSqlSalvageScan']);
      throw new Error('应当抛错');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('executeSqlSalvageScan');
      expect(message).toContain('native:fetch');
      expect(message).toContain('严格通道');
      // 只点被校验的那一个，不把整套清单糊到用户脸上。
      expect(message).not.toContain('scanBadPages');
    }
  });

  it('旧产物 + 级别 2：分块扫描报"去取产物"，而不是 undefined is not a function', async () => {
    await expect(
      runSalvageScan(
        oldBinding(),
        { dbPath: DB },
        'SELECT rowid FROM t WHERE rowid > ?1 AND rowid <= ?2',
        { lo: 0n, hi: 10n },
        { level: () => 2 },
      ),
    ).rejects.toThrow(/native:fetch/);
  });

  it('旧产物 + 级别 1：走宽容读查询时也报同一条可照做的错误', async () => {
    const wrapped = wrapBindingForSalvage(oldBinding(), { level: () => 1 });
    await expect(wrapped.executeSql(DB, 'SELECT 1', null)).rejects.toThrow(/native:fetch/);
  });

  it('旧产物 + 严格模式：一切照旧，绝不因为缺接口而挡住普通读取', async () => {
    // 这条是底线：宽容是可选能力，没取到新产物时\"不开宽容也能用\"必须成立。
    const wrapped = wrapBindingForSalvage(oldBinding(), { level: () => 0 });
    await expect(wrapped.executeSql(DB, 'SELECT 1', null)).resolves.toEqual([[1n]]);
    await expect(wrapped.executeSqlWithKey(DB, 'SELECT 1', 'k', ALGO, null)).resolves.toEqual([
      [1n],
    ]);
    expect(missingSalvageMethods(oldBinding()).length).toBeGreaterThan(0);
  });

  it('旧产物 + 级别 < 2：分块驱动的"未授权"错误优先，不会误报成产物问题', async () => {
    const gen = iterateSalvageWindows({
      nt: oldBinding(),
      target: { dbPath: DB },
      sql: 'SELECT rowid FROM t WHERE rowid > ?1 AND rowid <= ?2',
      plan: { lo: 0n, hi: 10n, chunk: 4 },
      opts: { level: () => 1 },
    });
    await expect(gen.next()).rejects.toThrow(/宽容级别 ≥ 2/);
  });
});
