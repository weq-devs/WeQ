/**
 * Install WeQ's local MCP server into AI coding agents (Claude Code, Codex,
 * Cursor, VS Code, Cline/Roo/Kilo, Gemini CLI, …).
 *
 * This is a direct TypeScript port of ida-pro-mcp's `installer_data.py` +
 * `installer.py` (the 10k-star MCP installer): the per-OS config paths and
 * "where does this client store its mcp servers" rules are copied verbatim.
 * The differences are only WeQ-specific:
 *
 *   - server name is `weq` (instead of `ida-pro-mcp`);
 *   - the server is Streamable HTTP on 127.0.0.1 and every request must carry
 *     `Authorization: Bearer <token>`, so each generated entry includes the
 *     header (Codex stores it as `http_headers` in TOML);
 *   - we never create a second `weq` entry — existing entries are detected and
 *     either skipped (already current) or refreshed (stale port/token).
 *
 * Only the global/user-level scope is written (same semantics as the WeQ
 * settings page: "install into agents that already exist on this machine").
 * Writes are atomic (temp file + rename) exactly like ida-pro-mcp.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Server key written into every agent's mcp server map. */
export const MCP_SERVER_NAME = 'weq';

/** A mcpServers container spec inside a JSON config file. */
interface JsonServersSpec {
  kind: 'json';
  /**
   * Top-level wrapper key when the map is nested (VS Code global settings:
   * `mcp.servers`), otherwise null (most clients: top-level `mcpServers`,
   * Opencode: top-level `mcp`).
   */
  topKey: string | null;
  /** Key of the actual server map (`mcpServers` / `servers` / `mcp`). */
  serversKey: string;
}

/** Codex's config is TOML with a top-level `[mcp_servers.<name>]` table. */
interface TomlServersSpec {
  kind: 'toml';
}

type ServersSpec = JsonServersSpec | TomlServersSpec;

interface AgentTargetDef {
  /** Stable key, used by the UI for multi-select. */
  key: string;
  /** Display name. */
  name: string;
  /** Absolute path of the config file (dir is created lazily on install). */
  configPath: string;
  /** How to locate the server map inside the file. */
  spec: ServersSpec;
}

export interface McpAgentTarget {
  key: string;
  name: string;
  configPath: string;
  /** Config dir / file was found on this machine (the "本地可用 agent"). */
  available: boolean;
  /** A `weq` entry already exists. */
  installed: boolean;
  /** Existing entry points at the same url + token (nothing to refresh). */
  upToDate: boolean;
  /** Present when the config file exists but could not be parsed. */
  error?: string;
}

export type McpAgentInstallStatus = 'installed' | 'updated' | 'up-to-date' | 'skipped' | 'error';

export interface McpAgentInstallResult {
  key: string;
  name: string;
  configPath: string;
  status: McpAgentInstallStatus;
  message?: string;
}

export interface McpAgentInstallOptions {
  /** Base server url, e.g. `http://127.0.0.1:48765`. */
  url: string;
  token: string;
}

const home = (): string => os.homedir();

/** Join under the home dir (all paths below are user-scope). */
const homePath = (...parts: string[]): string => path.join(home(), ...parts);

function appData(...parts: string[]): string {
  const root = process.env.APPDATA ?? homePath('AppData', 'Roaming');
  return path.join(root, ...parts);
}

/** macOS "~/Library/Application Support" helper. */
const librarySupport = (...parts: string[]): string =>
  homePath('Library', 'Application Support', ...parts);

/** Linux / Windows VSCode-ish user config root. */
const codeUserDir = (...parts: string[]): string =>
  process.platform === 'win32'
    ? appData('Code', 'User', ...parts)
    : process.platform === 'darwin'
      ? librarySupport('Code', 'User', ...parts)
      : homePath('.config', 'Code', 'User', ...parts);

const codeInsidersUserDir = (...parts: string[]): string =>
  process.platform === 'win32'
    ? appData('Code - Insiders', 'User', ...parts)
    : process.platform === 'darwin'
      ? librarySupport('Code - Insiders', 'User', ...parts)
      : homePath('.config', 'Code - Insiders', 'User', ...parts);

const clineGlobalStorage = (...parts: string[]): string =>
  codeUserDir('globalStorage', 'saoudrizwan.claude-dev', 'settings', ...parts);

const rooGlobalStorage = (...parts: string[]): string =>
  codeUserDir('globalStorage', 'rooveterinaryinc.roo-cline', 'settings', ...parts);

