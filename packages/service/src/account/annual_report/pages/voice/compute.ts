import type { Element } from '@weq/codec';
import type { PageAvailability, ReportPageDefinition } from '../../types';
import { isAllTimeYear, reportYearUnixRange } from '../../time';
import { segmentWords } from '../../../text_segment';
import type { VoiceFaceFavorite, VoicePageData, VoicePicFavorite, VoiceWord } from './types';

/** 词云要多少颗词。背景只负责氛围，太多会抢主体的视线。 */
const CLOUD_WORD_COUNT = 26;
/** 系统表情榜最多保留几位（渲染层画「最大 + 老朋友」的表情带用）。 */
const FACE_RANK_LIMIT = 5;
/** 兜底排序名额：正文里完全没分到可用词时（不可能但保底）用「…」。 */
const FALLBACK_WORD = { word: '……', count: 0 };

/**
 * 我的话 —— 把「你这一年说了什么」浓缩成三件东西：
 *
 *  1. 口头禅：正文分词里最常出现的那个词（数据主角，占住整页视觉）；
 *  2. 系统表情：QQ 自带 face 元素里用得最多的前几名（第一名画得最大）；
 *  3. 自定义表情：pic 元素里重复得最多的那张图。
 *
 * 词云不单独算 —— 它就是 top words 的分母，页面把它们散成背景。
 * 这是年度报告里唯一必须逐条解 40800 的页面：问的是「说过什么」，
 * 只看元数据给不出答案。
 */
export const voicePage: ReportPageDefinition<VoicePageData> = {
  manifest: {
    id: 'voice',
    title: '我的话',
    description: '说得最多的口头禅、最常发的那张脸。',
    order: 7,
    version: '0.1.0',
    apiVersion: 1,
    category: '自己',
    enabledByDefault: true,
  },
  availability: async ({ year, q }): Promise<PageAvailability> => {
    const { startSec, endSec } = reportYearUnixRange(year);
    const counts = await q.overview.countByDirection(startSec, endSec);
    const hasSent = counts.c2cSent + counts.groupSent > 0;
    return {
      available: hasSent,
      reason: hasSent
        ? undefined
        : isAllTimeYear(year)
          ? '这段时间你没有发出过消息'
          : '这一年你没有发出过消息',
    };
  },
  compute: async ({ year, q }) => {
    const { startSec, endSec } = reportYearUnixRange(year);
    const rows = await q.speech.sentRows(startSec, endSec);

    const wordCounts = new Map<string, number>();
    const faceCounts = new Map<number, number>();
    /** faceId → 消息里出现过的干净 faceText（用于名字兜底）。 */
    const faceTextById = new Map<number, string>();
    let faceTotal = 0;
    let textMessages = 0;
    let picTotal = 0;
    const picByKey = new Map<string, PicAccumulator>();

    for (const row of rows) {
      const sendTime = Number(row.sendTime);
      let hasText = false;
      for (const element of row.elements) {
        if (element.kind === 'text') {
          hasText = true;
          for (const word of segmentWords(textContentOf(element))) {
            wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
          }
        } else if (element.kind === 'face') {
          const faceId = element.faceId;
          if (!Number.isFinite(faceId) || faceId <= 0) continue;
          faceTotal++;
          faceCounts.set(faceId, (faceCounts.get(faceId) ?? 0) + 1);
          const name = cleanFaceName(element.faceText);
          if (name && !faceTextById.has(faceId)) faceTextById.set(faceId, name);
        } else if (isCustomPic(element)) {
          picTotal++;
          const key = picKeyOf(element);
          if (!key) continue;
          let acc = picByKey.get(key);
          if (!acc) {
            acc = {
              key,
              fileName: '',
              md5: '',
              fileToken: '',
              originalUrl: '',
              sendTimeMs: 0,
              subType: element.subType ?? 0,
              imgType: element.imgType ?? 0,
              width: element.imgWidth ?? 0,
              height: element.imgHeight ?? 0,
              count: 0,
            };
            picByKey.set(key, acc);
          }
          acc.count++;
          // 种子选「最新一条」：媒体文件多半还在本地，寻址命中率最高。
          const tMs = sendTime > 0 ? sendTime * 1000 : acc.sendTimeMs;
          if (tMs >= acc.sendTimeMs) {
            acc.sendTimeMs = tMs;
            if (element.fileName) acc.fileName = element.fileName;
            if (element.md5) acc.md5 = element.md5;
            if (element.fileToken) acc.fileToken = element.fileToken;
            if (element.originalUrl) acc.originalUrl = element.originalUrl;
            if (element.imgWidth) acc.width = element.imgWidth;
            if (element.imgHeight) acc.height = element.imgHeight;
            acc.subType = element.subType ?? acc.subType;
            acc.imgType = element.imgType ?? acc.imgType;
          }
        }
      }
      if (hasText) textMessages++;
    }

    const words = [...wordCounts.entries()]
      .map(([word, count]) => ({ word, count }))
      .sort(rankWords);
    const word = pickCatchphrase(words);
    const cloud = trimCloud([...(word ? [word] : []), ...words], CLOUD_WORD_COUNT);

    // 系统表情榜：按次数取前几位，批量为它们解析一个干净名字（导出 / aria 用）。
    const faceSorted = [...faceCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, FACE_RANK_LIMIT)
      .filter(([, count]) => count > 0);
    const resolved = await q.emoji.names(faceSorted.map(([id]) => id));
    const faces: VoiceFaceFavorite[] = faceSorted.map(([id, count]) => ({
      faceId: id,
      name: cleanFaceName(resolved[id]) || faceTextById.get(id) || `表情 ${id}`,
      count,
    }));

    const picWinner = [...picByKey.values()].sort(
      (a, b) => b.count - a.count || a.key.localeCompare(b.key),
    )[0];
    let pic: VoicePicFavorite | null = null;
    if (picWinner && picWinner.count > 0) {
      pic = {
        key: picWinner.key,
        fileName: picWinner.fileName,
        md5: picWinner.md5,
        fileToken: picWinner.fileToken,
        originalUrl: picWinner.originalUrl,
        sendTimeMs: picWinner.sendTimeMs,
        subType: picWinner.subType,
        imgType: picWinner.imgType,
        width: picWinner.width,
        height: picWinner.height,
        count: picWinner.count,
      };
    }

    return {
      year,
      sentTotal: rows.length,
      textMessages,
      word,
      cloud,
      faces,
      faceTotal,
      pic,
      picTotal,
    };
  },
};

