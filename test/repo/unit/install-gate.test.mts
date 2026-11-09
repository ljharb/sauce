import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  evaluateInstallCommand,
  findUnprotectedInstalls,
  isSfwOnPath,
  SFW_INSTALL_COMMAND,
  SOCKET_SIGN_UP_URL,
  tokenizeShellCommand,
} from '../../../skills/_shared/hooks/install-gate.mjs'
import type {
  InstallGateResult,
  UnprotectedInstall,
} from '../../../skills/_shared/hooks/install-gate.mjs'

type DeniedResult = Extract<InstallGateResult, { decision: 'deny' }>

function expectDenied(result: InstallGateResult): DeniedResult {
  if (result.decision !== 'deny') {
    throw new Error(`expected deny, got ${result.decision}`)
  }
  return result
}

function suggestions(command: string): string[] {
  return findUnprotectedInstalls(command).map(
    (install: UnprotectedInstall) => install.suggestion,
  )
}

describe('findUnprotectedInstalls', () => {
  it.each([
    ['npm install lodash', 'sfw npm install lodash'],
    ['npm i', 'sfw npm i'],
    ['npm ci', 'sfw npm ci'],
    ['npm exec cowsay', 'sfw npm exec cowsay'],
    ['npm init vite-app demo', 'sfw npm init vite-app demo'],
    ['npm --prefix web install', 'sfw npm --prefix web install'],
    ['pnpm add -D vite', 'sfw pnpm add -D vite'],
    ['pnpm -C web install', 'sfw pnpm -C web install'],
    ['pnpm dlx cowsay', 'sfw pnpm dlx cowsay'],
    ['yarn', 'sfw yarn'],
    ['yarn add left-pad', 'sfw yarn add left-pad'],
    ['pip install requests', 'sfw pip install requests'],
    [
      'pip3 install -r requirements.txt',
      'sfw pip3 install -r requirements.txt',
    ],
    ['python3 -m pip install requests', 'sfw python3 -m pip install requests'],
    ['uv pip install flask', 'sfw uv pip install flask'],
    ['uv add httpx', 'sfw uv add httpx'],
    ['uv sync', 'sfw uv sync'],
    ['uv tool install ruff', 'sfw uv tool install ruff'],
    ['cargo add serde', 'sfw cargo add serde'],
    ['cargo install ripgrep', 'sfw cargo install ripgrep'],
    ['cargo fetch', 'sfw cargo fetch'],
    ['/usr/local/bin/npm install', 'sfw /usr/local/bin/npm install'],
  ])('flags %s', (command, suggestion) => {
    expect(suggestions(command)).toEqual([suggestion])
  })

  it.each([
    'sfw npm install lodash',
    '/opt/bin/sfw pnpm add vite',
    'npm run build',
    'npm test',
    'npm init',
    'pnpm exec vitest',
    'yarn --version',
    'yarn build',
    'pip list',
    'uv run pytest',
    'cargo build',
    'git commit -m "npm install lodash"',
    'echo "pnpm add vite"',
    'ls -la',
    '',
    '   ',
  ])('allows %s', command => {
    expect(suggestions(command)).toEqual([])
  })

  it.each([
    'npm install -g sfw',
    'npm i --global sfw@1.4.0',
    'pnpm add -g sfw',
    'yarn global add sfw',
  ])('allows installing sfw itself: %s', command => {
    expect(suggestions(command)).toEqual([])
  })

  it('does not treat a global install of other packages as sfw', () => {
    expect(suggestions('npm install -g sfw typescript')).toEqual([
      'sfw npm install -g sfw typescript',
    ])
  })

  it('keeps environment assignments and prefixes ahead of sfw', () => {
    expect(suggestions('CI=1 npm ci')).toEqual(['CI=1 sfw npm ci'])
    expect(suggestions('sudo -E npm install -g typescript')).toEqual([
      'sudo -E sfw npm install -g typescript',
    ])
  })

  it('finds every install in a compound command', () => {
    expect(
      suggestions('cd web && pnpm install && pip install -r req.txt; ls'),
    ).toEqual(['sfw pnpm install', 'sfw pip install -r req.txt'])
  })

  it('looks inside shell -c scripts, eval, and command substitution', () => {
    expect(suggestions('bash -c "npm ci"')).toEqual(['sfw npm ci'])
    expect(suggestions("sh -lc 'yarn add left-pad'")).toEqual([
      'sfw yarn add left-pad',
    ])
    expect(suggestions('eval npm install lodash')).toEqual([
      'sfw npm install lodash',
    ])
    expect(suggestions('echo $(npm i left-pad)')).toEqual([
      'sfw npm i left-pad',
    ])
    expect(suggestions('echo `pnpm add vite`')).toEqual(['sfw pnpm add vite'])
  })

  it('handles pipes and line continuations', () => {
    expect(suggestions('yes | npm install')).toEqual(['sfw npm install'])
    expect(suggestions('npm install \\\n  lodash')).toEqual([
      'sfw npm install \\\n  lodash',
    ])
  })

  it('ignores comments', () => {
    expect(suggestions('ls # npm install lodash')).toEqual([])
  })
})

