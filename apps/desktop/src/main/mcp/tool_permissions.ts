/**
 * 显式审核过的只读能力；新工具默认拒绝，不能用名称前缀推断权限。
 *
 * `list_accounts` 只读本机账号配置文件；`switch_account` 严格来说不是只读（它让
 * 后续查询落到别的账号上），但它的副作用是「切换上下文」而不是「改数据」：不写库、
 * 不碰 QQ、不产生不可逆结果，而且切过去之后每个工具本身仍然受各自权限约束。
 * 因此两者都放进外部 MCP 的可见集合，并在 `docs/guide/mcp-server.md` 里写清
 * 「令牌持有者可以切换账号」这条语义。
 */
const READ_ONLY_TOOLS = new Set([
  'list_accounts',
  'switch_account',
  'search_messages',
  'search_in_conversation',
  'find_people_who_mentioned',
  'list_conversations',
  'get_messages',
  'list_groups',
  'list_buddies',
  'search_buddies',
  'search_groups',
  'get_self_profile',
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
  'get_ocr_status',
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

/**
 * 沙箱（内置助手的默认权限）能用的工具。
 *
 * 比 {@link isReadOnlyTool} 更窄：`switch_account` 虽然进了外部 MCP 的可见集合，
 * 但它**不能**被沙箱内的脚本 / 助手顺手调用 —— 切号会关掉当前会话、让本轮正在进行的
 * 查询全部作废，属于用户该亲自决定的事，必须显式开「任意权限」才允许。
 */
export function isSandboxTool(name: string): boolean {
  return name === 'run_js' || (isReadOnlyTool(name) && name !== 'switch_account');
}
