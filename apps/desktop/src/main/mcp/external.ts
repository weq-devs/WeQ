/**
 * External MCP client hub.
 *
 * Lets the WeQ assistant reach tools hosted by *external* MCP servers the user
 * configures (assistant 设置 → 外部 MCP 服务器). Remote transports only —
 * Streamable HTTP first, falling back to the legacy SSE transport — so there's
 * no child-process spawning and packaging stays trivial.
 *
 * The hub aggregates every connected server's tools into a flat OpenAI
 * function-spec list (namespaced `mcp__<server>__<tool>` so they never collide
 * with the built-in {@link AI_TOOLS}), and routes `run(name, args)` back to the
 * owning server. Connections are established lazily in {@link specs} and reused;
 * a single server failing (bad URL, auth, offline) is isolated and never breaks
 * the others or the built-in tools.
 *
 * SDK client modules are imported via their `.js` subpaths exactly like
 * `./server.ts`; they're externalized at build time and loaded from
 * node_modules at runtime (NOT bundled — keep them out of EXCLUDE_FROM_EXTERNAL).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { getLogger, logErrorContext } from '@weq/service';
import type { OpenAiToolSpec } from './openai_tools';

const logger = getLogger().child({ scope: 'mcp-external' });

/** One configured remote MCP server (after normalization). */
export interface McpServerSpec {
  /** User-facing name; also seeds the tool namespace. */
  name: string;
  /** Endpoint URL (http/https). */
  url: string;
  /** Optional HTTP headers (e.g. Authorization). */
  headers?: Record<string, string>;
}

interface RemoteTool {
  /** Exposed (namespaced, sanitized) name handed to the model. */
  exposed: string;
  /** Original tool name on the server. */
  original: string;
  spec: OpenAiToolSpec;
}

interface Conn {
  spec: McpServerSpec;
  /** Stable identity for change detection (url + headers). */
  fingerprint: string;
  client?: Client;
  tools?: RemoteTool[];
  error?: string;
  /** In-flight connect, so concurrent ensure() calls don't double-connect. */
  connecting?: Promise<void>;
}

/** Per-server connection status, for the settings UI. */
export interface McpServerStatus {
  name: string;
  url: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

const NS = '__'; // namespace separator: mcp__<server>__<tool>

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'srv';
}

/**
 * Parse the user's raw config into normalized server specs. Accepts:
 *   1. Claude-Desktop-style JSON: `{"mcpServers":{"名字":{"url":"…","headers":{…}}}}`
 *      (also tolerates a bare `{"名字":{"url":…}}` object).
 *   2. One server per line: `名字=https://…` or just `https://…`.
 * Lines starting with `#` are comments. Invalid entries are skipped.
 */
export function parseMcpConfig(raw: string | undefined): McpServerSpec[] {
  const text = (raw ?? '').trim();
  if (!text) return [];

  // Try JSON first.
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const root =
        parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers
          ? (parsed.mcpServers as Record<string, unknown>)
          : parsed;
      const out: McpServerSpec[] = [];
      for (const [name, value] of Object.entries(root)) {
        if (!value || typeof value !== 'object') continue;
        const entry = value as { url?: unknown; headers?: unknown };
        const url = typeof entry.url === 'string' ? entry.url.trim() : '';
        if (!isHttpUrl(url)) continue;
        const headers =
          entry.headers && typeof entry.headers === 'object'
            ? Object.fromEntries(
                Object.entries(entry.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
              )
            : undefined;
        out.push({ name: name.trim() || url, url, ...(headers ? { headers } : {}) });
      }
      return dedupeNames(out);
    } catch {
      // fall through to line parsing
    }
  }

  // Line format.
  const out: McpServerSpec[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    let name = '';
    let url = trimmed;
    if (eq > 0 && isHttpUrl(trimmed.slice(eq + 1).trim())) {
      name = trimmed.slice(0, eq).trim();
      url = trimmed.slice(eq + 1).trim();
    }
    if (!isHttpUrl(url)) continue;
    out.push({ name: name || hostOf(url), url });
  }
  return dedupeNames(out);
}

