import { expect, it } from 'vitest';
import { isReadOnlyTool, isSandboxTool } from '../src/main/mcp/tool_permissions';

it('指定聊天图片分析可用于助手默认模式和只读 MCP，不开放任意未知工具', () => {
  expect(isReadOnlyTool('analyze_chat_image')).toBe(true);
  expect(isSandboxTool('analyze_chat_image')).toBe(true);
  expect(isReadOnlyTool('analyze_unknown_local_file')).toBe(false);
});
