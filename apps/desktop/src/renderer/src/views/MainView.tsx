/**
 * Screen 3 — main view.
 *
 * Two panes:
 *   - Left  — recent-conversation list (recent_contact_v3_table)
 *   - Right — JSON-stringified messages for the selected conversation, paginated
 *
 * Conversations are keyed by `targetUid` (column 40021): peer uid for c2c, group
 * code for group. Messages come from c2c_msg_table / group_msg_table depending
 * on chat type. Avatars use QQ's public CDN:
 *   - c2c:   https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=<targetUin>
 *   - group: https://p.qlogo.cn/gh/<groupCode>/<groupCode>/0
 */

import { useState, type ReactElement } from 'react';
import { trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { client } from '../trpc/client';

const PAGE_SIZE = 50;

type ContactLike = { chatType: string | number; targetUid: string; targetUin: string };

/** Public-CDN avatar URL for a conversation (undefined → fall back to initial). */
function avatarSrc(c: ContactLike): string | undefined {
  const t = String(c.chatType);
  if (t.includes('GROUP')) return `https://p.qlogo.cn/gh/${c.targetUid}/${c.targetUid}/0`;
  if (t.includes('C2C') && c.targetUin && c.targetUin !== '0') {
    return `https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=${c.targetUin}`;
  }
  return undefined;
}

/** Short, human chat-type tag from the mapped ChatType name. */
function chatTypeTag(chatType: string | number): string {
  const s = String(chatType);
  if (s.includes('C2C')) return '私聊';
  if (s.includes('GROUP')) return '群聊';
  if (s.includes('GUILD')) return '频道';
  return s.replace('KCHATTYPE', '') || '其它';
}

export function MainView(): ReactElement {
  const utils = trpc.useUtils();
  const contacts = trpc.account.listRecentContacts.useQuery();
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const openedUin = useViewState((s) => s.openedUin);
  const goTo = useViewState((s) => s.goTo);
  const setOpenedUin = useViewState((s) => s.setOpenedUin);

  const selected = contacts.data?.find((c) => c.targetUid === selectedUid) ?? null;
  const isGroup = selected ? String(selected.chatType).includes('GROUP') : false;
  const isC2c = selected ? String(selected.chatType).includes('C2C') : false;

  const c2cMsgs = trpc.account.listC2cMessages.useQuery(
    { targetUid: selectedUid ?? '', limit: PAGE_SIZE, offset },
    { enabled: selectedUid !== null && isC2c },
  );
  const groupMsgs = trpc.account.listGroupMessages.useQuery(
    { targetGroupCode: selectedUid ?? '', limit: PAGE_SIZE, offset },
    { enabled: selectedUid !== null && isGroup },
  );
  const messages = isGroup ? groupMsgs : c2cMsgs;

  async function closeAccount(): Promise<void> {
    await client.bootstrap.closeAccount.mutate();
    setOpenedUin(null);
    goTo('bootstrap');
  }

  const refreshing = contacts.isFetching || messages.isFetching;

  /** Full refresh — invalidate every query so contacts + messages re-fetch. */
  function refreshAll(): void {
    void utils.invalidate();
  }

  return (
    <main className="flex h-screen font-sans bg-background text-foreground overflow-hidden">
      <aside className="w-72 border-r border-border flex flex-col bg-secondary/30">
        <div className="p-4 border-b border-border bg-background/50 backdrop-blur-md">
          <div className="flex items-center justify-between mb-3">
            <span className="text-lg font-bold tracking-tight">weQ</span>
            <span className="text-[10px] px-1.5 py-0.5 bg-primary/10 text-primary rounded-full font-medium uppercase tracking-wider">最近会话</span>
          </div>
          <div className="text-[11px] text-muted-foreground mb-2 px-1 font-medium">账号 (UIN): {openedUin}</div>
          <div className="flex gap-2">
            <button
              onClick={refreshAll}
              disabled={refreshing}
              title="全量刷新"
              className="flex-1 px-3 py-1.5 text-xs bg-background border border-border text-foreground rounded-md shadow-sm hover:bg-accent transition-all active:scale-[0.98] font-medium flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
              刷新
            </button>
            <button
              onClick={() => void closeAccount()}
              className="flex-1 px-3 py-1.5 text-xs bg-background border border-border text-foreground rounded-md shadow-sm hover:bg-accent transition-all active:scale-[0.98] font-medium"
            >
              退出账号
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {contacts.isLoading && (
            <div className="flex flex-col items-center justify-center h-32 space-y-2">
              <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <p className="text-xs text-muted-foreground">正在加载最近会话…</p>
            </div>
          )}
          {contacts.data && (
            <ul className="space-y-0.5">
              {contacts.data.map((c, idx) => {
                const name = c.targetDisplayName || c.targetRemark || c.targetUid;
                const preview = (c.preview as { displayText?: string } | null)?.displayText ?? '';
                const src = avatarSrc(c);
                const active = selectedUid === c.targetUid;
                return (
                  <li
                    key={c.targetUid || idx}
                    onClick={() => {
                      setSelectedUid(c.targetUid);
                      setOffset(0);
                    }}
                    className={`flex items-center gap-3 p-2.5 rounded-lg cursor-pointer transition-all ${
                      active
                        ? 'bg-primary text-primary-foreground shadow-md shadow-primary/20 scale-[1.02]'
                        : 'hover:bg-accent/50 text-foreground/80 hover:text-foreground'
                    }`}
                  >
                    <div className="relative shrink-0">
                      {src ? (
                        <img
                          src={src}
                          alt=""
                          width={40}
                          height={40}
                          className="rounded-full bg-background object-cover border border-black/5"
                          onError={(e) => (e.target as HTMLImageElement).classList.add('invisible')}
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-sm font-semibold text-muted-foreground border border-black/5">
                          {name.slice(0, 1)}
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-sm truncate">{name}</div>
                      <div className={`text-[11px] truncate ${active ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>
                        {preview || '（无预览）'}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${active ? 'bg-primary-foreground/15 text-primary-foreground/80' : 'bg-muted text-muted-foreground/70'}`}>
                        {chatTypeTag(c.chatType)}
                      </span>
                      <span className={`text-[10px] ${active ? 'text-primary-foreground/60' : 'text-muted-foreground/60'}`}>
                        {new Date(Number(c.sendTime) * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      <section className="flex-1 flex flex-col min-w-0 bg-background relative">
        {selected === null ? (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground bg-accent/5">
            <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mb-4">
              <svg className="w-8 h-8 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
            </div>
            <p className="text-sm font-medium italic">请从左侧选择一个会话开始浏览</p>
          </div>
        ) : (
          <>
            <header className="h-16 px-6 border-b border-border flex items-center justify-between bg-background/80 backdrop-blur-md z-10">
              <div className="flex items-center gap-3">
                <div className="font-bold text-base truncate max-w-md">
                  {selected.targetDisplayName || selected.targetRemark || selected.targetUid}
                </div>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground/70">
                  {chatTypeTag(selected.chatType)}
                </span>
                <div className="h-4 w-px bg-border mx-1" />
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                    disabled={offset === 0}
                    className="p-1.5 rounded-md hover:bg-accent disabled:opacity-30 transition-colors"
                    title="查看较新消息"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>
                  </button>
                  <button
                    onClick={() => setOffset((o) => o + PAGE_SIZE)}
                    className="p-1.5 rounded-md hover:bg-accent transition-colors"
                    title="查看较旧消息"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                  </button>
                </div>
              </div>
              <div className="text-[11px] font-bold text-muted-foreground bg-muted/50 px-2.5 py-1 rounded-full border border-border/50">
                第 {Math.floor(offset / PAGE_SIZE) + 1} 页
              </div>
            </header>

            <div className="flex-1 overflow-y-auto p-6 bg-accent/5">
              {!isC2c && !isGroup && (
                <div className="flex flex-col items-center justify-center text-muted-foreground py-20">
                  <p className="text-sm italic">该会话类型（{chatTypeTag(selected.chatType)}）此 demo 暂不支持消息浏览</p>
                </div>
              )}
              {(isC2c || isGroup) && messages.isLoading && (
                <div className="flex items-center justify-center py-20">
                  <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                </div>
              )}
              {(isC2c || isGroup) && messages.data && messages.data.length === 0 && (
                <div className="flex flex-col items-center justify-center text-muted-foreground py-20">
                  <p className="text-sm italic">该会话暂无可显示的消息</p>
                </div>
              )}
              {(isC2c || isGroup) && messages.data && messages.data.length > 0 && (
                <div className="max-w-4xl mx-auto">
                  <div className="flex items-center justify-between mb-4 px-2">
                    <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-widest">消息原文 (JSON 格式)</span>
                    <span className="text-[10px] text-muted-foreground/60 italic">当前页面显示 {messages.data.length} 条记录</span>
                  </div>
                  <pre className="whitespace-pre-wrap break-all text-[12px] font-mono bg-background shadow-md shadow-black/5 p-6 rounded-2xl border border-border/50 leading-relaxed text-foreground/80">
                    {JSON.stringify(messages.data, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}
                  </pre>
                  <div className="mt-8 text-center text-[11px] text-muted-foreground border-t border-border/50 pt-4 mb-10">
                    — 已显示本页全部内容 —
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
