import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SERVICE_PORTS,
  nextOneBotPort,
  servicePortCandidates,
} from '../src/common/service_ports';

describe('服务端口分配', () => {
  it('Web 回退跳过 Remote，保留十个实际候选端口', () => {
    expect(servicePortCandidates('web', DEFAULT_SERVICE_PORTS.web, 10)).toEqual([
      7690, 7693, 7694, 7695, 7696, 7697, 7698, 7699, 7700, 7701,
    ]);
  });

  it('显式指定的端口优先，不禁止用户使用其他服务的默认范围', () => {
    expect(servicePortCandidates('web', 7691, 3)).toEqual([7691, 7693, 7694]);
    expect(servicePortCandidates('onebot-ws', 48766, 3)).toEqual([48766, 48785, 48786]);
  });

  it('新 OneBot 默认范围不与 MCP 或另一种 OneBot 监听器重叠', () => {
    const mcp = servicePortCandidates('mcp', DEFAULT_SERVICE_PORTS.mcp, 20);
    const ws = servicePortCandidates('onebot-ws', DEFAULT_SERVICE_PORTS['onebot-ws'], 20);
    const http = servicePortCandidates('onebot-http', DEFAULT_SERVICE_PORTS['onebot-http'], 20);
    expect(new Set([...mcp, ...ws, ...http]).size).toBe(60);
    expect(DEFAULT_SERVICE_PORTS['onebot-ws']).toBe(48800);
    expect(DEFAULT_SERVICE_PORTS['onebot-http']).toBe(48840);
  });

  it('回退不会进入另一服务的预留范围', () => {
    expect(servicePortCandidates('mcp', 48799, 2)).toEqual([48799, 48820]);
    expect(servicePortCandidates('onebot-ws', 48839, 2)).toEqual([48839, 48860]);
    expect(servicePortCandidates('weq-assistant', 7689, 2)).toEqual([7689, 7702]);
  });

  it('回退避开其他服务器指定端口，但仍首先尝试自己的端口', () => {
    expect(servicePortCandidates('onebot-ws', 50000, 3, new Set([50000, 50001, 50002]))).toEqual([
      50000, 50003, 50004,
    ]);
  });

  it('新建服务器跨类型避让已配置端口及其他服务预留范围', () => {
    expect(nextOneBotPort(new Set(), 'ws')).toBe(DEFAULT_SERVICE_PORTS['onebot-ws']);
    expect(nextOneBotPort(new Set(), 'http')).toBe(DEFAULT_SERVICE_PORTS['onebot-http']);
    const used = new Set(
      Array.from({ length: 40 }, (_, i) => DEFAULT_SERVICE_PORTS['onebot-ws'] + i),
    );
    expect(nextOneBotPort(used, 'ws')).toBe(DEFAULT_SERVICE_PORTS['onebot-http'] + 20);
  });

  it('随机端口只尝试一次，端口上限不越界', () => {
    expect(servicePortCandidates('web', 0, 10)).toEqual([0]);
    expect(servicePortCandidates('mcp', 65534, 20)).toEqual([65534, 65535]);
    for (const port of [-1, 1.5, 65536, Number.NaN]) {
      expect(() => servicePortCandidates('web', port, 10)).toThrow('服务端口无效');
    }
  });
});
