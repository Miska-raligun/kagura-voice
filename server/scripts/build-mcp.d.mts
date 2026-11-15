// build-mcp.mjs 的类型（测试里 import 它）
export const COMPONENT_ENTRIES: Record<string, [string, string]>;
export function buildComponent(name: string): Promise<Buffer>;
export function buildComponents(): Promise<Record<string, { sha256: string; size: number; bytes: Buffer }>>;
export function sourceStamp(): number;
