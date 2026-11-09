import { describe, expect, it } from 'vitest'

import {
  extractSubstitutions,
  findClosingParen,
  splitShellSegments,
  tokenizeShellCommand,
} from '../../../skills/_shared/hooks/shell-words.mjs'
import type { ShellToken } from '../../../skills/_shared/hooks/shell-words.mjs'

function words(command: string): string[][] {
  return splitShellSegments(tokenizeShellCommand(command).tokens).map(segment =>
    segment.words.map((word: ShellToken) => word.value),
  )
}

describe('tokenizeShellCommand', () => {
  it('records offsets that map back to the source text', () => {
    const command = `FOO="a b" npm  install 'left pad'`
    const tokens = tokenizeShellCommand(command).tokens.filter(
      (token: ShellToken) => token.type === 'word',
    )
    expect(tokens.map((token: ShellToken) => token.value)).toEqual([
      'FOO=a b',
      'npm',
      'install',
      'left pad',
    ])
    const quoted = tokens[3]!
    expect(command.slice(quoted.start, quoted.end)).toBe(`'left pad'`)
  })

  it('collects command substitutions outside single quotes only', () => {
    expect(
      tokenizeShellCommand(`echo $(a) "$(b)" \`c\` '$(d)' '\`e\`'`)
        .substitutions,
    ).toEqual(['a', 'b', 'c'])
  })

  it('keeps nested parentheses inside a substitution', () => {
    expect(tokenizeShellCommand('echo $(f $(g) (h))').substitutions).toEqual([
      'f $(g) (h)',
    ])
  })

  it('keeps backslashes literal in Windows mode', () => {
    const [first] = tokenizeShellCommand('C:\\tools\\npm.cmd i', {
      windows: true,
    }).tokens
    expect(first?.value).toBe('C:\\tools\\npm.cmd')
  })
})

describe('findClosingParen', () => {
  it('skips heredoc bodies inside a substitution', () => {
    const text = "$(cat <<'EOF'\n1) step\nEOF\n) tail"
    expect(text.slice(findClosingParen(text, 2))).toBe(') tail')
  })
})

describe('extractSubstitutions', () => {
  it('finds $() and backticks outside escapes', () => {
    expect(extractSubstitutions('a $(b) `c` \\$(d)')).toEqual(['b', 'c'])
  })
})

describe('splitShellSegments', () => {
  it('splits on control operators and parentheses', () => {
    expect(words('(cd a && npm ci) | tee log; ls')).toEqual([
      ['cd', 'a'],
      ['npm', 'ci'],
      ['tee', 'log'],
      ['ls'],
    ])
  })

  it('drops redirections and their targets from the words', () => {
    expect(words('npm i>/dev/null 2>&1 <in')).toEqual([['npm', 'i']])
    expect(words('>/dev/null npm install')).toEqual([['npm', 'install']])
  })

  it('moves heredoc bodies out of the words', () => {
    const segments = splitShellSegments(
      tokenizeShellCommand("cat > f <<'EOF'\nnpm install\nEOF\nls").tokens,
    )
    expect(
      segments.map(segment => segment.words.map(word => word.value)),
    ).toEqual([['cat'], ['ls']])
    expect(segments[0]?.heredocs).toEqual(['npm install'])
  })

  it('strips leading tabs for <<- heredocs', () => {
    const [segment] = splitShellSegments(
      tokenizeShellCommand('bash <<-END\n\tnpm i\n\tEND').tokens,
    )
    expect(segment?.heredocs).toEqual(['\tnpm i'])
  })

  it('treats a here-string as a body', () => {
    const [segment] = splitShellSegments(
      tokenizeShellCommand('bash <<< "npm i"').tokens,
    )
    expect(segment?.heredocs).toEqual(['npm i'])
  })
})