const kiloGlobalStorage = (...parts: string[]): string =>
  codeUserDir('globalStorage', 'kilocode.kilo-code', 'settings', ...parts);

const jsonServers = (key: string, spec: Partial<JsonServersSpec> = {}): ServersSpec => ({
  kind: 'json',
  topKey: null,
  serversKey: key,
  ...spec,
});

/** VSCode-family special structure: `mcp.servers` in settings.json. */
const vscodeServers = (): JsonServersSpec => ({
  kind: 'json',
  topKey: 'mcp',
  serversKey: 'servers',
});

const tomlServers = (): ServersSpec => ({ kind: 'toml' });

const topMcpServers = (): ServersSpec => jsonServers('mcpServers');

/**
 * Global (user-level) targets, mirroring ida-pro-mcp's `get_global_configs`.
 * Paths follow the OS conventions of that project exactly.
 */
function globalTargetDefs(): AgentTargetDef[] {
  const def = (
    key: string,
    name: string,
    configPath: string,
    spec: ServersSpec,
  ): AgentTargetDef => ({ key, name, configPath, spec });

  const common: AgentTargetDef[] = [
    def(
      'cline',
      'Cline',
      path.join(clineGlobalStorage(), 'cline_mcp_settings.json'),
      topMcpServers(),
    ),
    def(
      'roo-code',
      'Roo Code',
      path.join(rooGlobalStorage(), 'mcp_settings.json'),
      topMcpServers(),
    ),
    def(
      'kilo-code',
      'Kilo Code',
      path.join(kiloGlobalStorage(), 'mcp_settings.json'),
      topMcpServers(),
    ),
    def('cursor', 'Cursor', homePath('.cursor', 'mcp.json'), topMcpServers()),
    def(
      'windsurf',
      'Windsurf',
      homePath('.codeium', 'windsurf', 'mcp_config.json'),
      topMcpServers(),
    ),
    def('claude-code', 'Claude Code', homePath('.claude.json'), topMcpServers()),
    def('lm-studio', 'LM Studio', homePath('.lmstudio', 'mcp.json'), topMcpServers()),
    def('codex', 'Codex', homePath('.codex', 'config.toml'), tomlServers()),
    def('kimi-code', 'Kimi Code', homePath('.kimi-code', 'mcp.json'), topMcpServers()),
    def('gemini-cli', 'Gemini CLI', homePath('.gemini', 'settings.json'), topMcpServers()),
    def('qwen-coder', 'Qwen Coder', homePath('.qwen', 'settings.json'), topMcpServers()),
    def('copilot-cli', 'Copilot CLI', homePath('.copilot', 'mcp-config.json'), topMcpServers()),
    def('crush', 'Crush', homePath('crush.json'), topMcpServers()),
    def('augment-code', 'Augment Code', path.join(codeUserDir(), 'settings.json'), topMcpServers()),
    def('qodo-gen', 'Qodo Gen', path.join(codeUserDir(), 'settings.json'), topMcpServers()),
    def(
      'antigravity-ide',
      'Antigravity IDE',
      homePath('.gemini', 'config', 'mcp_config.json'),
      topMcpServers(),
    ),
    def('warp', 'Warp', homePath('.warp', 'mcp_config.json'), topMcpServers()),
    def('amazon-q', 'Amazon Q', homePath('.aws', 'amazonq', 'mcp_config.json'), topMcpServers()),
    def(
      'opencode',
      'Opencode',
      homePath('.config', 'opencode', 'opencode.json'),
      jsonServers('mcp'),
    ),
    def('kiro', 'Kiro', homePath('.kiro', 'mcp_config.json'), topMcpServers()),
    def('trae', 'Trae', homePath('.trae', 'mcp_config.json'), topMcpServers()),
    def('vs-code', 'VS Code', path.join(codeUserDir(), 'settings.json'), vscodeServers()),
    def(
      'vs-code-insiders',
      'VS Code Insiders',
      path.join(codeInsidersUserDir(), 'settings.json'),
      vscodeServers(),
    ),
  ];

  if (process.platform === 'win32' || process.platform === 'darwin') {
    common.push(
      def(
        'claude',
        'Claude',
        process.platform === 'win32'
          ? appData('Claude', 'claude_desktop_config.json')
          : librarySupport('Claude', 'claude_desktop_config.json'),
        topMcpServers(),
      ),
    );
  }

  if (process.platform === 'darwin') {
    common.push(
      def('boltai', 'BoltAI', librarySupport('BoltAI', 'config.json'), topMcpServers()),
      def(
        'perplexity',
        'Perplexity',
        librarySupport('Perplexity', 'mcp_config.json'),
        topMcpServers(),
      ),
    );
  }

  if (process.platform === 'win32') {
    common.push(def('zed', 'Zed', appData('Zed', 'settings.json'), topMcpServers()));
  } else if (process.platform === 'linux') {
    common.push(def('zed', 'Zed', homePath('.config', 'zed', 'settings.json'), topMcpServers()));
  } else {
    common.push(def('zed', 'Zed', librarySupport('Zed', 'settings.json'), topMcpServers()));
  }

  return common;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a JSON config file. Returns null when missing or unreadable. */
function readJsonConfig(configPath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(configPath, 'utf8').trim();
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Port of `_get_mcp_servers_view`: return (creating as needed) the object that
 * holds server entries inside `config`, based on the target's config shape.
 */
function getOrCreateServersView(
  config: Record<string, unknown>,
  def: AgentTargetDef,
): Record<string, unknown> {
  const spec = def.spec;
  if (spec.kind === 'toml') {
    throw new Error('TOML server maps are managed via section edit, not JSON view');
  }
  let container: unknown = spec.topKey ? config[spec.topKey] : config;
  if (spec.topKey && container === undefined) {
    const next: Record<string, unknown> = {};
    config[spec.topKey] = next;
    container = next;
  }
  if (!isRecord(container)) {
    throw new Error(`配置缺少 ${spec.topKey ? `"${spec.topKey}"` : '顶层'} 对象，已中止写入`);
  }
  const view = container[spec.serversKey];
  if (view === undefined) {
    const next: Record<string, unknown> = {};
    container[spec.serversKey] = next;
    return next;
  }
  if (!isRecord(view)) {
    throw new Error(`"${spec.serversKey}" 不是对象，已中止写入`);
  }
  return view;
}

/** Read-only variant of `getOrCreateServersView` (never mutates config). */
function findServersView(
  config: Record<string, unknown>,
  def: AgentTargetDef,
): Record<string, unknown> | null {
  const spec = def.spec;
  if (spec.kind === 'toml') return null;
  const container = spec.topKey ? config[spec.topKey] : config;
  if (!isRecord(container)) return null;
  const view = container[spec.serversKey];
  return isRecord(view) ? view : null;
}

function isToml(def: AgentTargetDef): boolean {
  return def.spec.kind === 'toml';
}

/**
 * The exact entry we want in each client. Ports ida-pro-mcp's remote
 * `generate_mcp_config` shapes; the added `headers` carry WeQ's bearer token.
 */
function buildWeqEntry(
  def: AgentTargetDef,
  { url, token }: McpAgentInstallOptions,
): Record<string, unknown> {
  const headers = { Authorization: `Bearer ${token}` };
  switch (def.name) {
    case 'Opencode':
      return { type: 'remote', url, headers };
    case 'Claude':
    case 'Claude Code':
      return { type: 'http', url, headers };
    case 'Antigravity IDE':
      return { type: 'http', serverUrl: url, headers };
    default:
      return { type: 'http', url, headers };
  }
}

/**
 * Whether a def looks like it's installed on this machine. Mirrors ida-pro-mcp
 * ("config dir found") except that targets whose config dir is the home dir
 * (Claude Code / Crush) require the actual config file instead, so the home dir
 * existing on every machine doesn't make them "available".
 */
function isTargetAvailable(def: AgentTargetDef): boolean {
  if (fs.existsSync(def.configPath)) return true;
  const configDir = path.dirname(def.configPath);
  if (configDir === home()) return false;
  return fs.existsSync(configDir);
}

/** Parse a TOML table header into its dotted path (`[mcp_servers.weq]`). */
function tomlTablePath(header: string): string[] | null {
  const inner = header.slice(1, -1).trim();
  if (!inner) return null;
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of inner) {
    if (ch === '"') {
      quoted = !quoted;
    } else if (ch === '.' && !quoted) {
      if (current) parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts.length ? parts : null;
}

function isTopLevelSection(line: string, path: string[]): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith('[') || trimmed.startsWith('[[') || !trimmed.endsWith(']')) {
    return false;
  }
  const parts = tomlTablePath(trimmed);
  if (!parts) return false;
  return (
    parts.length === path.length && parts.every((part, i) => part.replace(/^"|"$/g, '') === path[i])
  );
}

/** Return all line indices that begin a top-level `[mcp_servers.weq]` section. */
function tomlSectionHeaderIndexes(lines: string[], sectionPath: string[]): number[] {
  const indexes: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line !== undefined && isTopLevelSection(line, sectionPath)) indexes.push(i);
  }
  return indexes;
}

