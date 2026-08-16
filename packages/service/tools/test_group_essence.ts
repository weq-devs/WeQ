/**
 * Test script for group essence Web API.
 * 测试群精华消息查询接口。
 */

import { loadNative } from '@weq/native';
import type { AccountSession } from '@weq/account';
import { WebQueryService } from '../src/account/web';

const TEST_GROUP_CODE = '1081372778'; // 测试用的群号

async function main() {
  const nt = loadNative().ntHelper;

  const pids = nt.getQqProcesses();
  console.log(`[test:essence] QQ 进程 pid: ${pids.length ? pids.join(', ') : '(无)'}`);
  if (pids.length === 0) throw new Error('没有运行中的 QQ.exe');

  const pid = pids[0]!;
  const info = nt.probeQqLoginInfo(pid);
  const uin = info?.uin ?? '';
  console.log(`[test:essence] pid=${pid} uin=${uin} loggedIn=${info?.loggedIn}`);
  if (!uin) throw new Error('probe 没拿到 uin');

  console.log(`\n[test:essence] 注入 hook 到 pid=${pid} ...`);
  const status = await nt.injectAndGetStatusEmbedded(pid);
  console.log(`[test:essence] 注入结果: pid=${status.pid} uin=${status.uin} loggedIn=${status.loggedIn}`);

  const web = new WebQueryService(nt, { context: { uin } } as unknown as AccountSession, () => pid);

  console.log(`\n[test:essence] 查询群 ${TEST_GROUP_CODE} 的精华消息...`);

  try {
    const messages = await web.getGroupEssence(TEST_GROUP_CODE, 0, 50);

    console.log(`[test:essence] 找到 ${messages.length} 条精华消息:`);

    for (const msg of messages) {
      console.log('\n---');
      console.log(`  群号: ${msg.group_code}`);
      console.log(`  消息序号: ${msg.msg_seq}`);
      console.log(`  消息 Random: ${msg.msg_random}`);
      console.log(`  发送者 UIN: ${msg.sender_uin}`);
      console.log(`  发送者昵称: ${msg.sender_nick}`);
      console.log(`  发送时间: ${new Date(msg.sender_time * 1000).toLocaleString('zh-CN')}`);
      console.log(`  设置者 UIN: ${msg.add_digest_uin}`);
      console.log(`  设置者昵称: ${msg.add_digest_nick}`);
      console.log(`  设置时间: ${new Date(msg.add_digest_time * 1000).toLocaleString('zh-CN')}`);
      console.log(`  可移除: ${msg.can_be_removed}`);
      console.log(`  消息内容 (${msg.msg_content.length} 个元素):`);

      for (const content of msg.msg_content) {
        console.log(`    - Type ${content.msg_type}:`);
        if (content.text) console.log(`      文本: ${content.text}`);
        if (content.image_url) console.log(`      图片: ${content.image_url}`);
        if (content.face_index !== undefined) console.log(`      表情: ${content.face_index}`);
        if (content.file_name) console.log(`      文件: ${content.file_name} (${content.file_size} bytes)`);
      }
    }

    console.log('\n[test:essence] ✓ 测试成功');
  } catch (error) {
    console.error('[test:essence] ✗ 测试失败:', error);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[test:essence] 致命错误:', e);
  process.exit(1);
});
