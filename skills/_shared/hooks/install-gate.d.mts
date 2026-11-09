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
  cwd?: string | undefined
  platform?: string | undefined
}

export interface EvaluateInstallCommandOptions {
  cwd?: string | undefined
  env?: InstallGateEnv | undefined
  platform?: string | undefined
  strict?: boolean | undefined
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

export declare function findUnprotectedInstalls(
  command: unknown,
  options?: FindUnprotectedInstallsOptions,
): UnprotectedInstall[]
export declare function nextWorkingDirectory(
  cwd: string | undefined,
  words: ShellToken[],
): string | undefined
export declare function isSfwOnPath(env: InstallGateEnv | undefined): boolean
export declare function evaluateInstallCommand(
  command: unknown,
  options?: EvaluateInstallCommandOptions,
): InstallGateResult