/**
 * Remove every `[mcp_servers.weq]` block (including any `weq.*` sub-tables)
 * from `lines` and return the remaining lines, so re-running install never
 * leaves a duplicate table in Codex's config.
 */
function tomlRemoveWeqSections(lines: string[], sectionPath: string[]): string[] {
  const nextLines: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trimStart();
    const isHeader = trimmed.startsWith('[') && trimmed.endsWith(']');
    if (isHeader) {
      const parts = tomlTablePath(trimmed);
      if (parts) {
        skipping =
          parts.length >= sectionPath.length &&
          parts.slice(0, sectionPath.length).every((p, i) => p === sectionPath[i]);
        if (skipping) continue;
      }
    }
    if (!skipping) nextLines.push(line);
  }
  return nextLines;
}

function tomlEscape(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function tomlUnquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\');
  }
  return trimmed;
}

/** Serialize a `[mcp_servers.weq]` block (url + inline Authorization header). */
function tomlServerBlock(url: string, token: string): string {
  const header = `[mcp_servers.${MCP_SERVER_NAME}]`;
  return [
    header,
    `url = ${tomlEscape(url)}`,
    `http_headers = { "Authorization" = ${tomlEscape(`Bearer ${token}`)} }`,
    '',
  ].join('\n');
}

