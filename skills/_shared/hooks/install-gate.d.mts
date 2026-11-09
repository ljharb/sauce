import type { ShellToken } from './shell-words.mjs'

export declare const SOCKET_SIGN_UP_URL: string
export declare const SFW_DOCS_URL: string
export declare const SFW_INSTALL_COMMAND: string

export type InstallEcosystem =
  | 'cargo'
  | 'npm'
  | 'pip'
  | 'pnpm'
  | 'unknown'
  | 'uv'
  | 'yarn'

export interface UnprotectedInstall {
  ecosystem: InstallEcosystem
  command: string
  suggestion: string
  reason?: string | undefined
}

export interface InstallGateEnv {
  [name: string]: string | undefined
}

export interface FindUnprotectedInstallsOptions {
  platform?: string | undefined
}

export interface EvaluateInstallCommandOptions {
  cwd?: string | undefined
  env?: InstallGateEnv | undefined
  platform?: string | undefined
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

export declare function commandBaseName(word: string): string
export declare function findSubcommand(
  words: ShellToken[],
  from: number,
  verbs: ReadonlySet<string>,
): { index: number; value: string } | undefined
export declare function isSfwSelfInstall(
  words: ShellToken[],
  from: number,
  sub: { index: number; value: string },
): boolean
export declare function classifyInstall(
  words: ShellToken[],
  index: number,
  atCommand?: boolean,
): InstallEcosystem | undefined
export declare function nestedScripts(
  words: ShellToken[],
  index: number,
  heredocs: string[],
): { scripts: string[]; unverifiable?: string | undefined }
export declare function findUnprotectedInstalls(
  command: unknown,
  options?: FindUnprotectedInstallsOptions,
): UnprotectedInstall[]
export declare function isSfwOnPath(env: InstallGateEnv | undefined): boolean
export declare function evaluateInstallCommand(
  command: unknown,
  options?: EvaluateInstallCommandOptions,
): InstallGateResult
