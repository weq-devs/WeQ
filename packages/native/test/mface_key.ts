/**
 * 商城表情(marketface)图片解密密钥的效率探测脚本。
 *
 * getMarketFaceKey(packetId) 不依赖在线 QQ 进程/注入 —— 它自己取包元数据,
 * 然后要么直接读种子(meta),要么在 updateTime 附近的时间窗里爆破
 * (brute: TEA 解前两块 → 查 GIF8 头)。这里只测:输入 packetId,量一次调用
 * 的墙钟耗时,并在给了期望 key 时校验是否命中。
 *
 * 用法: pnpm tsx packages/native/test/mface_key.ts [packetId] [expectKey]
 *   不带参数则跑内置样本(含付费包 11340 的爆破路径)。
 */

import { loadNative } from '../src/index';

async function test(packetId: number | string, expectKey?: string): Promise<void> {
  const nt = loadNative().ntHelper;
  const t0 = process.hrtime.bigint();
  const result = await nt.getMarketFaceKey(String(packetId));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const ok = expectKey ? !!result && result.key === expectKey : true;
  console.log(
    `[${packetId}] ${ms.toFixed(1)}ms`,
    JSON.stringify(result),
    expectKey ? `| expect ${expectKey} | match=${ok}` : '',
  );
}

async function main(): Promise<void> {
  const [, , argPacket, argKey] = process.argv;
  if (argPacket) {
    await test(argPacket, argKey);
    return;
  }
  // 付费包,爆破路径。
  await test(11340, '83a4ff88c7f772e5');
}

main().catch((e) => {
  console.error('[mface_key] 失败:', e);
  process.exit(1);
});
