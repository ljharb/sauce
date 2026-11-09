export interface ShellToken {
  type: 'operator' | 'redirect' | 'word'
  value: string
  start: number
  end?: number | undefined
}

export interface ShellSegment {
  words: ShellToken[]
  heredocs: string[]
  start: number
  end: number
  after: string
}

export interface TokenizeShellCommandOptions {
  windows?: boolean | undefined
}

export interface TokenizedShellCommand {
  tokens: ShellToken[]
  substitutions: string[]
}

export declare function findClosingParen(command: string, index: number): number
export declare function tokenizeShellCommand(
  command: string,
  options?: TokenizeShellCommandOptions,
): TokenizedShellCommand
export declare function splitShellSegments(tokens: ShellToken[]): ShellSegment[]
