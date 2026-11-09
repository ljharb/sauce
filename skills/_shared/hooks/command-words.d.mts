import type { ShellSegment, ShellToken } from './shell-words.mjs'

export declare const ENV_ASSIGNMENT_RE: RegExp
export declare const POSIX_SHELLS: ReadonlySet<string>

export declare function commandBaseName(word: string): string
export declare function skipKeywords(words: ShellToken[]): number
export declare function resolveCommandWord(words: ShellToken[]): {
  index: number
}
export declare function joinWords(
  words: ShellToken[],
  from: number,
  until?: ReadonlySet<string>,
): string
export declare function nestedScripts(
  words: ShellToken[],
  index: number,
  stdinScripts: string[],
): { scripts: string[]; unverifiable?: string | undefined }
export declare function pipedScripts(
  previous: ShellSegment | undefined,
): string[]
