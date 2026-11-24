/**
 * 显式审核过的只读能力；新工具默认拒绝，不能用名称前缀推断权限。
 *
 * `list_accounts` 只读本机账号配置文件；`switch_account` 严格来说不是只读（它让
 * 后续查询落到别的账号上），但它的副作用是「切换上下文」而不是「改数据」：不写库、
 * 不碰 QQ、不产生不可逆结果，而且切过去之后每个工具本身仍然受各自权限约束。
 * 因此两者都放进外部 MCP 的可见集合，并在 `docs/guide/mcp-server.md` 里写清
 * 「令牌持有者可以切换账号」这条语义。
 */
/** 由桌面 MCP 网关处理，不进入账号工作进程或内置助手的注册表。 */
export const SELECT_OPEN_ACCOUNT_TOOL = 'select_open_account';

export const CAPABILITY_TOOLS = ['list_capabilities', 'get_capability', 'call_capability'] as const;

export function isCapabilityTool(name: string): boolean {
  return CAPABILITY_TOOLS.some((tool) => tool === name);
}

/** 有 QQ 操作授权的桌面 MCP 可通过目录调用这些已实现的操作。 */
export const MCP_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'send_text_message',
  'send_poke',
  'set_message_reaction',
  'send_group_signup',
]);

const READ_ONLY_TOOLS = new Set([
  'list_capabilities',
  'get_capability',
  'list_settings',
  'list_features',
  'get_feature',
  'list_mail_folders',
  'list_mail_messages',
  'get_mail_message',
  'download_mail_attachment',
  'list_accounts',
  'switch_account',
  'search_messages',
  'search_local_resources',
  'get_local_collection',
  'search_in_conversation',
  'find_people_who_mentioned',
  'list_conversations',
  'get_messages',
  'list_groups',
  'list_buddies',
  'search_buddies',
  'search_groups',
  'get_self_profile',
  'get_message_performance',
  'find_contact',
  'list_group_members',
  'list_friends_by_intimacy',
  'get_user_profile',
  'get_group_info',
  'get_group_essence',
  'get_group_bulletins',
  'list_user_groups',
  'get_buddy_analytics',
  'inspect_timeline',
  'rank_friends_by_activity',
  'rank_my_groups_by_activity',
  'get_group_activity',
  'get_daily_digest',
  'get_period_overview',
  'compare_periods',
  'get_messages_by_date',
  'get_anti_recall_status',
  'list_recalled_messages',
  'list_deleted_messages',
  'get_forward_messages',
  'get_message_details',
  'get_chat_image_file',
  'download_chat_video',
  'get_ocr_status',
  'analyze_chat_image',
  'list_dataline_conversations',
  'get_dataline_messages',
  'list_guild_direct_sessions',
  'get_guild_direct_messages',
  'list_collections',
  'decode_blob',
  'list_databases',
  'list_db_tables',
  'get_db_columns',
  'get_peer_stats',
  'get_group_honor',
  'get_group_albums',
  'get_group_album_photos',
  'list_group_files',
  'get_qzone_profile',
  'get_friend_dress',
  'get_self_dress',
  'get_friend_mutual_mark',
  'get_dress_mall',
  'get_dress_resource_url',
  'search_market_emoji',
  'get_market_pack_detail',
  'decode_redbag_packet',
  'get_red_bag_passwords',
  'get_red_bag_detail',
]);

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name);
}

export function isMcpTool(name: string): boolean {
  return isReadOnlyTool(name) || name === 'call_capability';
}

/** 切换账号有副作用；沙箱里的脚本与能力调用只可执行审核过的读取。 */
export function isAssistantToolReadOnly(
  name: string,
  permissionMode: 'sandbox' | 'unrestricted' = 'unrestricted',
): boolean {
  return (
    (name !== 'switch_account' && isReadOnlyTool(name)) ||
    (permissionMode === 'sandbox' && (name === 'run_js' || name === 'call_capability'))
  );
}

/**
 * 沙箱（内置助手的默认权限）能用的工具。
 *
 * 比 {@link isReadOnlyTool} 更窄：`switch_account` 虽然进了外部 MCP 的可见集合，
 * 但它**不能**被沙箱内的脚本 / 助手顺手调用 —— 切号会关掉当前会话、让本轮正在进行的
 * 查询全部作废，属于用户该亲自决定的事，必须显式开「任意权限」才允许。
 */
export function isSandboxTool(name: string): boolean {
  return isAssistantToolReadOnly(name, 'sandbox');
}
