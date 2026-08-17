/**
 * Test script for group notice/announcement Web API.
 * 测试群公告查询接口。
 */

import { loadNative } from '@weq/native';
import type { AccountSession } from '@weq/account';
import { WebQueryService } from '../src/account/web';

const TEST_GROUP_CODE = '673646675'; // 测试用的群号

async function main() {
  const nt = loadNative().ntHelper;

  const pids = nt.getQqProcesses();
  console.log(`[test:notice] QQ 进程 pid: ${pids.length ? pids.join(', ') : '(无)'}`);
  if (pids.length === 0) throw new Error('没有运行中的 QQ.exe');

  const pid = pids[0]!;
  const info = nt.probeQqLoginInfo(pid);
  const uin = info?.uin ?? '';
  console.log(`[test:notice] pid=${pid} uin=${uin} loggedIn=${info?.loggedIn}`);
  if (!uin) throw new Error('probe 没拿到 uin');

  console.log(`\n[test:notice] 注入 hook 到 pid=${pid} ...`);
  const status = await nt.injectAndGetStatusEmbedded(pid, uin);
  console.log(`[test:notice] 注入结果: pid=${status.pid} uin=${status.uin} loggedIn=${status.loggedIn}`);

  const web = new WebQueryService(nt, { context: { uin } } as unknown as AccountSession, () => pid);

  console.log(`\n[test:notice] 查询群 ${TEST_GROUP_CODE} 的公告...`);

  try {
    const notices = await web.getGroupNotice(TEST_GROUP_CODE);

    console.log(`[test:notice] 找到 ${notices.length} 条群公告:`);

    for (const notice of notices) {
      console.log('\n---');
      console.log(`  公告 ID: ${notice.noticeId}`);
      console.log(`  发布者 UIN: ${notice.senderId}`);
      console.log(`  发布时间: ${new Date(notice.publishTime * 1000).toLocaleString('zh-CN')}`);
      console.log(`  已读人数: ${notice.readNum}`);
      console.log(`  公告内容: ${notice.text}`);

      if (notice.images.length > 0) {
        console.log(`  图片 (${notice.images.length} 张):`);
        for (const img of notice.images) {
          console.log(`    - ID: ${img.id}, 尺寸: ${img.width}x${img.height}`);
        }
      }
    }

    console.log('\n[test:notice] ✓ 测试成功');
  } catch (error) {
    console.error('[test:notice] ✗ 测试失败:', error);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[test:notice] 致命错误:', e);
  process.exit(1);
});
