/**
 * 群成员重合模型（和弦图 / 重叠矩阵共用）的回归测试。
 *
 * 数据形状与后端 `account.getRelationGraph` 一致：`nodes[].groupCodes` 是这个人
 * 所在的群，`groups[]` 是群元信息。这里只硬编码一份小样本，不碰真库、不联网。
 */

import { describe, expect, it } from 'vitest';
import {
  buildOverlapModel,
  groupAvatar,
  personAvatar,
} from '../src/renderer/src/components/relationGraph/graphModel';
import type {
  GraphSettings,
  RelationGraphData,
} from '../src/renderer/src/components/relationGraph/types';

function person(uid: string, groups: string[]) {
  return {
    uid,
    uin: uid.replace('u_', '1'),
    nick: uid,
    card: '',
    groupCount: groups.length,
    groupCodes: groups,
    intimacy: 0,
    isFriend: false,
  };
}

/**
 * 三个群：
 *  - A：u1 u2 u3 u4
 *  - B：u1 u2 u3（与 A 共 3 人）
 *  - C：u4（与 A 共 1 人，与 B 共 0 人）
 */
const DATA: RelationGraphData = {
  selfUin: '10000',
  nodes: [
    person('u_1', ['A', 'B']),
    person('u_2', ['A', 'B']),
    person('u_3', ['A', 'B']),
    person('u_4', ['A', 'C']),
  ],
  groups: [
    { code: 'A', name: '甲群', memberCount: 4, sharedCount: 4, myLevel: 10 },
    { code: 'B', name: '乙群', memberCount: 3, sharedCount: 3, myLevel: 20 },
    { code: 'C', name: '丙群', memberCount: 1, sharedCount: 1, myLevel: 0 },
  ],
  scannedGroups: 3,
  builtAt: 0,
};

const BASE: GraphSettings = {
  mode: 'matrix',
  nodeLimit: 100,
  minCommon: 2,
  friendsOnly: false,
  intimacySize: true,
  intimacyPull: false,
  groupLevelSize: false,
  groupLevelPull: false,
  groupFilterMode: 'all',
  groupFilter: [],
  overlapGroupLimit: 30,
  overlapThreshold: 2,
  overlapDirection: 'large',
  overlapSort: 'overlap',
  showAvatars: true,
  showValues: true,
};

function pairsOf(model: ReturnType<typeof buildOverlapModel>) {
  return new Map(model.pairs.map((pair) => [`${pair.a}|${pair.b}`, pair.weight]));
}

describe('群成员重合模型', () => {
  it('按共同成员数生成群对，并给出重合率', () => {
    const model = buildOverlapModel(DATA, BASE);
    const pairs = pairsOf(model);
    // 大重叠 + 阈值 2：A|B（3 人）入选，A|C（1 人）被阈值滤掉。
    expect(pairs.get('A|B')).toBe(3);
    expect(pairs.has('A|C')).toBe(false);
    expect(pairs.size).toBe(1);
    expect(model.maxWeight).toBe(3);
    const ab = model.pairs.find((pair) => pair.a === 'A' && pair.b === 'B');
    expect(ab?.ratio).toBeCloseTo(3 / 3);
  });

  it('小重叠模式反过来：只留不超过阈值的群对，并补上 0 人重合的组合', () => {
    const model = buildOverlapModel(DATA, {
      ...BASE,
      overlapDirection: 'small',
      overlapThreshold: 1,
    });
    const pairs = pairsOf(model);
    expect(pairs.get('A|C')).toBe(1);
    expect(pairs.get('B|C')).toBe(0);
    // A|B 有 3 人重合，超出阈值，不该出现。
    expect(pairs.has('A|B')).toBe(false);
  });

  it('白/黑名单只让选中的群参与共现', () => {
    const model = buildOverlapModel(DATA, {
      ...BASE,
      groupFilterMode: 'whitelist',
      groupFilter: ['A', 'C'],
      overlapThreshold: 1,
    });
    expect(model.groups.map((group) => group.code).sort()).toEqual(['A', 'C']);
    expect(pairsOf(model).get('A|C')).toBe(1);
  });

  it('参与群数按排序截断，重合总量排序把交集最多的群放前面', () => {
    const model = buildOverlapModel(DATA, { ...BASE, overlapGroupLimit: 2 });
    expect(model.groups.map((group) => group.code)).toEqual(['A', 'B']);
    // 甲群与乙群 3 人 + 与丙群 1 人 = 4。
    expect(model.groups[0].overlapSum).toBe(4);
    expect(model.totalPeople).toBe(4);
  });

  it('群名排序按中文名称', () => {
    const model = buildOverlapModel(DATA, { ...BASE, overlapSort: 'name', overlapThreshold: 0 });
    const names = model.groups.map((group) => group.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'zh')));
  });

  it('没有数据时返回空模型而不是抛错', () => {
    const model = buildOverlapModel(undefined, BASE);
    expect(model.groups).toHaveLength(0);
    expect(model.pairs).toHaveLength(0);
    expect(model.maxWeight).toBe(1);
  });
});

describe('头像地址', () => {
  it('uin 为空或 0 时不给头像，避免裂图请求', () => {
    expect(personAvatar('')).toBeNull();
    expect(personAvatar('0')).toBeNull();
    expect(groupAvatar('')).toBeNull();
  });
});
