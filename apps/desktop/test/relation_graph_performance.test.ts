// @vitest-environment node
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { forEachIntersection } from '../src/renderer/src/components/relationGraph/intersections';

it('交集规模实验：与原逐对集合算法比较，关系数和权重和必须完全相同', () => {
  const report: object[] = [];
  for (const count of [200, 500, 1000]) {
    for (const density of ['sparse', 'dense', 'hot-group']) {
      const groups = density === 'dense' ? 64 : count * 4;
      const width = density === 'dense' ? 32 : 4;
      const rows = Array.from({ length: count }, (_, i) =>
        density === 'hot-group'
          ? [0, i + 1, count + Math.floor(i / 3)]
          : Array.from({ length: width }, (_, j) => (i * 13 + j) % groups),
      );
      function original() {
        const sets = rows.map((row) => new Set(row));
        let edges = 0;
        let sum = 0;
        for (let i = 0; i < count; i++) {
          for (let j = i + 1; j < count; j++) {
            let weight = 0;
            for (const value of sets[i]!) if (sets[j]!.has(value)) weight++;
            if (weight >= 2) {
              edges++;
              sum += weight;
            }
          }
        }
        return { edges, sum };
      }
      function optimized() {
        let edges = 0;
        let sum = 0;
        forEachIntersection(rows, 2, (_a, _b, weight) => {
          edges++;
          sum += weight;
        });
        return { edges, sum };
      }
      expect(optimized()).toEqual(original());
      const median = (run: () => unknown) => {
        const samples = Array.from({ length: 3 }, () => {
          const start = performance.now();
          run();
          return performance.now() - start;
        }).sort((a, b) => a - b);
        return Number(samples[1]!.toFixed(3));
      };
      report.push({
        count,
        density,
        edges: optimized().edges,
        originalMs: median(original),
        optimizedMs: median(optimized),
      });
    }
  }
  console.table(report);
}, 60_000);
