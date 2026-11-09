export declare const SOCKET_SIGN_UP_URL: string
export declare const SFW_DOCS_URL: string
export declare const SFW_INSTALL_COMMAND: string

export type InstallEcosystem = 'cargo' | 'npm' | 'pip' | 'pnpm' | 'uv' | 'yarn'

export interface ShellToken {
  type: 'operator' | 'word'
  value: string
  start: number
  end?: number | undefined
}

export interface UnprotectedInstall {
  ecosystem: InstallEcosystem
  command: string
  suggestion: string
}

export interface InstallGateEnv {
  [name: string]: string | undefined
}

export interface EvaluateInstallCommandOptions {
  cwd?: string | undefined
  env?: InstallGateEnv | undefined
}

export type InstallGateResult =
  | { decision: 'allow' }
  | {
      decision: 'deny'
      installs: UnprotectedInstall[]
      sfwInstalled: boolean
      agentMessage: string
      userMessage: string
    }

export declare function tokenizeShellCommand(command: string): ShellToken[]
export declare function splitShellSegments(tokens: ShellToken[]): ShellToken[][]
export declare function commandBaseName(word: string): string
export declare function isSfwSelfInstall(
  words: ShellToken[],
  from: number,
): boolean
export declare function classifyInstall(
  words: ShellToken[],
  index: number,
): InstallEcosystem | undefined
export declare function findUnprotectedInstalls(
  command: unknown,
  depth?: number,
): UnprotectedInstall[]
export declare function isSfwOnPath(env: InstallGateEnv | undefined): boolean
export declare function evaluateInstallCommand(
  command: unknown,
  options?: EvaluateInstallCommandOptions,
): InstallGateResult
