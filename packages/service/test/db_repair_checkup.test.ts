/**
 * 体检结论的单测（`concludeCheckup`）。
 *
 * 这里钉住的不是"算得对不对"，而是**会不会说错话** —— 面板上那句中文摘要就是给用户的
 * 结论，两种错法都很便宜：
 *
 *   1. 「页签名不可校验」被写成「完好」→ 用户以为没问题，于是不去修；
 *   2. 「结构检查没跑成」被写成「损坏」→ 白吓一跳，甚至去做了不该做的替换。
 *
 * 修复要重建 + 替换源库文件，所以"什么时候能说没问题"必须由测试守着。
 */

import { describe, expect, it } from 'vitest';
import {
  concludeCheckup,
  type DbRepairCheckupIntegrity,
  type DbRepairCheckupPages,
} from '../src/account/db_repair/checkup';
import type { BadPageScanReport } from '../src/account/bad_pages';

/** 一份页级报告；只写会用到的那几个字段，其余给中性默认值。 */
function pageReport(overrides: Partial<BadPageScanReport> = {}): BadPageScanReport {
  return {
    dbName: 'nt_msg.db',
    dbPath: '/tmp/nt_msg.db',
    pageSize: 4096,
    pageCount: 1000,
    badPages: [],
    zeroPages: [],
    plaintext: false,
    trailingBytes: 0,
    usedHmac: true,
    headerOffset: 1024,
    affected: [],
    ...overrides,
  };
}

const healthyIntegrity: DbRepairCheckupIntegrity = {
  ran: true,
  healthy: false,
  corruptedTables: [],
};

const okPages: DbRepairCheckupPages = { ran: true, report: pageReport() };

describe('concludeCheckup', () => {
  it('结构完好 + 页签名全过 → healthy', () => {
    const result = concludeCheckup({ ...healthyIntegrity, healthy: true }, okPages);
    expect(result.verdict).toBe('healthy');
    expect(result.summary).toContain('结构完好');
    expect(result.summary).toContain('1000 个页');
  });

  it('结构损坏（有表名）→ corrupted，且把表名列出来', () => {
    const result = concludeCheckup(
      { ran: true, healthy: false, corruptedTables: ['msg_1', 'msg_2'] },
      okPages,
    );
    expect(result.verdict).toBe('corrupted');
    expect(result.summary).toContain('msg_1、msg_2');
  });

  it('整体损坏（定位不到表）→ corrupted，但不说"没有损坏"', () => {
    const result = concludeCheckup(healthyIntegrity, okPages);
    expect(result.verdict).toBe('corrupted');
    expect(result.summary).toContain('整体损坏');
  });

  it('扫出坏页 → pages-bad，摘要里有坏页数、总页数与波及对象数', () => {
    const result = concludeCheckup(
      { ...healthyIntegrity, healthy: true },
      {
        ran: true,
        report: pageReport({
          badPages: [12, 13, 14],
          affected: [
            { name: 'msg_1', pagetype: 'table', badPageCount: 3, samplePages: [12, 13, 14] },
          ],
        }),
      },
    );
    expect(result.verdict).toBe('pages-bad');
    expect(result.summary).toContain('3 个坏页');
    expect(result.summary).toContain('共 1000 页');
    expect(result.summary).toContain('波及 1 个表 / 索引');
  });

  it('坏页优先于结构：结构也坏时仍报 corrupted（那才是更要紧的事）', () => {
    const result = concludeCheckup(
      { ran: true, healthy: false, corruptedTables: ['msg_1'] },
      { ran: true, report: pageReport({ badPages: [1, 2] }) },
    );
    expect(result.verdict).toBe('corrupted');
  });

  it('**没有页 HMAC** → 只能是 healthy-unverified，绝不能叫"完好"', () => {
    const result = concludeCheckup(
      { ...healthyIntegrity, healthy: true },
      { ran: true, report: pageReport({ usedHmac: false, badPages: [], pageCount: 0 }) },
    );
    expect(result.verdict).toBe('healthy-unverified');
    expect(result.summary).toContain('没有开启页 HMAC');
    expect(result.summary).toContain('不代表页层面一定没问题');
  });

  it('页级没查成（结构好）→ healthy-unverified，并说明原因', () => {
    const result = concludeCheckup(
      { ...healthyIntegrity, healthy: true },
      { ran: false, error: 'native 产物没有 scanBadPages' },
    );
    expect(result.verdict).toBe('healthy-unverified');
    expect(result.summary).toContain('native 产物没有 scanBadPages');
  });

  it('结构没查成（页级干净）→ 仍是未判定，不算完好', () => {
    const result = concludeCheckup({ ran: false, error: '没有可用密钥' }, okPages);
    expect(result.verdict).toBe('healthy-unverified');
    expect(result.summary).toContain('没有可用密钥');
  });

  it('两格都没跑成 → error，且摘要里带原因（而不是空白）', () => {
    const result = concludeCheckup(
      { ran: false, error: '账号配置里没有密钥' },
      { ran: false, error: '账号配置里没有密钥' },
    );
    expect(result.verdict).toBe('error');
    expect(result.summary).toContain('账号配置里没有密钥');
  });
});
