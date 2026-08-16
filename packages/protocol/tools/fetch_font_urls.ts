/**
 * 获取前 100 个字体的下载 URL
 * 从 scupdate 批量获取字体下载链接并保存到 tmp/font_urls.json
 */

import { loadNative } from '@weq/native';
import { getFontResource } from '../src/scupdate';
import * as fs from 'fs';
import * as path from 'path';

// 从 group_fontid_stats.md 提取前 100 个字体 ID
const FONT_IDS = [
  20125, 1, 20563, 20402, 20352, 22004, 20083, 20343, 20592, 20268,
  20580, 20002, 21989, 22045, 20717, 22043, 20010, 20486, 20131, 20112,
  20730, 20748, 20161, 20704, 20188, 20185, 20716, 20359, 20170, 20508,
  20189, 20611, 20206, 20130, 20695, 20436, 20102, 20295, 20550, 20136,
  20289, 20462, 20018, 20506, 20271, 20107, 22020, 22018, 20377, 20183,
  22005, 20003, 20012, 22040, 20504, 22041, 22001, 20272, 20169, 22013,
  22011, 20397, 20398, 20554, 20740, 20757, 20004, 22003, 20262, 20679,
  20724, 20171, 20247, 20162, 20266, 20705, 20050, 20182, 20752, 20735,
  20191, 20294, 20001, 20551, 20070, 20066, 20675, 20707, 20381, 22010,
  20006, 22007, 20463, 20685, 20582, 20514, 20210, 20513, 22002, 20467,
];

const OUT_JSON = path.join(process.cwd(), 'tmp', 'font_urls.json');

interface FontUrlResult {
  id: number;
  success: boolean;
  url?: string;
  size?: number;
  md5?: string;
  error?: string;
}

// 获取登录的 QQ 进程
function getLoginInfo(): { pid: number; port: number } {
  const nt = loadNative().ntHelper;
  const pids = nt.getQqProcesses();

  if (pids.length === 0) {
    throw new Error('没有运行中的 QQ.exe，请先打开并登录');
  }

  for (const pid of pids) {
    try {
      const info = nt.probeQqLoginInfo(pid);
      if (info?.loggedIn) {
        console.log(`[init] 使用 pid=${pid} uin=${info.uin}`);
        return { pid, port: info.port };
      }
    } catch {
    }
  }

  throw new Error('没有找到已登录的 QQ 进程');
}

// 获取单个字体的下载链接
async function fetchFontUrl(id: number, info: { pid: number; port: number }): Promise<FontUrlResult> {
  const result: FontUrlResult = { id, success: false };

  try {
    console.log(`[${id}] 获取下载链接...`);
    const nt = loadNative().ntHelper;
    const resource = await getFontResource(
      nt,
      info.pid,
      id,
      { from: 'WeQFontExport' }
    );

    if (!resource) {
      result.error = 'resource is null';
      console.log(`[${id}] ❌ ${result.error}`);
      return result;
    }

    if (!resource.ok) {
      result.error = resource.reason || 'not found';
      console.log(`[${id}] ❌ ${result.error}`);
      return result;
    }

    result.success = true;
    result.url = resource.url;
    result.size = resource.size;
    result.md5 = resource.version || undefined;
    console.log(`[${id}] ✅ ${(resource.size / 1024 / 1024).toFixed(2)} MB`);

  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    console.log(`[${id}] ❌ ${result.error}`);
  }

  return result;
}

// 主流程
async function main() {
  console.log(`📋 准备获取 ${FONT_IDS.length} 个字体的下载链接\n`);

  // 初始化
  const tmpDir = path.dirname(OUT_JSON);
  fs.mkdirSync(tmpDir, { recursive: true });

  const info = getLoginInfo();
  const results: FontUrlResult[] = [];

  // 逐个处理（避免并发过多）
  for (const id of FONT_IDS) {
    const result = await fetchFontUrl(id, info);
    results.push(result);

    // 每处理 10 个输出一次进度
    if (results.length % 10 === 0) {
      const success = results.filter(r => r.success).length;
      console.log(`\n📊 进度: ${results.length}/${FONT_IDS.length} (成功 ${success})\n`);
    }
  }

  // 统计
  const success = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log('\n' + '='.repeat(60));
  console.log(`✅ 成功: ${success.length}/${FONT_IDS.length} (${(success.length / FONT_IDS.length * 100).toFixed(1)}%)`);
  console.log(`❌ 失败: ${failed.length}`);

  if (failed.length > 0) {
    console.log('\n失败详情:');
    for (const r of failed) {
      console.log(`  [${r.id}] ${r.error}`);
    }
  }

  // 保存结果
  fs.writeFileSync(
    OUT_JSON,
    JSON.stringify(results, null, 2),
    'utf-8'
  );

  console.log(`\n📁 结果已保存到: ${OUT_JSON}`);
  console.log(`\n📈 总下载大小: ${(success.reduce((sum, r) => sum + (r.size || 0), 0) / 1024 / 1024).toFixed(1)} MB`);
}

main().catch(console.error);
