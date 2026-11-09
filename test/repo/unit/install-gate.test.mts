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

function suggestions(command: string, platform = 'darwin'): string[] {
  return findUnprotectedInstalls(command, { platform }).map(
    (install: UnprotectedInstall) => install.suggestion,
  )
}

describe('findUnprotectedInstalls: plain installs', () => {
  it.each([
    ['npm install lodash', 'sfw npm install lodash'],
    ['npm i', 'sfw npm i'],
    ['npm ci', 'sfw npm ci'],
    ['npm exec cowsay', 'sfw npm exec cowsay'],
    ['npm init vite-app demo', 'sfw npm init vite-app demo'],
    ['npm audit fix --force', 'sfw npm audit fix --force'],
    ['npm dedupe', 'sfw npm dedupe'],
    ['npm --prefix web install', 'sfw npm --prefix web install'],
    [
      'npm --registry https://registry.npmjs.org install lodash',
      'sfw npm --registry https://registry.npmjs.org install lodash',
    ],
    ['npm --loglevel silent install', 'sfw npm --loglevel silent install'],
    [
      'npx -y create-next-app@latest app',
      'sfw npx -y create-next-app@latest app',
    ],
    ['pnpm add -D vite', 'sfw pnpm add -D vite'],
    ['pnpm -C web install', 'sfw pnpm -C web install'],
    ['pnpm --store-dir /tmp/s install', 'sfw pnpm --store-dir /tmp/s install'],
    ['pnpm dlx cowsay', 'sfw pnpm dlx cowsay'],
    ['pnpm fetch', 'sfw pnpm fetch'],
    ['pnpx create-vite', 'sfw pnpx create-vite'],
    ['yarn', 'sfw yarn'],
    ['yarn add left-pad', 'sfw yarn add left-pad'],
    ['yarn workspace web add lodash', 'sfw yarn workspace web add lodash'],
    ['yarn workspaces focus web', 'sfw yarn workspaces focus web'],
    ['pip install requests', 'sfw pip install requests'],
    [
      'pip3 install -r requirements.txt',
      'sfw pip3 install -r requirements.txt',
    ],
    ['pip3 wheel -r requirements.txt', 'sfw pip3 wheel -r requirements.txt'],
    [
      'pip --index-url https://pypi.org/simple install requests',
      'sfw pip --index-url https://pypi.org/simple install requests',
    ],
    ['python3 -m pip install requests', 'sfw python3 -m pip install requests'],
    ['python -mpip install requests', 'sfw python -mpip install requests'],
    ['python -m uv pip install flask', 'sfw python -m uv pip install flask'],
    ['uv pip install flask', 'sfw uv pip install flask'],
    ['uv add httpx', 'sfw uv add httpx'],
    ['uv sync', 'sfw uv sync'],
    ['uv tool install ruff', 'sfw uv tool install ruff'],
    ['uv tool run black .', 'sfw uv tool run black .'],
    ['uvx ruff check .', 'sfw uvx ruff check .'],
    ['cargo add serde', 'sfw cargo add serde'],
    ['cargo install ripgrep', 'sfw cargo install ripgrep'],
    ['cargo fetch', 'sfw cargo fetch'],
    ['/usr/local/bin/npm install', 'sfw /usr/local/bin/npm install'],
  ])('flags %s', (command, suggestion) => {
    expect(suggestions(command)).toEqual([suggestion])
  })
})

