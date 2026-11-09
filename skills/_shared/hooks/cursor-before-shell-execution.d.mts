import type { InstallGateEnv } from './install-gate.mjs'

export interface CursorShellHookInput {
  command?: unknown
  cwd?: string | undefined
}

export type CursorShellHookResponse =
  | { permission: 'allow' }
  | { permission: 'deny'; user_message: string; agent_message: string }

export declare function buildCursorHookResponse(
  input: unknown,
  env: InstallGateEnv | undefined,
): CursorShellHookResponse
export declare function buildCursorHookFailure(
  error: unknown,
): CursorShellHookResponse
export declare function readStdin(
  stream: NodeJS.ReadableStream,
): Promise<string>
export declare function runCursorHook(
  stream: NodeJS.ReadableStream,
  env: InstallGateEnv | undefined,
): Promise<CursorShellHookResponse>
export declare function isEntryScript(
  moduleUrl: string,
  argvPath: string | undefined,
): boolean