/** Best-effort parse of the current `weq` entry inside a Codex config. */
function readTomlWeqEntry(configPath: string): Record<string, unknown> | null {
  const sectionPath = ['mcp_servers', MCP_SERVER_NAME];
  let lines: string[];
  try {
    lines = fs.readFileSync(configPath, 'utf8').split('\n');
  } catch {
    return null;
  }

  const entry: Record<string, unknown> = {};
  let inside = false;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const parts = tomlTablePath(trimmed);
      inside =
        !!parts &&
        parts.length >= sectionPath.length &&
        parts.slice(0, sectionPath.length).every((p, i) => p === sectionPath[i]);
      continue;
    }
    if (!inside || !trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key === 'url') {
      entry.url = tomlUnquote(value);
    } else if (key === 'http_headers' && value.startsWith('{')) {
      const auth = value.match(/"Authorization"\s*=\s*("[^"]*")/);
      const header = auth?.[1];
      if (header !== undefined) entry.authorization = tomlUnquote(header);
    }
  }
  return Object.keys(entry).length ? entry : null;
}

/**
 * Idempotent TOML upsert for Codex. Preserves everything outside the
 * `[mcp_servers.weq]` block (comments included); the existing block is removed
 * first, so duplicates can never accumulate.
 */
function writeTomlServer(
  configPath: string,
  { url, token }: McpAgentInstallOptions,
): 'up-to-date' | 'installed' | 'updated' {
  const sectionPath = ['mcp_servers', MCP_SERVER_NAME];
  let raw = '';
  try {
    raw = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  } catch {
    throw new Error('无法读取 Codex 配置文件');
  }

  const lines = raw.split('\n');
  const existing = tomlSectionHeaderIndexes(lines, sectionPath).length > 0;
  if (existing) {
    const entry = readTomlWeqEntry(configPath);
    if (
      entry !== null &&
      entriesEqual(entry, {
        url,
        authorization: `Bearer ${token}`,
      })
    ) {
      return 'up-to-date';
    }
  }
  const block = tomlServerBlock(url, token);
  let body = tomlRemoveWeqSections(lines, sectionPath).join('\n').trimEnd();
  if (body) body += '\n\n';
  body += block;
  atomicWriteFile(configPath, body);
  return existing ? 'updated' : 'installed';
}

