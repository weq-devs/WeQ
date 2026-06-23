/**
 * 群荣誉查询 — `qun.qq.com/interactive/honorlist`.
 *
 * Unlike the other cgis this one returns an HTML page; the data is embedded as a
 * `window.__INITIAL_STATE__ = {...};` blob we extract and parse. Each honor type
 * is a separate request: type 1 (龙王/群聊之火) lands in `talkativeList`, every
 * other type lands in `actorList`.
 *
 * Auth: cookie jar only (no bkn in the URL).
 */

import { cookieHeader, type WebCredential } from './credential';
import { webRequestText } from './http';

/** Honor categories exposed by the cgi (value = its `type` query param). */
export enum HonorType {
  /** 龙王 / 群聊之火 — most active. Returned in `talkativeList`. */
  Talkative = 1,
  /** 群聊炽焰 — top performers. */
  Performer = 2,
  /** 群聊传说 — legends. */
  Legend = 3,
  /** 快乐源泉 — emotion. */
  Emotion = 6,
}

export interface HonorMember {
  /** Member uin, or null when the cgi omits it. */
  uin: number | null;
  nickname: string;
  avatar: string;
  description: string;
}

interface RawHonorItem {
  uin?: number | string;
  name?: string;
  avatar?: string;
  desc?: string;
}

interface HonorInitialState {
  talkativeList?: RawHonorItem[];
  actorList?: RawHonorItem[];
}

/**
 * Fetch one honor list for a group. Returns `[]` when the page carries no data
 * (no permission / empty honor / parse miss).
 */
export async function getHonorList(
  cred: WebCredential,
  groupCode: string,
  type: HonorType,
): Promise<HonorMember[]> {
  const url = `https://qun.qq.com/interactive/honorlist?${new URLSearchParams({
    gc: groupCode,
    type: String(type),
  }).toString()}`;

  const html = await webRequestText(url, { method: 'GET', cookie: cookieHeader(cred) });

  const match = /window\.__INITIAL_STATE__=(.*?);/.exec(html);
  if (!match?.[1]) return [];

  let state: HonorInitialState;
  try {
    state = JSON.parse(match[1].trim()) as HonorInitialState;
  } catch {
    return [];
  }

  const list = type === HonorType.Talkative ? state.talkativeList : state.actorList;
  return (list ?? []).map((item) => ({
    uin: item.uin == null ? null : Number(item.uin),
    nickname: item.name ?? '',
    avatar: item.avatar ?? '',
    description: item.desc ?? '',
  }));
}
