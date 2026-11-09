/**
 * @file Decide whether a package-manager command fetches packages: npm, npx,
 *   pnpm, pnpx, yarn, pip, python -m pip, uv, uvx, and cargo. Each manager
 *   has its own install verbs and its own global options that take a value.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'

import { commandBaseName } from './command-words.mjs'

function flagSet(...names) {
  return new Set(names)
}

const HELP_FLAGS = flagSet('--help', '-h')

const INFO_FLAGS = flagSet('--help', '--version', '-h', '-v', '-V')

const GLOBAL_FLAGS = flagSet('--global', '-g')

const SFW_PACKAGE_RE = /^sfw(?:@[\w.^~<>=*-]+)?$/

const NPM_VALUE_FLAGS = flagSet(
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

const NPX_FETCH_FLAGS = flagSet('-p', '-y', '--package', '--yes')

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
  'install',
  'up',
  'upgrade',
  'upgrade-interactive',
)

const PIP_VERBS = flagSet('download', 'install', 'wheel')

const CARGO_VERBS = flagSet('add', 'fetch', 'install')

const UV_TOOL_VERBS = flagSet('install', 'run', 'upgrade')

const UV_PIP_VERBS = flagSet('install', 'sync')

const UV_WITH_RE = /^--with(?:-editable|-requirements)?(?:=|$)/

const PIP_RE = /^pip(?:\d+(?:\.\d+)?)?$/

const PYTHON_RE = /^(?:py|python(?:\d+(?:\.\d+)?)?)$/

export function findSubcommand(words, from, valueFlags) {
  for (let i = from, { length } = words; i < length; i += 1) {
    const value = words[i].value
    if (value.startsWith('-') && value.length > 1) {
      if (!value.includes('=') && valueFlags.has(value)) {
        i += 1
      }
      continue
    }
    if (value.startsWith('+')) {
      continue
    }
    return { index: i, value }
  }
  return undefined
}

export function positionalArgs(words, from, valueFlags) {
  const args = []
  for (let i = from, { length } = words; i < length; i += 1) {
    const value = words[i].value
    if (value.startsWith('-') && value.length > 1) {
      if (valueFlags?.has(value)) {
        i += 1
      }
      continue
    }
    args.push(value)
  }
  return args
}

export function hasFlag(words, from, names) {
  for (let i = from, { length } = words; i < length; i += 1) {
    if (names.has(words[i].value)) {
      return true
    }
  }
  return false
}

function hasFlagMatching(words, from, pattern) {
  for (let i = from, { length } = words; i < length; i += 1) {
    if (pattern.test(words[i].value)) {
      return true
    }
  }
  return false
}

export function isSfwSelfInstall(words, from, sub) {
  const isGlobal = sub.value === 'global' || hasFlag(words, from, GLOBAL_FLAGS)
  if (!isGlobal) {
    return false
  }
  const args = positionalArgs(words, sub.index + 1).filter(arg => arg !== 'add')
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

export function npxFetches(words, from, cwd) {
  if (
    hasFlag(words, from, INFO_FLAGS) ||
    hasFlag(words, from, NPX_OFFLINE_FLAGS)
  ) {
    return false
  }
  if (
    hasFlag(words, from, NPX_FETCH_FLAGS) ||
    hasFlagMatching(words, from, /^--package=/)
  ) {
    return true
  }
  const [bin] = positionalArgs(words, from, NPX_VALUE_FLAGS)
  if (!bin || bin === '--') {
    return false
  }
  if (bin.lastIndexOf('@') > 0) {
    return true
  }
  return !hasLocalBin(cwd, bin)
}

function classifyNpm(words, from, ctx) {
  const sub = findSubcommand(words, from, NPM_VALUE_FLAGS)
  if (!sub) {
    return undefined
  }
  const after = sub.index + 1
  if (sub.value === 'exec' || sub.value === 'x') {
    return npxFetches(words, after, ctx.cwd) ? 'npm' : undefined
  }
  if (NPM_VERBS.has(sub.value)) {
    return hasFlag(words, after, HELP_FLAGS) ||
      isSfwSelfInstall(words, from, sub)
      ? undefined
      : 'npm'
  }
  if (sub.value === 'audit') {
    return positionalArgs(words, after)[0] === 'fix' ? 'npm' : undefined
  }
  if (sub.value === 'create' || sub.value === 'init') {
    return positionalArgs(words, after).length ? 'npm' : undefined
  }
  return undefined
}

function classifyPnpm(words, from) {
  const sub = findSubcommand(words, from, PNPM_VALUE_FLAGS)
  if (!sub) {
    return undefined
  }
  const after = sub.index + 1
  if (hasFlag(words, after, HELP_FLAGS)) {
    return undefined
  }
  if (PNPM_VERBS.has(sub.value)) {
    return isSfwSelfInstall(words, from, sub) ? undefined : 'pnpm'
  }
  if (sub.value === 'dlx') {
    return 'pnpm'
  }
  return sub.value === 'create' && positionalArgs(words, after).length
    ? 'pnpm'
    : undefined
}

function classifyYarnWorkspaces(words, after) {
  const next = findSubcommand(words, after, YARN_VALUE_FLAGS)
  if (next?.value === 'focus') {
    return 'yarn'
  }
  return next?.value === 'foreach' &&
    positionalArgs(words, next.index + 1).some(arg => YARN_VERBS.has(arg))
    ? 'yarn'
    : undefined
}

function classifyYarnGlobal(words, from, sub) {
  const next = findSubcommand(words, sub.index + 1, YARN_VALUE_FLAGS)
  return next?.value === 'add' && !isSfwSelfInstall(words, from, sub)
    ? 'yarn'
    : undefined
}

function classifyYarnSubcommand(words, from, sub) {
  const after = sub.index + 1
  if (YARN_VERBS.has(sub.value) || sub.value === 'dlx') {
    return 'yarn'
  }
  if (sub.value === 'global') {
    return classifyYarnGlobal(words, from, sub)
  }
  if (sub.value === 'workspace') {
    const rest = findSubcommand(words, after + 1, YARN_VALUE_FLAGS)
    return rest && YARN_VERBS.has(rest.value) ? 'yarn' : undefined
  }
  if (sub.value === 'workspaces') {
    return classifyYarnWorkspaces(words, after)
  }
  return sub.value === 'create' && positionalArgs(words, after).length
    ? 'yarn'
    : undefined
}

function classifyYarn(words, from) {
  const sub = findSubcommand(words, from, YARN_VALUE_FLAGS)
  if (!sub) {
    return hasFlag(words, from, INFO_FLAGS) ? undefined : 'yarn'
  }
  if (hasFlag(words, sub.index + 1, HELP_FLAGS)) {
    return undefined
  }
  return classifyYarnSubcommand(words, from, sub)
}

function classifyVerb(ecosystem, verbs, words, from, valueFlags) {
  const sub = findSubcommand(words, from, valueFlags)
  if (!sub || !verbs.has(sub.value)) {
    return undefined
  }
  return hasFlag(words, sub.index + 1, HELP_FLAGS) ? undefined : ecosystem
}

function classifyUvSubcommand(words, sub) {
  const after = sub.index + 1
  if (sub.value === 'add' || sub.value === 'sync') {
    return 'uv'
  }
  if (sub.value === 'pip') {
    return classifyVerb('uv', UV_PIP_VERBS, words, after, UV_VALUE_FLAGS)
  }
  if (sub.value === 'tool') {
    return classifyVerb('uv', UV_TOOL_VERBS, words, after, UV_VALUE_FLAGS)
  }
  if (sub.value === 'run') {
    return hasFlagMatching(words, after, UV_WITH_RE) ? 'uv' : undefined
  }
  return sub.value === 'venv' && hasFlag(words, after, flagSet('--seed'))
    ? 'uv'
    : undefined
}

function classifyUv(words, from) {
  const sub = findSubcommand(words, from, UV_VALUE_FLAGS)
  if (!sub || hasFlag(words, sub.index + 1, HELP_FLAGS)) {
    return undefined
  }
  return classifyUvSubcommand(words, sub)
}

function classifyCargo(words, from) {
  const sub = findSubcommand(words, from, CARGO_VALUE_FLAGS)
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

function pythonModule(words, index) {
  for (let i = index + 1, { length } = words; i < length; i += 1) {
    const value = words[i].value
    if (value === '-m' && i + 1 < length) {
      return { name: words[i + 1].value, from: i + 2 }
    }
    if (value.startsWith('-m') && value.length > 2) {
      return { name: value.slice(2).replace(/^=/, ''), from: i + 1 }
    }
    if (value === '-c' || !value.startsWith('-')) {
      return undefined
    }
    if (PYTHON_VALUE_FLAGS.has(value)) {
      i += 1
    }
  }
  return undefined
}

function classifyPython(words, index) {
  const module = pythonModule(words, index)
  if (!module) {
    return undefined
  }
  if (PIP_RE.test(module.name)) {
    return classifyVerb('pip', PIP_VERBS, words, module.from, PIP_VALUE_FLAGS)
  }
  return module.name === 'uv' ? classifyUv(words, module.from) : undefined
}

function classifyAlwaysFetches(ecosystem, words, from) {
  const args = positionalArgs(words, from)
  return args.length && !hasFlag(words, from, INFO_FLAGS)
    ? ecosystem
    : undefined
}

const CLASSIFIERS = {
  __proto__: null,
  cargo: (words, index) => classifyCargo(words, index + 1),
  npm: (words, index, ctx) => classifyNpm(words, index + 1, ctx),
  npx: (words, index, ctx) =>
    npxFetches(words, index + 1, ctx.cwd) ? 'npm' : undefined,
  pnpm: (words, index) => classifyPnpm(words, index + 1),
  pnpx: (words, index) => classifyAlwaysFetches('pnpm', words, index + 1),
  uv: (words, index) => classifyUv(words, index + 1),
  uvx: (words, index) => classifyAlwaysFetches('uv', words, index + 1),
  yarn: (words, index) => classifyYarn(words, index + 1),
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
  return PYTHON_RE.test(base) ? classifyPython(words, index) : undefined
}