type PicAccumulator = {
  key: string;
  fileName: string;
  md5: string;
  fileToken: string;
  originalUrl: string;
  sendTimeMs: number;
  subType: number;
  imgType: number;
  width: number;
  height: number;
  count: number;
};

function textContentOf(element: Extract<Element, { kind: 'text' }>): string {
  return element.textContent ?? '';
}

/** pic 元素里算「自定义表情」的：QQ 的 CUSTOM(1) 或 EMOJI(2000) 图。 */
function isCustomPic(element: Element): element is Extract<Element, { kind: 'pic' }> {
  if (element.kind !== 'pic') return false;
  return (element.subType ?? 0) === 1 || (element.imgType ?? 0) === 2000;
}

/** 同一张自定义表情的稳定去重键：md5 或文件名主干（大写 32 位十六进制）。 */
function picKeyOf(element: Extract<Element, { kind: 'pic' }>): string {
  const md5 = String(element.md5 ?? '')
    .trim()
    .toUpperCase();
  const stem = String(element.fileName ?? '')
    .replace(/\.[^.]+$/, '')
    .trim()
    .toUpperCase();
  for (const candidate of [md5, stem]) {
    if (candidate.length >= 16 && /^[0-9A-F]+$/.test(candidate)) return candidate;
  }
  if (md5) return md5;
  if (stem) return stem;
  return String(element.fileToken ?? '').slice(0, 32) || '';
}

/** 把 /捂脸、[捂脸] 这类消息文案剥成干净名字。 */
function cleanFaceName(raw?: string): string {
  if (!raw) return '';
  return raw
    .replace(/^[\s[\]/（(]+/, '')
    .replace(/[\s[\]/）)]+$/, '')
    .trim();
}

/** 次数降序、同次数字典序 —— 稳定，不给随机性留空间。 */
function rankWords(a: VoiceWord, b: VoiceWord): number {
  return b.count - a.count || a.word.localeCompare(b.word, 'zh');
}

/**
 * 口头禅优先取**三个汉字以上**的词 —— 两个字的很容易被「正在 / 应该 / 但是」
 * 这类介系虚词洗榜，三个字以上更像一句真会挂在嘴边的话。完全没有够长的汉字词时
 * （聊天以英文 / 短词为主）退回总榜第一，页面仍有一个主角。
 */
function pickCatchphrase(words: VoiceWord[]): VoiceWord | null {
  if (words.length === 0) return FALLBACK_WORD;
  const chinese = words.find(
    (entry) => /\p{Script=Han}/u.test(entry.word) && [...entry.word].length >= 3,
  );
  return chinese ?? words[0]!;
}

/** 去重后截前 N 个：word 已进 cloud 就不重复放。 */
function trimCloud(words: VoiceWord[], max: number): VoiceWord[] {
  const out: VoiceWord[] = [];
  const seen = new Set<string>();
  for (const entry of words) {
    if (seen.has(entry.word)) continue;
    seen.add(entry.word);
    out.push(entry);
    if (out.length >= max) break;
  }
  return out;
}
