/**
 * macOS 提权扫内存 worker —— `sudo -S` 子进程里执行的那一半。
 *
 * macOS 上读取其它进程内存（task_for_pid）默认被 SIP 拦死，解除 SIP 后
 * 普通用户也未必拿得到权限；和 ninebird 安装一样，把「读 QQ 内存 + 验证
 * 数据库密钥」这一段收敛成一个短命的 root 子进程，密码经 stdin 喂给
 * sudo，WeQ 主进程保持非特权。
 *
 * 与 inject_worker 同一个打包约定：electron-vite 单独打进 `.mjs`，
 * 生产环境用 `ELECTRON_RUN_AS_NODE=1` 的 electron-as-node 跑，不依赖
 * 系统 node。输入全部走 argv（sudo 会清环境变量）：
 *
 *   argv[2] = QQ pid
 *   argv[3] = 账号的 nt_msg.db 绝对路径
 *   argv[4] = nt_helper.node 绝对路径
 *
 * 结果一行 JSON 打 stdout（`{ ok, key?, keyContextHex?, error? }`），
 * 失败时 JSON 打 stderr 并以非零码退出，父进程解析后转成用户可读文案。
 */

import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const requireFn = createRequire(__filename);

interface ScanResult {
  ok: boolean;
  key?: string;
  keyContextHex?: string;
  error?: string;
}

function fail(error: string, code: number): never {
  const payload: ScanResult = { ok: false, error };
  process.stderr.write(JSON.stringify(payload));
  process.exit(code);
}

async function main(): Promise<void> {
  const pid = Number(process.argv[2]);
  const dbPath = process.argv[3];
  const ntHelperPath = process.argv[4];

  if (!Number.isInteger(pid) || pid <= 0) fail(`bad pid: ${process.argv[2]}`, 2);
  if (!dbPath) fail('missing nt_msg.db path (argv[3])', 2);
  if (!ntHelperPath) fail('missing nt_helper.node path (argv[4])', 2);

  // 与 inject_worker 相同：addon 的 LICENSE 校验从 cwd 往上找，先 chdir 进
  // addon 所在目录（其祖先包含 LICENSE），否则加载直接失败。
  try {
    process.chdir(dirname(ntHelperPath));
  } catch (e) {
    fail(`chdir failed: ${e instanceof Error ? e.message : String(e)}`, 2);
  }

  let nt: {
    getInitStatus(): number;
    scanKeyFromDatabase(
      dbPath: string,
      pid: number,
    ): Promise<{ success: boolean; key?: string; keyContextHex?: string; error?: string }>;
  };
  try {
    nt = requireFn(ntHelperPath);
  } catch (e) {
    fail(`require nt_helper.node failed: ${e instanceof Error ? e.message : String(e)}`, 1);
  }

  const initStatus = nt.getInitStatus();
  if (initStatus !== 0) fail(`nt_helper init failed (status ${initStatus})`, 1);

  try {
    const result = await nt.scanKeyFromDatabase(dbPath, pid);
    if (!result.success) {
      fail(result.error ?? '内存扫描未找到可用密钥', 1);
    }
    const payload: ScanResult = {
      ok: true,
      ...(result.key ? { key: result.key } : {}),
      ...(result.keyContextHex ? { keyContextHex: result.keyContextHex } : {}),
    };
    process.stdout.write(JSON.stringify(payload));
    process.exit(0);
  } catch (e) {
    fail(`scan failed: ${e instanceof Error ? e.message : String(e)}`, 1);
  }
}

void main();
