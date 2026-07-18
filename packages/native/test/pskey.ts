//  自己手写的测试文件，非常的稀有
import { loadNative } from '../src/index';
import type { QqPortLoginInfo } from '../src/types';
import { testEnv } from '@weq/testkit';

const TARGET_UIN = process.argv[2] ?? testEnv.uin;

function probeSafe(
    nt: ReturnType<typeof loadNative>['ntHelper'],
    pid: number,
): QqPortLoginInfo | null {
    try {
        return nt.probeQqLoginInfo(pid);
    } catch (e) {
        console.warn(`probeQqLoginInfo(${pid}) 抛错:`, e);
        return null;
    }
}

async function main(): Promise<void> {
    const nt = loadNative().ntHelper;

    const pids = nt.getQqProcesses();
    console.log(`运行中的 QQ 进程 pid: ${pids.length ? pids.join(', ') : '(无)'}`);
    if (pids.length === 0) {
        throw new Error('没有运行中的 QQ.exe,请先打开并登录目标账号');
    }

    // 把每个 pid 归属到 uin / 登录状态。
    const probes = pids.map((pid) => ({ pid, info: probeSafe(nt, pid) }));
    for (const { pid, info } of probes) {
        console.log(
            `  pid=${pid}  uin=${info?.uin || '?'}  loggedIn=${info?.loggedIn ?? '?'}  port=${info?.port ?? '?'}`,
        );
    }

    // 选定目标 pid:单进程直接用它;多进程按 uin 匹配。
    let targetPid: number | undefined;
    if (pids.length === 1) {
        targetPid = pids[0];
        console.log(`仅一个 QQ 进程,默认目标 pid=${targetPid}`);
    } else {
        targetPid = probes.find((p) => p.info?.uin === TARGET_UIN && p.info?.loggedIn)?.pid;
        if (targetPid === undefined) {
            throw new Error(
                `多个 QQ 进程,但没有找到 uin=${TARGET_UIN} 且已登录的进程。` +
                `已探测: ${probes.map((p) => `${p.pid}:${p.info?.uin || '?'}`).join(', ')}`,
            );
        }
        console.log(`匹配到 uin=${TARGET_UIN} 的 pid=${targetPid}`);
    }

    console.log(`\n注入 hook 到 pid=${targetPid} ...`);
    const status = await nt.injectAndGetStatusEmbedded(targetPid);
    console.log(`注入结果: pid=${status.pid} uin=${status.uin} loggedIn=${status.loggedIn}`);

    console.log(`\n调用 pskey获取(${targetPid}) ...`);
    const raw = await nt.fetchPskey(targetPid, testEnv.uin, 'pd.qq.com');
    console.log(`\n === 原始返回字符串 ===\n${raw}\n`);
}

main().catch((e) => {
    console.error('失败:', e);
    process.exit(1);
});
