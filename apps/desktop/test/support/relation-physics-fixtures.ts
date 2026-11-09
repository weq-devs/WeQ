import { buildGraph } from '../../src/renderer/src/components/relationGraph/graphModel';
import type {
  BuiltGraph,
  GraphSettings,
  RelationGraphData,
} from '../../src/renderer/src/components/relationGraph/types';
import type { PhysicsShape } from './relation-physics';

export function physicsFixture(count: number, shape: PhysicsShape, hot = false): BuiltGraph {
  const crowded = hot && shape === 'complete';
  const codes = Array.from(
    { length: shape === 'complete' ? (crowded ? count : 2) : 8 },
    (_, i) => `group-${i}`,
  );
  const data: RelationGraphData = {
    selfUin: '',
    scannedGroups: codes.length,
    builtAt: 0,
    nodes: Array.from({ length: count }, (_, i) => ({
      uid: `person-${i}`,
      uin: '',
      nick: `成员 ${i}`,
      card: '',
      groupCount: crowded ? count : 2,
      groupCodes:
        shape === 'complete'
          ? codes
          : codes.slice(Math.floor((i * 4) / count) * 2, Math.floor((i * 4) / count) * 2 + 2),
      intimacy: crowded || i % 4 === 0 ? 1800 : 100,
      isFriend: crowded || i % 3 === 0,
    })),
    groups: codes.map((code) => ({
      code,
      name: code,
      memberCount: count,
      sharedCount: count,
      myLevel: 20,
    })),
  };
  const settings: GraphSettings = {
    mode: 'people',
    nodeLimit: count,
    minCommon: shape === 'star' ? 60 : 2,
    friendsOnly: false,
    intimacySize: true,
    intimacyPull: false,
    groupLevelSize: false,
    groupLevelPull: false,
    groupFilterMode: 'all',
    groupFilter: [],
    overlapGroupLimit: 30,
    overlapThreshold: 3,
    overlapDirection: 'large',
    overlapSort: 'overlap',
    showAvatars: false,
    showValues: true,
  };
  return buildGraph(data, settings);
}