/**
 * Validate the user's raw MCP config on explicit save, surfacing errors instead
 * of silently falling through. {@link parseMcpConfig} stays lenient (used on
 * startup / runtime where a throw would break the account); this strict pass is
 * only for the settings-save path so a mistyped JSON reaches the user as a clear
 * dialog rather than vanishing. Throws with a readable message; returns cleanly
 * when the config is empty or valid.
 */
export function validateMcpConfig(raw: string | undefined): void {
  const text = (raw ?? '').trim();
  if (!text) return;
  // Only the JSON form can fail "invisibly" (bad JSON → silently parsed as lines
  // → usually zero servers). The `名字=url` line form has no syntax to violate.
  if (text.startsWith('{')) {
    try {
      JSON.parse(text);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `外部 MCP 配置 JSON 解析失败：${detail}。请检查括号/引号/逗号，或改用「名字=https://…」每行一个的写法。`,
      );
    }
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Make server names unique (later duplicates get a numeric suffix). */
function dedupeNames(specs: McpServerSpec[]): McpServerSpec[] {
  const seen = new Map<string, number>();
  return specs.map((s) => {
    const base = s.name;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? s : { ...s, name: `${base}-${n + 1}` };
  });
}

function fingerprint(spec: McpServerSpec): string {
  return JSON.stringify({ url: spec.url, headers: spec.headers ?? {} });
}

/**
 * Manages connections to the user's external MCP servers and exposes their
 * tools to the assistant. One instance per account (built in app_context).
 */
export class ExternalMcpHub {
  private desired: McpServerSpec[] = [];
  private conns = new Map<string, Conn>();
  /** exposed tool name → owning server name + original tool name. */
  private toolIndex = new Map<string, { server: string; original: string }>();

  /**
   * Update the desired server set from raw config. Disposes connections that
   * were removed or whose endpoint changed; (re)connection happens lazily on
   * the next {@link specs}. Cheap + synchronous-safe to call from setConfig.
   */
  configure(raw: string | undefined): void {
    const next = parseMcpConfig(raw);
    this.desired = next;
    const wanted = new Map(next.map((s) => [s.name, s]));
    // Drop connections no longer wanted or whose fingerprint changed.
    for (const [name, conn] of [...this.conns.entries()]) {
      const want = wanted.get(name);
      if (!want || fingerprint(want) !== conn.fingerprint) {
        void this.closeConn(conn);
        this.conns.delete(name);
      }
    }
  }

  /** OpenAI tool specs for every reachable external tool (connects lazily). */
  async specs(): Promise<OpenAiToolSpec[]> {
    if (this.desired.length === 0) return [];
    await this.ensure();
    this.toolIndex.clear();
    const specs: OpenAiToolSpec[] = [];
    // Assign final, globally-unique exposed names here (server namespacing makes
    // cross-server collisions rare, but suffix-disambiguate to be safe), and
    // build the routing index in lockstep so run() always resolves correctly.
    for (const conn of this.conns.values()) {
      for (const t of conn.tools ?? []) {
        let name = t.exposed;
        for (let i = 1; this.toolIndex.has(name); i += 1) {
          const suffix = `_${i}`;
          name = t.exposed.slice(0, 64 - suffix.length) + suffix;
        }
        this.toolIndex.set(name, { server: conn.spec.name, original: t.original });
        specs.push({ ...t.spec, function: { ...t.spec.function, name } });
      }
    }
    return specs;
  }

  /** Run a namespaced external tool. Throws if unknown / server unreachable. */
  async run(name: string, args: Record<string, unknown>): Promise<unknown> {
    const ref = this.toolIndex.get(name);
    if (!ref) throw new Error(`未知的外部 MCP 工具：${name}`);
    const conn = this.conns.get(ref.server);
    if (!conn?.client) throw new Error(`外部 MCP 服务器「${ref.server}」未连接`);
    const res = (await conn.client.callTool({ name: ref.original, arguments: args })) as {
      isError?: boolean;
      content?: Array<{ type?: string; text?: string }>;
      structuredContent?: unknown;
    };
    if (res.structuredContent !== undefined) return res.structuredContent;
    const text = (res.content ?? [])
      .map((c) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
    if (res.isError) throw new Error(text || `外部工具 ${name} 执行失败`);
    return text || res.content || null;
  }

  /** Per-server status for the settings UI. */
  status(): McpServerStatus[] {
    return this.desired.map((s) => {
      const conn = this.conns.get(s.name);
      return {
        name: s.name,
        url: s.url,
        connected: !!conn?.client,
        toolCount: conn?.tools?.length ?? 0,
        error: conn?.error,
      };
    });
  }

  /** Close every connection. Call on account teardown. */
  async dispose(): Promise<void> {
    const conns = [...this.conns.values()];
    this.conns.clear();
    this.toolIndex.clear();
    this.desired = [];
    await Promise.all(conns.map((c) => this.closeConn(c)));
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Ensure every desired server has a connection attempt (parallel, isolated). */
  private async ensure(): Promise<void> {
    await Promise.all(
      this.desired.map(async (spec) => {
        let conn = this.conns.get(spec.name);
        if (conn?.client) return; // already connected
        if (!conn) {
          conn = { spec, fingerprint: fingerprint(spec) };
          this.conns.set(spec.name, conn);
        }
        if (!conn.connecting) conn.connecting = this.connect(conn);
        await conn.connecting.catch(() => {});
      }),
    );
  }

  private async connect(conn: Conn): Promise<void> {
    const { spec } = conn;
    const url = new URL(spec.url);
    const requestInit = spec.headers ? { headers: spec.headers } : undefined;
    try {
      const client = new Client({ name: 'weq-assistant', version: '0.1.0' }, { capabilities: {} });
      // Streamable HTTP first; fall back to legacy SSE on connect failure.
      try {
        await client.connect(new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined));
      } catch (httpErr) {
        try {
          await client.connect(new SSEClientTransport(url, requestInit ? { requestInit } : undefined));
        } catch {
          throw httpErr; // surface the primary (HTTP) error
        }
      }
      const list = (await client.listTools()) as {
        tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
      };
      conn.client = client;
      conn.tools = (list.tools ?? []).map((t) => this.toRemoteTool(spec.name, t));
      conn.error = undefined;
      logger.info('external mcp connected', {
        event: 'mcp-ext-connect',
        server: spec.name,
        tools: conn.tools.length,
      });
    } catch (error) {
      conn.client = undefined;
      conn.tools = [];
      conn.error = error instanceof Error ? error.message : String(error);
      logger.warn('external mcp connect failed', {
        event: 'mcp-ext-connect-error',
        server: spec.name,
        ...logErrorContext(error),
      });
    } finally {
      conn.connecting = undefined;
    }
  }

  private toRemoteTool(
    server: string,
    t: { name: string; description?: string; inputSchema?: unknown },
  ): RemoteTool {
    const exposed = this.exposedName(server, t.name);
    const parameters =
      t.inputSchema && typeof t.inputSchema === 'object'
        ? (t.inputSchema as Record<string, unknown>)
        : { type: 'object', properties: {} };
    return {
      exposed,
      original: t.name,
      spec: {
        type: 'function',
        function: {
          name: exposed,
          description: `[外部MCP:${server}] ${t.description ?? t.name}`,
          parameters,
        },
      },
    };
  }

  /** `mcp__<server>__<tool>`, sanitized + truncated to 64 chars. Final
   *  uniqueness (suffixing) is resolved in {@link specs}. */
  private exposedName(server: string, tool: string): string {
    return `mcp${NS}${sanitizeSegment(server)}${NS}${sanitizeSegment(tool)}`.slice(0, 64);
  }

  private async closeConn(conn: Conn): Promise<void> {
    try {
      await conn.client?.close();
    } catch {
      /* ignore close errors */
    }
  }
}

// ── app-wide singleton (one active account at a time) ──────────────────────

let hubSingleton: ExternalMcpHub | null = null;

/** The shared external-MCP hub, created on first use. */
export function getExternalMcpHub(): ExternalMcpHub {
  if (!hubSingleton) hubSingleton = new ExternalMcpHub();
  return hubSingleton;
}

/** Close all external MCP connections (account switch / logout / app quit). */
export async function disposeExternalMcp(): Promise<void> {
  await hubSingleton?.dispose();
}
