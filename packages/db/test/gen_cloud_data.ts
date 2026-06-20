/**
 * 聚合共同群聊 >= 2 的用户数据，并按重合群数降序排序
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadNative } from '@weq/native';
import { GroupMemberDb } from '../src/group_info/member';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';
const GROUP_INFO_DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\group_info.db`;

interface CloudUser {
    uid: string;
    uin: string;
    nick: string;
    card: string;
    groupCount: number; // 新增：群数量，方便排序
    groupCodeList: string[];
}

async function main() {
    const native = loadNative();

    console.log('[cloud-data] 正在打开数据库...', GROUP_INFO_DB_PATH);
    const db = new GroupMemberDb(native.ntHelper, {
        dbPath: GROUP_INFO_DB_PATH,
        key: KEY,
        algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
    });

    console.log('[cloud-data] 正在扫描所有群聊...');
    const groupRows = await (db as any).qq.query('SELECT DISTINCT "60001" FROM group_member3', []);
    const groupCodes = groupRows.map((row: any) => row[0].toString());
    console.log(`[cloud-data] 共发现 ${groupCodes.length} 个群聊。`);

    const uidFreqMap = new Map<string, { count: number; uin: string; nick: string; card: string; groups: Set<string> }>();

    console.log('[cloud-data] 开始拉取群成员并计算重合度...');
    for (let i = 0; i < groupCodes.length; i++) {
        const groupCode = groupCodes[i];
        try {
            const members = await db.listMembersInGroup(BigInt(groupCode), 10000);

            for (const m of members) {
                if (!m.uid) continue;

                if (!uidFreqMap.has(m.uid)) {
                    uidFreqMap.set(m.uid, {
                        count: 0,
                        uin: m.uin ? m.uin.toString() : '',
                        nick: m.nick || '',
                        card: m.card || '',
                        groups: new Set<string>()
                    });
                }

                const info = uidFreqMap.get(m.uid)!;
                if (!info.groups.has(groupCode)) {
                    info.groups.add(groupCode);
                    info.count += 1;
                }
                if (m.uin && !info.uin) info.uin = m.uin.toString();
                if (m.nick && !info.nick) info.nick = m.nick;
                if (m.card && !info.card) info.card = m.card;
            }
        } catch (err) {
            console.error(`[cloud-data] 读取群 ${groupCode} 失败:`, err);
        }
    }

    // 3. 过滤并转换为数组
    console.log('[cloud-data] 正在过滤并进行降序排序...');
    const resultArray: CloudUser[] = [];

    for (const [uid, info] of uidFreqMap.entries()) {
        if (info.count >= 2) {
            resultArray.push({
                uid: uid,
                uin: info.uin,
                nick: info.nick || info.card || '未知昵称',
                card: info.card,
                groupCount: info.count,
                groupCodeList: Array.from(info.groups)
            });
        }
    }

    // 核心：按群数量从大到小排序
    resultArray.sort((a, b) => b.groupCount - a.groupCount);

    // 4. 控制台预览前 20 名
    console.log('\n========= 👑 共同群聊密友 Top 20 =========');
    console.table(
        resultArray.slice(0, 20).map((user, idx) => ({
            排名: idx + 1,
            昵称: user.nick,
            群名片: user.card,
            QQ号: user.uin,
            共同群数: user.groupCount,
        }))
    );
    console.log('==========================================\n');

    // 5. 将排序后的数组写入 JSON 文件
    const outputPath = path.join(process.cwd(), 'group_cloud_nodes_sorted.json');
    fs.writeFileSync(outputPath, JSON.stringify(resultArray, bigintReplacer, 2), 'utf-8');

    console.log(`[cloud-data] ✅ 搞定！`);
    console.log(`[cloud-data] 满足条件的总人数: ${resultArray.length} 人`);
    console.log(`[cloud-data] 排序数据已保存至: ${outputPath}`);

    db.close();
}

function bigintReplacer(_k: string, v: unknown): unknown {
    return typeof v === 'bigint' ? v.toString() : v;
}

main().catch((e) => {
    console.error('[cloud-data] 运行失败:', e);
    process.exit(1);
});