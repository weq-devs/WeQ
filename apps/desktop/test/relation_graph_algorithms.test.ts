// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { forEachIntersection } from '../src/renderer/src/components/relationGraph/intersections';
import { createGraphSimulation } from '../src/renderer/src/components/relationGraph/graphLayout';
import {
  indexGraphHit,
  indexGraphRender,
} from '../src/renderer/src/components/relationGraph/graphRender';
import {
  buildGraph,
  buildOverlapModel,
} from '../src/renderer/src/components/relationGraph/graphModel';
import type {
  GraphSettings,
  RelationGraphData,
} from '../src/renderer/src/components/relationGraph/types';

const settings: GraphSettings = {
  mode: 'people',
  nodeLimit: 500,
  minCommon: 2,
  friendsOnly: false,
  intimacySize: false,
  intimacyPull: false,
  groupLevelSize: false,
  groupLevelPull: false,
  groupFilterMode: 'all',
  groupFilter: [],
  overlapGroupLimit: 3,
  overlapThreshold: 1,
  overlapDirection: 'large',
  overlapSort: 'overlap',
  showAvatars: false,
  showValues: true,
};

function fixture(count: number, groups: number, width: number): RelationGraphData {
  return {
    selfUin: '',
    scannedGroups: groups,
    builtAt: 0,
    nodes: Array.from({ length: count }, (_, i) => ({
      uid: `u${i}`,
      uin: '',
      nick: `成员${i}`,
      card: '',
      groupCount: width,
      groupCodes: Array.from({ length: width }, (_, j) => `g${(i * 13 + j) % groups}`),
      intimacy: i,
      isFriend: i % 2 === 0,
    })),
    groups: Array.from({ length: groups }, (_, i) => ({
      code: `g${i}`,
      name: `群${i}`,
      memberCount: 100,
      sharedCount: 10,
      myLevel: 0,
    })),
  };
}

function brute(rows: string[][], minimum: number) {
  const sets = rows.map((row) => new Set(row));
  const pairs: number[][] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      let weight = 0;
      for (const value of sets[i]) if (sets[j].has(value)) weight++;
      if (weight >= minimum) pairs.push([i, j, weight]);
    }
  }
  return pairs;
}

describe('精确自适应交集', () => {
  it('单个热门群不产生二次方无效候选；稀有前缀不漏计真实关系', () => {
    const rows = Array.from({ length: 300 }, (_, i) => [
      '热门群',
      `独有${i}`,
      `小圈${Math.floor(i / 3)}`,
    ]);
    for (const minimum of [2, 3]) {
      const actual: number[][] = [];
      forEachIntersection(rows, minimum, (a, b, weight) => actual.push([a, b, weight]));
      expect(actual).toEqual(brute(rows, minimum));
    }
  });

  it('前缀次序在不同集合长度、相同频次及输入顺序下保持精确', () => {
    const rows = Array.from({ length: 240 }, (_, i) => {
      const values = [
        '热门',
        `独有${i}`,
        ...Array.from({ length: (i % 5) + 1 }, (_, j) => `圈${Math.floor(i / 4) + j}`),
      ];
      return i % 2 ? values.reverse() : values;
    });
    for (const minimum of [2, 3, 4, 5, 6]) {
      const actual: number[][] = [];
      forEachIntersection(rows, minimum, (a, b, weight) => actual.push([a, b, weight]));
      expect(actual).toEqual(brute(rows, minimum));
    }
  });
  it.each([
    [100, 800, 4],
    [100, 64, 64],
    [120, 97, 40],
    [80, 8, 2],
  ])('%i 行、%i 特征、每行 %i 项与独立朴素实现一致', (count, groups, width) => {
    const rows = fixture(count, groups, width).nodes.map((node) => node.groupCodes);
    for (const minimum of [1, 2, 4, width + 1]) {
      const actual: number[][] = [];
      forEachIntersection(rows, minimum, (a, b, weight) => actual.push([a, b, weight]));
      expect(actual).toEqual(brute(rows, minimum));
    }
  });

  it('空集合、重复项、位 31/32/63 边界及不存在的交集', () => {
    const all = Array.from({ length: 65 }, (_, i) => `${i}`);
    const rows = [[], all, [...all, '0', '32'], ['31', '32', '63'], ['outside']];
    const actual: number[][] = [];
    forEachIntersection(rows, 1, (a, b, weight) => actual.push([a, b, weight]));
    expect(actual).toEqual(brute(rows, 1));
  });
});