describe('tokenizeShellCommand', () => {
  it('records offsets that map back to the source text', () => {
    const command = `FOO="a b" npm  install 'left pad'`
    const words = tokenizeShellCommand(command).filter(
      (token: { type: string }) => token.type === 'word',
    )
    expect(words.map((word: { value: string }) => word.value)).toEqual([
      'FOO=a b',
      'npm',
      'install',
      'left pad',
    ])
    for (const word of words) {
      expect(command.slice(word.start, word.end)).not.toBe('')
    }
    const quoted = words[3]!
    expect(command.slice(quoted.start, quoted.end)).toBe(`'left pad'`)
  })
})

describe('isSfwOnPath', () => {
  it('finds sfw in a PATH directory', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'install-gate-'))
    const bin = path.join(dir, 'sfw')
    writeFileSync(bin, '')
    chmodSync(bin, 0o755)
    expect(isSfwOnPath({ PATH: dir })).toBe(true)
    expect(isSfwOnPath({ PATH: os.tmpdir() })).toBe(false)
    expect(isSfwOnPath({})).toBe(false)
  })
})

describe('evaluateInstallCommand', () => {
  it('allows commands with no unprotected install', () => {
    expect(evaluateInstallCommand('npm test', { env: {} })).toEqual({
      decision: 'allow',
    })
  })

  it('denies an unprotected install and suggests the sfw form', () => {
    const result = expectDenied(
      evaluateInstallCommand('npm install lodash', {
        env: { PATH: '' },
      }),
    )
    expect(result.sfwInstalled).toBe(false)
    expect(result.installs).toEqual([
      {
        ecosystem: 'npm',
        command: 'npm install lodash',
        suggestion: 'sfw npm install lodash',
      },
    ])
    expect(result.agentMessage).toContain('sfw npm install lodash')
    expect(result.agentMessage).toContain(SFW_INSTALL_COMMAND)
    expect(result.userMessage).toContain(SOCKET_SIGN_UP_URL)
  })

  it('omits the install step when sfw is on PATH', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'install-gate-'))
    writeFileSync(path.join(dir, 'sfw'), '')
    const result = expectDenied(
      evaluateInstallCommand('pnpm add vite', {
        env: { PATH: dir },
      }),
    )
    expect(result.sfwInstalled).toBe(true)
    expect(result.agentMessage).not.toContain(SFW_INSTALL_COMMAND)
  })

  it('can be turned off for one environment', () => {
    expect(
      evaluateInstallCommand('npm install lodash', {
        env: { SOCKET_INSTALL_GATE: 'off' },
      }),
    ).toEqual({ decision: 'allow' })
  })
})
