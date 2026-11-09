/**
 * @file Decide whether a package-manager command fetches packages: npm, npx,
 *   pnpm, pnpx, yarn, pip, python -m pip, uv, uvx, and cargo. Each manager
 *   has its own install verbs and its own global options that take a value.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'

import { commandBaseName, resolveCommandWord } from './command-words.mjs'

function flagSet(...names) {
  return new Set(names)
}

const HELP_FLAGS = flagSet('--help', '-h')

const INFO_FLAGS = flagSet('--help', '--version', '-h', '-v', '-V')

const GLOBAL_FLAGS = flagSet('--global', '-g')

const SFW_PACKAGE_RE = /^sfw(?:@[\w.^~<>=*-]+)?$/

const NPM_VALUE_FLAGS = flagSet(
  '--cafile',
  '--depth',
  '--fetch-retries',
  '--fetch-timeout',
  '--https-proxy',
  '--proxy',
  '-C',
  '-w',
  '--before',
  '--cache',
  '--cpu',
  '--globalconfig',
  '--include',
  '--install-strategy',
  '--libc',
  '--location',
  '--loglevel',
  '--omit',
  '--os',
  '--otp',
  '--prefix',
  '--registry',
  '--scope',
  '--script-shell',
  '--tag',
  '--userconfig',
  '--workspace',
)

const PNPM_VALUE_FLAGS = flagSet(
  '--lockfile-dir',
  '-C',
  '-F',
  '--changed-files-ignore-pattern',
  '--config-dir',
  '--dir',
  '--filter',
  '--filter-prod',
  '--loglevel',
  '--modules-dir',
  '--registry',
  '--reporter',
  '--store-dir',
  '--test-pattern',
  '--use-node-version',
  '--virtual-store-dir',
  '--workspace-dir',
)

const YARN_VALUE_FLAGS = flagSet(
  '--https-proxy',
  '--proxy',
  '--cache-folder',
  '--cwd',
  '--global-folder',
  '--link-folder',
  '--modules-folder',
  '--mutex',
  '--network-concurrency',
  '--network-timeout',
  '--otp',
  '--preferred-cache-folder',
  '--registry',
  '--use-yarnrc',
)

const PIP_VALUE_FLAGS = flagSet(
  '-f',
  '-i',
  '--extra-index-url',
  '--find-links',
  '--index-url',
  '--cache-dir',
  '--cert',
  '--client-cert',
  '--exists-action',
  '--keyring-provider',
  '--log',
  '--proxy',
  '--python',
  '--retries',
  '--root-user-action',
  '--timeout',
  '--trusted-host',
  '--use-deprecated',
  '--use-feature',
)

const UV_VALUE_FLAGS = flagSet(
  '--default-index',
  '--extra-index-url',
  '--index',
  '--index-url',
  '-p',
  '--cache-dir',
  '--color',
  '--config-file',
  '--directory',
  '--project',
  '--python',
  '--python-preference',
)

const CARGO_VALUE_FLAGS = flagSet('-C', '-Z', '--color', '--config')

const PYTHON_VALUE_FLAGS = flagSet('-W', '-X', '--check-hash-based-pycs')

const NPX_VALUE_FLAGS = flagSet('-c', '-p', '--call', '--package')

const NPX_OFFLINE_FLAGS = flagSet(
  '--no',
  '--no-install',
  '--offline',
  '--yes=false',
)

const NPX_PACKAGE_FLAGS = flagSet('-p', '--package')

const NPM_VERBS = flagSet(
  'add',
  'ci',
  'cit',
  'clean-install',
  'ddp',
  'dedupe',
  'i',
  'ic',
  'in',
  'ins',
  'inst',
  'insta',
  'instal',
  'install',
  'install-ci-test',
  'install-clean',
  'install-test',
  'isnt',
  'isnta',
  'isntal',
  'isntall',
  'isntall-clean',
  'it',
  'udpate',
  'up',
  'update',
  'upgrade',
)

const PNPM_VERBS = flagSet(
  'add',
  'dedupe',
  'fetch',
  'i',
  'install',
  'install-test',
  'it',
  'self-update',
  'up',
  'update',
  'upgrade',
)

const YARN_VERBS = flagSet(
  'add',
  'dedupe',
  'install',
  'up',
  'upgrade',
  'upgrade-interactive',
)

const PIP_VERBS = flagSet('download', 'install', 'wheel')

const CARGO_VERBS = flagSet('add', 'binstall', 'fetch', 'install', 'vendor')

const UV_TOOL_VERBS = flagSet('install', 'run', 'upgrade')

const UV_PIP_VERBS = flagSet('install', 'sync')

const UV_WITH_RE = /^--with(?:-editable|-requirements)?(?:=|$)/

const PIP_RE = /^pip(?:-?\d+(?:\.\d+)?)?$/

const PYTHON_RE = /^(?:py|pypy|python)(?:\d+(?:\.\d+)?t?)?$/

const NPM_INIT_VALUE_FLAGS = new Set([
  ...NPM_VALUE_FLAGS,
  '--init-author-email',
  '--init-author-name',
  '--init-author-url',
  '--init-license',
  '--init-module',
  '--init-type',
  '--init-version',
])

const NPX_ALL_VALUE_FLAGS = new Set([...NPX_VALUE_FLAGS, ...NPM_VALUE_FLAGS])

const NPM_SUBCOMMANDS = new Set([
  ...NPM_VERBS,
  'audit',
  'create',
  'exec',
  'init',
  'x',
])

const PNPM_RECURSIVE = flagSet('m', 'multi', 'recursive')

const PNPM_SUBCOMMANDS = new Set([
  ...PNPM_VERBS,
  ...PNPM_RECURSIVE,
  'create',
  'dlx',
  'exec',
])

const YARN_SUBCOMMANDS = new Set([
  ...YARN_VERBS,
  'create',
  'dlx',
  'exec',
  'global',
  'workspace',
  'workspaces',
])

const YARN_FOREACH_VALUE_FLAGS = flagSet(
  '-j',
  '--exclude',
  '--from',
  '--include',
  '--jobs',
)

const UV_RUN_VALUE_FLAGS = flagSet(
  '-p',
  '--default-index',
  '--directory',
  '--env-file',
  '--extra',
  '--group',
  '--index',
  '--index-url',
  '--package',
  '--project',
  '--python',
  '--with',
  '--with-editable',
  '--with-requirements',
)

const UVX_VALUE_FLAGS = flagSet('-p', '--from', '--index', '--python', '--with')

function isFlagWord(value) {
  return value.length > 1 && value.startsWith('-')
}

export function findSubcommand(words, from, valueFlags) {
  let afterUnknownFlag = false
  for (let i = from, { length } = words; i < length; i += 1) {
    const value = words[i].value
    if (isFlagWord(value)) {
      const takesValue = !value.includes('=') && valueFlags.has(value)
      afterUnknownFlag =
        !takesValue && value.startsWith('--') && !value.includes('=')
      i += takesValue ? 1 : 0
      continue
    }
    if (value.startsWith('+')) {
      continue
    }
    return { index: i, value, afterUnknownFlag }
  }
  return undefined
}

function findKnownSubcommand(words, from, valueFlags, known) {
  const sub = findSubcommand(words, from, valueFlags)
  if (sub && !known.has(sub.value) && sub.afterUnknownFlag) {
    const next = findSubcommand(words, sub.index + 1, valueFlags)
    if (next && known.has(next.value)) {
      return next
    }
  }
  return sub
}

export function positionalArgs(words, from, valueFlags) {
  const args = []
  for (let i = from, { length } = words; i < length; i += 1) {
    const value = words[i].value
    if (isFlagWord(value)) {
      i += !value.includes('=') && valueFlags?.has(value) ? 1 : 0
      continue
    }
    args.push(value)
  }
  return args
}

export function hasFlag(words, from, names, until = words.length) {
  for (let i = from; i < until; i += 1) {
    if (names.has(words[i].value)) {
      return true
    }
  }
  return false
}

function hasFlagMatching(words, from, pattern, until = words.length) {
  for (let i = from; i < until; i += 1) {
    if (pattern.test(words[i].value)) {
      return true
    }
  }
  return false
}

export function runnerTarget(words, from, valueFlags) {
  for (let i = from, { length } = words; i < length; i += 1) {
    const value = words[i].value
    if (value === '--') {
      return i + 1 < length ? i + 1 : -1
    }
    if (isFlagWord(value)) {
      i += !value.includes('=') && valueFlags.has(value) ? 1 : 0
      continue
    }
    return i
  }
  return -1
}

export function isSfwSelfInstall(words, from, sub, valueFlags) {
  const isGlobal = sub.value === 'global' || hasFlag(words, from, GLOBAL_FLAGS)
  if (!isGlobal) {
    return false
  }
  const args = positionalArgs(words, sub.index + 1, valueFlags).filter(
    arg => arg !== 'add',
  )
  return args.length > 0 && args.every(arg => SFW_PACKAGE_RE.test(arg))
}

function hasLocalBin(cwd, bin) {
  if (!cwd) {
    return false
  }
  const name = bin.slice(bin.lastIndexOf('/') + 1)
  let dir = path.resolve(cwd)
  for (let depth = 0; depth < 32; depth += 1) {
    const binDir = path.join(dir, 'node_modules', '.bin')
    if (
      existsSync(path.join(binDir, name)) ||
      existsSync(path.join(binDir, `${name}.cmd`))
    ) {
      return true
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      return false
    }
    dir = parent
  }
  return false
}

export function classifyCommandAt(words, index, ctx) {
  if (index === -1) {
    return undefined
  }
  const rest = words.slice(index)
  const resolved = resolveCommandWord(rest).index
  return resolved === -1 ? undefined : classifyInstall(rest, resolved, ctx)
}

function classifyLocalWrapper(words, index, ctx) {
  const rest = words.slice(index)
  const resolved = resolveCommandWord(rest).index
  return resolved > 0 ? classifyInstall(rest, resolved, ctx) : undefined
}

export function npxFetches(words, from, ctx) {
  const target = runnerTarget(words, from, NPX_ALL_VALUE_FLAGS)
  const before = target === -1 ? words.length : target
  if (
    hasFlag(words, from, INFO_FLAGS, before) ||
    hasFlag(words, from, NPX_OFFLINE_FLAGS, before)
  ) {
    return false
  }
  if (
    hasFlag(words, from, NPX_PACKAGE_FLAGS, before) ||
    hasFlagMatching(words, from, /^--package=/, before)
  ) {
    return true
  }
  if (target === -1) {
    return false
  }
  const bin = words[target].value
  if (bin.lastIndexOf('@') > 0 || !hasLocalBin(ctx.cwd, bin)) {
    return true
  }
  return Boolean(classifyLocalWrapper(words, target, ctx))
}

function helpBeforeTarget(words, from, valueFlags) {
  const target = runnerTarget(words, from, valueFlags)
  return hasFlag(words, from, INFO_FLAGS, target === -1 ? words.length : target)
}

function classifyNpm(words, from, ctx) {
  const sub = findKnownSubcommand(words, from, NPM_VALUE_FLAGS, NPM_SUBCOMMANDS)
  if (!sub) {
    return undefined
  }
  const after = sub.index + 1
  if (sub.value === 'exec' || sub.value === 'x') {
    return npxFetches(words, after, ctx) ? 'npm' : undefined
  }
  if (NPM_VERBS.has(sub.value)) {
    return hasFlag(words, after, HELP_FLAGS) ||
      isSfwSelfInstall(words, from, sub, NPM_VALUE_FLAGS)
      ? undefined
      : 'npm'
  }
  if (sub.value === 'audit') {
    return positionalArgs(words, after, NPM_VALUE_FLAGS)[0] === 'fix'
      ? 'npm'
      : undefined
  }
  if (sub.value === 'create' || sub.value === 'init') {
    return positionalArgs(words, after, NPM_INIT_VALUE_FLAGS).length
      ? 'npm'
      : undefined
  }
  return undefined
}

function classifyPnpmSubcommand(words, from, sub, ctx) {
  const after = sub.index + 1
  if (sub.value === 'exec') {
    return classifyCommandAt(
      words,
      runnerTarget(words, after, PNPM_VALUE_FLAGS),
      ctx,
    )
  }
  if (sub.value === 'dlx') {
    return helpBeforeTarget(words, after, PNPM_VALUE_FLAGS) ? undefined : 'pnpm'
  }
  if (hasFlag(words, after, HELP_FLAGS)) {
    return undefined
  }
  if (PNPM_VERBS.has(sub.value)) {
    return isSfwSelfInstall(words, from, sub, PNPM_VALUE_FLAGS)
      ? undefined
      : 'pnpm'
  }
  return sub.value === 'create' &&
    positionalArgs(words, after, PNPM_VALUE_FLAGS).length
    ? 'pnpm'
    : undefined
}

function classifyPnpm(words, from, ctx) {
  const sub = findKnownSubcommand(
    words,
    from,
    PNPM_VALUE_FLAGS,
    PNPM_SUBCOMMANDS,
  )
  if (!sub) {
    return undefined
  }
  if (PNPM_RECURSIVE.has(sub.value)) {
    return classifyPnpm(words, sub.index + 1, ctx)
  }
  return classifyPnpmSubcommand(words, from, sub, ctx)
}

function classifyYarnWorkspaces(words, after, ctx) {
  const next = findSubcommand(words, after, YARN_VALUE_FLAGS)
  if (next?.value === 'focus') {
    return 'yarn'
  }
  if (next?.value !== 'foreach') {
    return undefined
  }
  const command = findSubcommand(
    words,
    next.index + 1,
    YARN_FOREACH_VALUE_FLAGS,
  )
  return command && command.value !== 'run'
    ? classifyYarn(words, command.index, ctx)
    : undefined
}

function classifyYarnGlobal(words, from, sub) {
  const next = findSubcommand(words, sub.index + 1, YARN_VALUE_FLAGS)
  return next?.value === 'add' &&
    !isSfwSelfInstall(words, from, sub, YARN_VALUE_FLAGS)
    ? 'yarn'
    : undefined
}

function classifyYarnNested(words, from, sub, ctx) {
  const after = sub.index + 1
  if (sub.value === 'exec') {
    return classifyCommandAt(
      words,
      runnerTarget(words, after, YARN_VALUE_FLAGS),
      ctx,
    )
  }
  if (sub.value === 'workspace') {
    const name = findSubcommand(words, after, YARN_VALUE_FLAGS)
    return name ? classifyYarn(words, name.index + 1, ctx) : undefined
  }
  if (sub.value === 'workspaces') {
    return classifyYarnWorkspaces(words, after, ctx)
  }
  return sub.value === 'global'
    ? classifyYarnGlobal(words, from, sub)
    : undefined
}

function classifyYarnSubcommand(words, from, sub, ctx) {
  const after = sub.index + 1
  if (sub.value === 'dlx') {
    return helpBeforeTarget(words, after, YARN_VALUE_FLAGS) ? undefined : 'yarn'
  }
  const nested = classifyYarnNested(words, from, sub, ctx)
  if (nested || hasFlag(words, after, HELP_FLAGS)) {
    return nested
  }
  if (YARN_VERBS.has(sub.value)) {
    return 'yarn'
  }
  return sub.value === 'create' &&
    positionalArgs(words, after, YARN_VALUE_FLAGS).length
    ? 'yarn'
    : undefined
}

function classifyYarn(words, from, ctx) {
  const sub = findKnownSubcommand(
    words,
    from,
    YARN_VALUE_FLAGS,
    YARN_SUBCOMMANDS,
  )
  if (!sub) {
    return hasFlag(words, from, INFO_FLAGS) ? undefined : 'yarn'
  }
  return classifyYarnSubcommand(words, from, sub, ctx)
}

function classifyVerb(ecosystem, verbs, words, from, valueFlags) {
  const sub = findKnownSubcommand(words, from, valueFlags, verbs)
  if (!sub || !verbs.has(sub.value)) {
    return undefined
  }
  return hasFlag(words, sub.index + 1, HELP_FLAGS) ? undefined : ecosystem
}

function classifyUvTool(words, after) {
  const sub = findSubcommand(words, after, UV_VALUE_FLAGS)
  if (!sub || !UV_TOOL_VERBS.has(sub.value)) {
    return undefined
  }
  if (sub.value === 'run') {
    return helpBeforeTarget(words, sub.index + 1, UVX_VALUE_FLAGS)
      ? undefined
      : 'uv'
  }
  return hasFlag(words, sub.index + 1, HELP_FLAGS) ? undefined : 'uv'
}

function classifyUvRun(words, after, ctx) {
  if (hasFlagMatching(words, after, UV_WITH_RE)) {
    return 'uv'
  }
  return classifyCommandAt(
    words,
    runnerTarget(words, after, UV_RUN_VALUE_FLAGS),
    ctx,
  )
}

function classifyUvSubcommand(words, sub, ctx) {
  const after = sub.index + 1
  if (sub.value === 'add' || sub.value === 'sync') {
    return hasFlag(words, after, HELP_FLAGS) ? undefined : 'uv'
  }
  if (sub.value === 'pip') {
    return classifyVerb('uv', UV_PIP_VERBS, words, after, UV_VALUE_FLAGS)
  }
  if (sub.value === 'tool') {
    return classifyUvTool(words, after)
  }
  if (sub.value === 'run') {
    return classifyUvRun(words, after, ctx)
  }
  return sub.value === 'venv' && hasFlag(words, after, flagSet('--seed'))
    ? 'uv'
    : undefined
}

function classifyUv(words, from, ctx) {
  const sub = findSubcommand(words, from, UV_VALUE_FLAGS)
  return sub ? classifyUvSubcommand(words, sub, ctx) : undefined
}

function classifyCargo(words, from) {
  const sub = findKnownSubcommand(words, from, CARGO_VALUE_FLAGS, CARGO_VERBS)
  if (!sub || !CARGO_VERBS.has(sub.value)) {
    return undefined
  }
  const after = sub.index + 1
  if (
    hasFlag(words, after, HELP_FLAGS) ||
    (sub.value === 'install' && hasFlag(words, after, flagSet('--list')))
  ) {
    return undefined
  }
  return 'cargo'
}

const PYTHON_MODULE_RE = /^-[A-Za-ln-z]*m(.*)$/

function pythonModule(words, index) {
  for (let i = index + 1, { length } = words; i < length; i += 1) {
    const value = words[i].value
    const match = value.startsWith('--') ? null : PYTHON_MODULE_RE.exec(value)
    if (match) {
      const inline = match[1].replace(/^=/, '')
      return inline
        ? { name: inline, from: i + 1 }
        : { name: words[i + 1]?.value ?? '', from: i + 2 }
    }
    if (value === '-c' || !value.startsWith('-')) {
      return undefined
    }
    i += PYTHON_VALUE_FLAGS.has(value) ? 1 : 0
  }
  return undefined
}

function classifyPython(words, index, ctx) {
  const module = pythonModule(words, index)
  if (!module) {
    return undefined
  }
  if (PIP_RE.test(module.name)) {
    return classifyVerb('pip', PIP_VERBS, words, module.from, PIP_VALUE_FLAGS)
  }
  return module.name === 'uv' ? classifyUv(words, module.from, ctx) : undefined
}

function classifyAlwaysFetches(ecosystem, words, from, valueFlags) {
  const target = runnerTarget(words, from, valueFlags)
  if (target === -1 || hasFlag(words, from, INFO_FLAGS, target)) {
    return undefined
  }
  return ecosystem
}

const CLASSIFIERS = {
  __proto__: null,
  cargo: (words, index) => classifyCargo(words, index + 1),
  npm: (words, index, ctx) => classifyNpm(words, index + 1, ctx),
  npx: (words, index, ctx) =>
    npxFetches(words, index + 1, ctx) ? 'npm' : undefined,
  pnpm: (words, index, ctx) => classifyPnpm(words, index + 1, ctx),
  pnpx: (words, index) =>
    classifyAlwaysFetches('pnpm', words, index + 1, PNPM_VALUE_FLAGS),
  uv: (words, index, ctx) => classifyUv(words, index + 1, ctx),
  uvx: (words, index) =>
    classifyAlwaysFetches('uv', words, index + 1, UVX_VALUE_FLAGS),
  yarn: (words, index, ctx) => classifyYarn(words, index + 1, ctx),
}

export function classifyInstall(words, index, ctx = {}) {
  const base = commandBaseName(words[index].value)
  const classifier = CLASSIFIERS[base]
  if (classifier) {
    return classifier(words, index, ctx)
  }
  if (PIP_RE.test(base)) {
    return classifyVerb('pip', PIP_VERBS, words, index + 1, PIP_VALUE_FLAGS)
  }
  return PYTHON_RE.test(base) ? classifyPython(words, index, ctx) : undefined
}
