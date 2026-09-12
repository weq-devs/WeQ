/**
 * 硬编码游戏中心模板（weq_assistant_template.ts）的离线单测。
 *
 * 这些常量来自一次真实 nt_msg.db 抓取（QQ 游戏中心推文行，逐字节 base64）。
 * WeqAssistantService 的 insert 路径完全依赖它们，这里保证：
 *   1. 捕获的 40800 body 能被 codec 解出恰好一个 ark 元素（buildArkBody 的前提）；
 *   2. 三张表模板的列序与抓取库的 PRAGMA 声明前缀一致（运行时允许“尾部新增列”，
 *      见 cloneAndInsert —— 实测新版 QQ 在 c2c_msg_table 尾部追加了恒为 NULL 的
 *      40722，模板必须是 live schema 的前缀而不是完全相等）。
 */

import { describe, expect, it } from 'vitest';
import { ProtoMsg, decodeElement } from '@weq/codec';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import {
  C2C_ROW_TEMPLATE,
  GAME_CENTER_BODY_40800,
  MAPPING_ROW_TEMPLATE,
  RECENT_ROW_TEMPLATE,
} from '../src/account/weq_assistant_template';

const bodyCodec = new ProtoMsg(MsgBody);

/** 抓取来源库（tmp/nt_msg.db）里三张表的列声明顺序。 */
const CAPTURED_COLUMNS = {
  nt_uid_mapping_table: ['48901', '48902', '48912', '1002'],
  c2c_msg_table: [
    '40001',
    '40002',
    '40003',
    '40010',
    '40011',
    '40012',
    '40013',
    '40020',
    '40026',
    '40021',
    '40027',
    '40040',
    '40041',
    '40050',
    '40052',
    '40090',
    '40093',
    '40800',
    '40900',
    '40105',
    '40005',
    '40058',
    '40006',
    '40100',
    '40600',
    '40060',
    '40850',
    '40851',
    '40601',
    '40801',
    '40605',
    '40030',
    '40033',
    '40062',
    '40083',
    '40084',
    '40008',
    '40009',
  ],
  recent_contact_v3_table: [
    '40055',
    '40010',
    '40027',
    '40021',
    '40030',
    '40051',
    '40041',
    '41102',
    '40056',
    '40050',
    '40003',
    '40094',
    '40093',
    '40090',
    '40095',
    '40096',
    '40001',
    '41103',
    '41104',
    '40020',
    '40033',
    '41220',
    '40600',
    '41106',
    '41107',
    '41108',
    '41110',
    '40011',
    '41114',
    '41115',
    '41116',
    '42261',
    '41124',
    '41123',
    '41130',
    '41136',
    '41131',
    '40022',
    '41127',
    '40092',
    '40091',
    '40014',
    '41126',
    '41128',
    '41133',
    '41134',
    '41135',
    '49102',
    '49103',
    '41132',
    '41138',
    '41137',
    '41144',
    '41147',
    '41146',
    '41148',
    '60001',
    '41150',
    '40005',
    '40002',
    '40006',
    '41158',
    '41159',
  ],
} as const;

describe('weq_assistant_template', () => {
  it('捕获的 40800 body 解出恰好一个 ark 元素', () => {
    const decoded = bodyCodec.decode(GAME_CENTER_BODY_40800);
    const elements = (decoded.elements ?? []).map(decodeElement);
    const ark = elements.filter((e) => e.kind === 'ark');
    expect(ark).toHaveLength(1);
    expect(ark[0]!.arkData).toContain('"view":"pubAdArkView"');
  });

  it('三张表模板的列序与抓取库 PRAGMA 声明前缀一致', () => {
    const expectPrefixOrder = (
      template: readonly (readonly [string, unknown])[],
      cols: readonly string[],
    ): void => {
      const names = template.map(([c]) => c);
      expect(cols.slice(0, names.length)).toEqual([...names]);
    };
    expectPrefixOrder(MAPPING_ROW_TEMPLATE, CAPTURED_COLUMNS.nt_uid_mapping_table);
    expectPrefixOrder(C2C_ROW_TEMPLATE, CAPTURED_COLUMNS.c2c_msg_table);
    expectPrefixOrder(RECENT_ROW_TEMPLATE, CAPTURED_COLUMNS.recent_contact_v3_table);
  });

  it('抓取账号的身份只出现在 insert 时必被覆盖的身份列里', () => {
    // uid / 昵称作为占位值留在模板里没关系 —— insert 一定覆盖这些列
    // （40020/40021→this.uid、40094→WEQ_ASSISTANT_NICK、48902→this.uid）。
    // 关键是它们不许泄进「内容/路径」列。
    const identityCols = new Set(['40020', '40021', '40094', '48902']);
    for (const [col, value] of [
      ...C2C_ROW_TEMPLATE,
      ...RECENT_ROW_TEMPLATE,
      ...MAPPING_ROW_TEMPLATE,
    ]) {
      if (typeof value !== 'string') continue;
      if (value.includes('u_-PBswiplK') || value.includes('QQ游戏中心')) {
        expect(identityCols.has(col), `identity leaked into non-overridden column ${col}`).toBe(
          true,
        );
      }
      expect(value, `column ${col} leaks a local avatar path`).not.toContain('nt_data');
    }
    // 头像路径列（41110）被特意清成 NULL（原值是抓取者的本机路径）。
    expect(RECENT_ROW_TEMPLATE.find(([c]) => c === '41110')?.[1]).toBeNull();
  });
});