function atomicWriteFile(configPath: string, data: string): void {
  const configDir = path.dirname(configPath);
  fs.mkdirSync(configDir, { recursive: true });
  const tmpPath = path.join(
    configDir,
    `.weq-mcp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, data, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
}

/**
 * Read + upsert a JSON config file. Throws when the existing file is invalid
 * (we never overwrite a config we cannot parse).
 */
function writeJsonServer(
  configPath: string,
  def: AgentTargetDef,
  options: McpAgentInstallOptions,
): 'up-to-date' | 'installed' | 'updated' {
  const existed = fs.existsSync(configPath);
  let config: Record<string, unknown>;
  if (existed) {
    const parsed = readJsonConfig(configPath);
    if (!parsed) {
      throw new Error('配置文件不是合法 JSON，已跳过（避免覆盖）');
    }
    config = parsed;
  } else {
    config = {};
  }

  const view = getOrCreateServersView(config, def);
  const wasInstalled = Object.hasOwn(view, MCP_SERVER_NAME);
  const expected = buildWeqEntry(def, options);
  if (wasInstalled && JSON.stringify(view[MCP_SERVER_NAME]) === JSON.stringify(expected)) {
    return 'up-to-date';
  }
  view[MCP_SERVER_NAME] = expected;
  atomicWriteFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return wasInstalled ? 'updated' : 'installed';
}

/** Human-readable summary for each install result. */
function statusMessage(def: AgentTargetDef, status: McpAgentInstallStatus, error?: string): string {
  switch (status) {
    case 'installed':
      return `已写入 ${def.name} 的 MCP 配置`;
    case 'updated':
      return `已刷新 ${def.name} 中已有的 weq 配置（未重复添加）`;
    case 'up-to-date':
      return `${def.name} 已有最新 weq 配置，跳过`;
    case 'skipped':
      return `${def.name} 不可用，跳过`;
    case 'error':
      return error ?? `写入 ${def.name} 失败`;
  }
}

function entriesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Scan every supported agent and report availability + install state.
 * `current` is the live MCP config ({url, token}); when provided, installed
 * agents whose entry still matches it are marked `upToDate`.
 */
export function listMcpAgentTargets(current?: McpAgentInstallOptions): McpAgentTarget[] {
  return globalTargetDefs().map((def) => {
    const base: McpAgentTarget = {
      key: def.key,
      name: def.name,
      configPath: def.configPath,
      available: isTargetAvailable(def),
      installed: false,
      upToDate: false,
    };
    if (!base.available || !fs.existsSync(def.configPath)) return base;

    try {
      if (isToml(def)) {
        const raw = fs.readFileSync(def.configPath, 'utf8');
        base.installed =
          tomlSectionHeaderIndexes(raw.split('\n'), ['mcp_servers', MCP_SERVER_NAME]).length > 0;
        if (!current) {
          base.upToDate = base.installed;
        } else {
          const entry = readTomlWeqEntry(def.configPath);
          base.upToDate =
            base.installed &&
            entry !== null &&
            entriesEqual(entry, {
              url: current.url,
              authorization: `Bearer ${current.token}`,
            });
        }
      } else {
        const config = readJsonConfig(def.configPath);
        const view = config ? findServersView(config, def) : null;
        const existing = view?.[MCP_SERVER_NAME];
        base.installed = existing !== undefined;
        base.upToDate =
          base.installed &&
          (current === undefined || entriesEqual(existing, buildWeqEntry(def, current)));
      }
    } catch {
      base.error = '配置文件读取失败';
    }
    return base;
  });
}

/**
 * Install (or refresh) WeQ into the requested agents. Never writes a second
 * `weq` entry: JSON entries are upserted under the single `weq` key, and the
 * TOML block is removed before being re-appended.
 */
export function installMcpAgents(
  targetKeys: string[],
  options: McpAgentInstallOptions,
): McpAgentInstallResult[] {
  const wanted = new Set(targetKeys);
  const results: McpAgentInstallResult[] = [];

  for (const def of globalTargetDefs()) {
    if (!wanted.has(def.key)) continue;
    const result: McpAgentInstallResult = {
      key: def.key,
      name: def.name,
      configPath: def.configPath,
      status: 'installed',
    };
    try {
      if (!isTargetAvailable(def)) {
        result.status = 'skipped';
        result.message = statusMessage(def, result.status);
        results.push(result);
        continue;
      }
      const status = isToml(def)
        ? writeTomlServer(def.configPath, options)
        : writeJsonServer(def.configPath, def, options);
      result.status = status;
      result.message = statusMessage(def, status);
    } catch (error) {
      result.status = 'error';
      result.message = statusMessage(
        def,
        'error',
        error instanceof Error ? error.message : String(error),
      );
    }
    results.push(result);
  }
  return results;
}