describe('群交集模型与渲染索引', () => {
  it('大量未显示的群不展开全量群对，排序仍计入全部重合贡献', () => {
    const model = buildOverlapModel(fixture(16, 512, 512), settings);
    expect(model.groups.map((group) => group.code)).toEqual(['g0', 'g1', 'g2']);
    expect(
      model.groups.every((group) => group.poolSize === 16 && group.overlapSum === 16 * 511),
    ).toBe(true);
    expect(model.pairs).toHaveLength(3);
    expect(model.pairs.every((pair) => pair.weight === 16 && pair.ratio === 1)).toBe(true);
    expect(model.totalPeople).toBe(16);
  });
  it.each([500, 1000])('%i 个节点保留全部精确关系，筛选仍发生在计数之前', (count) => {
    const data = fixture(count, 300, 6);
    const graph = buildGraph(data, { ...settings, nodeLimit: count });
    expect(graph.nodes).toHaveLength(count + 1);
    expect(
      graph.edges
        .filter((edge) => edge.source !== '__self__')
        .map((edge) => [Number(edge.source.slice(1)), Number(edge.target.slice(1)), edge.weight]),
    ).toEqual(
      brute(
        data.nodes.map((node) => node.groupCodes),
        2,
      ),
    );
    const filtered = buildGraph(data, {
      ...settings,
      friendsOnly: true,
      groupFilterMode: 'whitelist',
      groupFilter: ['g0', 'g1'],
    });
    expect(
      filtered.nodes.filter((node) => node.kind === 'person').every((node) => node.isFriend),
    ).toBe(true);
    expect(
      filtered.edges
        .filter((edge) => edge.source !== '__self__')
        .every((edge) => edge.weight === 2),
    ).toBe(true);
  });

  it('重合排序保留未选中群的贡献；群对、人数、零交集与朴素计数一致', () => {
    const data = fixture(100, 11, 4);
    for (const overlapSort of ['overlap', 'name', 'size'] as const) {
      for (const overlapDirection of ['small', 'large'] as const) {
        const options = { ...settings, overlapSort, overlapDirection };
        const model = buildOverlapModel(data, options);
        const pool = (code: string) => data.nodes.filter((node) => node.groupCodes.includes(code));
        for (const group of model.groups) {
          expect(group.poolSize).toBe(pool(group.code).length);
          expect(group.overlapSum).toBe(
            pool(group.code).reduce((sum, node) => sum + node.groupCodes.length - 1, 0),
          );
        }
        const expected = new Map<string, number>();
        for (let i = 0; i < model.groups.length; i++) {
          for (let j = i + 1; j < model.groups.length; j++) {
            const [a, b] = [model.groups[i].code, model.groups[j].code].sort();
            const weight = pool(a).filter((node) => node.groupCodes.includes(b)).length;
            if (
              overlapDirection === 'small'
                ? weight <= options.overlapThreshold
                : weight >= options.overlapThreshold
            )
              expected.set(`${a}|${b}`, weight);
          }
        }
        expect(new Map(model.pairs.map((pair) => [`${pair.a}|${pair.b}`, pair.weight]))).toEqual(
          expected,
        );
      }
    }
  });

  it('群模式精确计数与好友过滤无关，索引缓存邻接和全部连线', () => {
    const data = fixture(100, 10, 4);
    const graph = buildGraph(data, { ...settings, mode: 'groups', friendsOnly: true });
    const rows = data.groups.map((group) =>
      data.nodes.filter((node) => node.groupCodes.includes(group.code)).map((node) => node.uid),
    );
    expect(
      graph.edges
        .filter((edge) => edge.source !== '__self__')
        .map((edge) => [Number(edge.source.slice(1)), Number(edge.target.slice(1)), edge.weight]),
    ).toEqual(brute(rows, 2));
    createGraphSimulation(graph).stop();
    const index = indexGraphRender(graph);
    expect(index.batches.flatMap((batch) => batch.edges)).toHaveLength(graph.edges.length);
    expect(index.adjacent.get('__self__')?.size).toBe(10);
    expect(index.incident.get('__self__')).toHaveLength(10);
    graph.nodes[0].x = 321;
    expect(
      index.incident
        .get(graph.nodes[0].id)
        ?.some((edge) => edge.source.x === 321 || edge.target.x === 321),
    ).toBe(true);
  });

  it('空间命中与反向线性扫描一致，重合坐标保留后画优先', () => {
    const graph = buildGraph(fixture(100, 20, 2), settings);
    graph.nodes.forEach((node, i) => {
      node.x = (i % 10) * 30;
      node.y = Math.floor(i / 10) * 30;
    });
    graph.nodes[1].x = graph.nodes[0].x;
    graph.nodes[1].y = graph.nodes[0].y;
    graph.nodes[2].radius = 45;
    const hit = indexGraphHit(graph.nodes);
    for (let x = -30; x <= 340; x += 7) {
      for (let y = -30; y <= 340; y += 11) {
        expect(hit(x, y)).toBe(
          graph.nodes.findLast(
            (node) => (node.x - x) ** 2 + (node.y - y) ** 2 <= (node.radius + 2) ** 2,
          ) ?? null,
        );
      }
    }
  });
});