describe('findUnprotectedInstalls: shell structure', () => {
  it.each([
    [
      'if [ -f package-lock.json ]; then npm ci; else npm install; fi',
      ['sfw npm ci', 'sfw npm install'],
    ],
    ['for p in a b; do pip install "$p"; done', ['sfw pip install "$p"']],
    [
      'while read p; do pip install $p; done < reqs.txt',
      ['sfw pip install $p'],
    ],
    ['until npm ci; do sleep 5; done', ['sfw npm ci']],
    ['case $x in a) npm i;; esac', ['sfw npm i']],
    ['! npm i', ['sfw npm i']],
    ['(cd a && npm ci)', ['sfw npm ci']],
    ['{ npm i; }', ['sfw npm i']],
    ['>/dev/null npm install', ['>/dev/null sfw npm install']],
    ['npm i>/dev/null', ['sfw npm i>/dev/null']],
    ['npm i x 2>&1', ['sfw npm i x 2>&1']],
    ['yes | npm install', ['sfw npm install']],
    ['npm install \\\n  lodash', ['sfw npm install \\\n  lodash']],
    [
      'cd web && pnpm install && pip install -r req.txt; ls',
      ['sfw pnpm install', 'sfw pip install -r req.txt'],
    ],
  ])('flags %j', (command, expected) => {
    expect(suggestions(command)).toEqual(expected)
  })

  it.each([
    ['CI=1 npm ci', 'CI=1 sfw npm ci'],
    [
      'sudo -E npm install -g typescript',
      'sudo -E sfw npm install -g typescript',
    ],
    ['sudo -u node npm install -g tsx', 'sudo -u node sfw npm install -g tsx'],
    ['timeout 600 npm ci', 'timeout 600 sfw npm ci'],
    ['nice -n 10 npm ci', 'nice -n 10 sfw npm ci'],
    ['env -u NODE_OPTIONS npm ci', 'env -u NODE_OPTIONS sfw npm ci'],
    ['corepack pnpm install', 'corepack sfw pnpm install'],
    ['xargs npm install < list', 'xargs sfw npm install < list'],
  ])('keeps wrappers ahead of sfw: %s', (command, suggestion) => {
    expect(suggestions(command)).toEqual([suggestion])
  })

  it.each([
    ['bash -c "npm ci"', 'sfw npm ci'],
    ["sh -lc 'yarn add left-pad'", 'sfw yarn add left-pad'],
    ['pwsh -c "npm install"', 'sfw npm install'],
    ['powershell -Command "npm install"', 'sfw npm install'],
    ['fish -c "npm install"', 'sfw npm install'],
    ['cmd /c npm install', 'sfw npm install'],
    ['eval npm install lodash', 'sfw npm install lodash'],
    ['env -S "npm install lodash"', 'sfw npm install lodash'],
    ['echo $(npm i left-pad)', 'sfw npm i left-pad'],
    ['echo "$(npm i left-pad)"', 'sfw npm i left-pad'],
    ['echo `pnpm add vite`', 'sfw pnpm add vite'],
    ['bash <<EOF\nnpm i\nEOF', 'sfw npm i'],
    ['bash <<< "npm i x"', 'sfw npm i x'],
  ])('looks inside nested scripts: %j', (command, suggestion) => {
    expect(suggestions(command)).toEqual([suggestion])
  })

  it('reports each install once', () => {
    expect(suggestions('bash -c "$(npm i x)"')).toEqual(['sfw npm i x'])
  })

  it('denies commands it cannot read', () => {
    const [nested] = findUnprotectedInstalls(
      'eval eval eval eval eval eval npm i x',
    )
    expect(nested?.ecosystem).toBe('unknown')
    const [encoded] = findUnprotectedInstalls(
      'powershell -EncodedCommand ZQBjAGgAbwA=',
    )
    expect(encoded?.ecosystem).toBe('unknown')
  })

  it('keeps Windows paths intact on win32', () => {
    expect(suggestions('C:\\nodejs\\npm.cmd install x', 'win32')).toEqual([
      'sfw C:\\nodejs\\npm.cmd install x',
    ])
  })
})

describe('findUnprotectedInstalls: allowed commands', () => {
  it.each([
    'sfw npm install lodash',
    '/opt/bin/sfw pnpm add vite',
    'timeout 60 sfw npm ci',
    'npm run build',
    'npm test',
    'npm init',
    'npm view lodash',
    'npm ls',
    'npm outdated',
    'npm audit',
    'npx',
    'npx --version',
    'pnpm exec vitest',
    'yarn --version',
    'yarn build',
    'ls yarn',
    'pip list',
    'pip freeze',
    'uv run pytest',
    'cargo build',
    'cargo install --list',
    'which npm',
    'brew install pnpm yarn',
    'git commit -m "npm install lodash"',
    "git commit -m 'docs: mention `npm install`'",
    "gh pr create --body 'Run `npm ci` then `npm test`'",
    "echo '$(npm install)'",
    "sed -i 's/`npm i`/`sfw npm i`/' README.md",
    "git commit -F - <<'EOF'\nfix: lockfile\n\nnpm ci now passes\nEOF",
    "cat > README.md <<'EOF'\n# Setup\n\nnpm install\nEOF",
    'git commit -m "$(cat <<\'EOF\'\nchore: use pnpm\n\npnpm install is required.\nEOF\n)"',
    'ls # npm install lodash',
    'ls -la',
    '',
    '   ',
  ])('allows %j', command => {
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
})

describe('isSfwOnPath', () => {
  it('finds sfw in a PATH directory', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'install-gate-'))
    const bin = path.join(dir, 'sfw')
    writeFileSync(bin, '')
    chmodSync(bin, 0o755)
    expect(isSfwOnPath({ PATH: dir })).toBe(true)
    expect(isSfwOnPath({ Path: dir })).toBe(true)
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
      evaluateInstallCommand('npm install lodash', { env: { PATH: '' } }),
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

  it('explains a command it cannot read', () => {
    const result = expectDenied(
      evaluateInstallCommand('eval eval eval eval eval eval npm i x', {
        env: {},
      }),
    )
    expect(result.agentMessage).toContain('nested too deeply')
  })

  it('omits the install step when sfw is on PATH', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'install-gate-'))
    writeFileSync(path.join(dir, 'sfw'), '')
    const result = expectDenied(
      evaluateInstallCommand('pnpm add vite', { env: { PATH: dir } }),
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
