import type { InstallEcosystem } from './install-gate.mjs'
import type { ShellToken } from './shell-words.mjs'

export interface ClassifyContext {
  cwd?: string | undefined
}

export declare function findSubcommand(
  words: ShellToken[],
  from: number,
  valueFlags: ReadonlySet<string>,
): { index: number; value: string } | undefined
export declare function positionalArgs(
  words: ShellToken[],
  from: number,
  valueFlags?: ReadonlySet<string>,
): string[]
export declare function hasFlag(
  words: ShellToken[],
  from: number,
  names: ReadonlySet<string>,
): boolean
export declare function isSfwSelfInstall(
  words: ShellToken[],
  from: number,
  sub: { index: number; value: string },
): boolean
export declare function npxFetches(
  words: ShellToken[],
  from: number,
  cwd: string | undefined,
): boolean
export declare function classifyInstall(
  words: ShellToken[],
  index: number,
  ctx?: ClassifyContext,
): Exclude<InstallEcosystem, 'unknown'> | undefined
