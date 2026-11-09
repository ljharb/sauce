/**
 * @file Decide whether an agent's shell command installs packages without
 *   Socket Firewall. Agent hooks (Cursor, Claude Code, Codex) call
 *   evaluateInstallCommand and map the result onto their own hook output.
 *   Dependency-free: it runs from an installed plugin with only Node.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { splitShellSegments, tokenizeShellCommand } from './shell-words.mjs'

export const SOCKET_SIGN_UP_URL = 'https://socket.dev/'
export const SFW_DOCS_URL = 'https://docs.socket.dev/docs/socket-firewall-free'
export const SFW_INSTALL_COMMAND = 'npm install -g sfw'

const MAX_DEPTH = 4

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

const KEYWORDS = new Set([
  '!',
  'do',
  'elif',
  'else',
  'if',
  'then',
  'time',
  'until',
  'while',
])

const DATA_COMMANDS = new Set([
  'apt',
  'apt-get',
  'awk',
  'brew',
  'cat',
  'choco',
  'dnf',
  'echo',
  'egrep',
  'export',
  'fgrep',
  'gh',
  'git',
  'grep',
  'head',
  'less',
  'man',
  'more',
  'printf',
  'rg',
  'scoop',
  'sed',
  'tail',
  'tee',
  'type',
  'whereis',
  'which',
  'winget',
  'yum',
])

const POSIX_SHELLS = new Set(['bash', 'dash', 'fish', 'ksh', 'sh', 'zsh'])

const POWERSHELLS = new Set(['powershell', 'pwsh'])

const NPM_INSTALL_VERBS = new Set([
  'add',
  'ci',
  'cit',
  'clean-install',
  'ddp',
  'dedupe',
  'exec',
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
  'x',
])

const PNPM_INSTALL_VERBS = new Set([
  'add',
  'dedupe',
  'dlx',
  'fetch',
  'i',
  'install',
  'install-test',
  'it',
  'up',
  'update',
  'upgrade',
])

const YARN_INSTALL_VERBS = new Set(['add', 'dlx', 'install', 'up', 'upgrade'])

const PIP_INSTALL_VERBS = new Set(['download', 'install', 'wheel'])

const UV_INSTALL_VERBS = new Set(['add', 'sync'])

const CARGO_INSTALL_VERBS = new Set(['add', 'fetch', 'install'])

const OTHER_VERBS = new Set([
  'audit',
  'build',
  'cache',
  'check',
  'config',
  'create',
  'freeze',
  'global',
  'help',
  'info',
  'init',
  'list',
  'ls',
  'outdated',
  'pack',
  'pip',
  'publish',
  'remove',
  'rm',
  'run',
  'run-script',
  'search',
  'show',
  'start',
  'test',
  'tool',
  'uninstall',
  'version',
  'view',
  'why',
  'workspace',
  'workspaces',
])

const INFO_FLAGS = new Set(['--help', '--list', '--version', '-V', '-h', '-v'])

const GLOBAL_FLAGS = new Set(['--global', '-g'])

const WRAPPERS = new Set([
  'builtin',
  'command',
  'corepack',
  'doas',
  'env',
  'exec',
  'ionice',
  'nice',
  'nohup',
  'stdbuf',
  'sudo',
  'timeout',
  'xargs',
])

const JS_MANAGERS = {
  __proto__: null,
  npm: {
    bareInstalls: false,
    createVerbs: new Set(['create', 'init']),
    ecosystem: 'npm',
    verbs: NPM_INSTALL_VERBS,
  },
  pnpm: {
    bareInstalls: false,
    createVerbs: new Set(['create']),
    ecosystem: 'pnpm',
    verbs: PNPM_INSTALL_VERBS,
  },
  yarn: {
    bareInstalls: true,
    createVerbs: new Set(['create']),
    ecosystem: 'yarn',
    verbs: YARN_INSTALL_VERBS,
  },
}

const RUNNERS = {
  __proto__: null,
  npx: 'npm',
  pnpx: 'pnpm',
  uvx: 'uv',
}

const UV_NESTED_VERBS = {
  __proto__: null,
  pip: new Set(['install', 'sync']),
  tool: new Set(['install', 'run']),
}

const PIP_RE = /^pip(?:\d+(?:\.\d+)?)?$/

const PYTHON_RE = /^(?:py|python(?:\d+(?:\.\d+)?)?)$/

const SFW_PACKAGE_RE = /^sfw(?:@[\w.^~<>=*-]+)?$/

export function commandBaseName(word) {
  const base = path.posix.basename(word.replaceAll('\\', '/'))
  return base.replace(/\.(?:bat|cmd|exe|ps1)$/i, '').toLowerCase()
}

function isKnownVerb(verbs, value) {
  return verbs.has(value) || OTHER_VERBS.has(value)
}

export function findSubcommand(words, from, verbs) {
  let afterFlag = false
  for (let i = from, { length } = words; i < length; i += 1) {
    const value = words[i].value
    if (value.startsWith('-')) {
      afterFlag = !value.includes('=')
      continue
    }
    if (isKnownVerb(verbs, value) || !afterFlag) {
      return { index: i, value }
    }
    afterFlag = false
  }
  return undefined
}

function positionalArgs(words, from) {
  const args = []
  for (let i = from, { length } = words; i < length; i += 1) {
    if (!words[i].value.startsWith('-')) {
      args.push(words[i].value)
    }
  }
  return args
}

function hasFlag(words, from, flags) {
  for (let i = from, { length } = words; i < length; i += 1) {
    if (flags.has(words[i].value)) {
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

function classifyYarnWorkspace(rules, words, sub) {
  if (sub.value === 'workspace') {
    const rest = findSubcommand(words, sub.index + 2, rules.verbs)
    return rest && rules.verbs.has(rest.value) ? rules.ecosystem : undefined
  }
  const next = findSubcommand(words, sub.index + 1, rules.verbs)
  if (next?.value === 'focus') {
    return rules.ecosystem
  }
  if (next?.value === 'foreach') {
    const args = positionalArgs(words, next.index + 1)
    return args.some(arg => rules.verbs.has(arg)) ? rules.ecosystem : undefined
  }
  return undefined
}

function classifyJsSubcommand(rules, words, from, sub) {
  if (rules.verbs.has(sub.value)) {
    return isSfwSelfInstall(words, from, sub) ? undefined : rules.ecosystem
  }
  if (sub.value === 'global') {
    const next = findSubcommand(words, sub.index + 1, rules.verbs)
    return next?.value === 'add' && !isSfwSelfInstall(words, from, sub)
      ? rules.ecosystem
      : undefined
  }
  if (sub.value === 'workspace' || sub.value === 'workspaces') {
    return classifyYarnWorkspace(rules, words, sub)
  }
  if (sub.value === 'audit') {
    return positionalArgs(words, sub.index + 1)[0] === 'fix'
      ? rules.ecosystem
      : undefined
  }
  if (
    rules.createVerbs.has(sub.value) &&
    positionalArgs(words, sub.index + 1).length
  ) {
    return rules.ecosystem
  }
  return undefined
}

function classifyJsManager(rules, words, from, atCommand) {
  const sub = findSubcommand(words, from, rules.verbs)
  if (!sub) {
    return rules.bareInstalls && atCommand && !hasFlag(words, from, INFO_FLAGS)
      ? rules.ecosystem
      : undefined
  }
  return classifyJsSubcommand(rules, words, from, sub)
}

function classifyVerb(ecosystem, verbs, words, from) {
  const sub = findSubcommand(words, from, verbs)
  if (!sub || !verbs.has(sub.value)) {
    return undefined
  }
  return hasFlag(words, sub.index + 1, INFO_FLAGS) ? undefined : ecosystem
}

function classifyUv(words, from) {
  const sub = findSubcommand(words, from, UV_INSTALL_VERBS)
  if (!sub) {
    return undefined
  }
  if (UV_INSTALL_VERBS.has(sub.value)) {
    return 'uv'
  }
  const nestedVerbs = UV_NESTED_VERBS[sub.value]
  return nestedVerbs
    ? classifyVerb('uv', nestedVerbs, words, sub.index + 1)
    : undefined
}

function classifyRunner(ecosystem, words, from) {
  const args = positionalArgs(words, from)
  if (args.length === 0 || hasFlag(words, from, INFO_FLAGS)) {
    return undefined
  }
  return ecosystem
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
    if (!value.startsWith('-')) {
      return undefined
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
    return classifyVerb('pip', PIP_INSTALL_VERBS, words, module.from)
  }
  return module.name === 'uv' ? classifyUv(words, module.from) : undefined
}

export function classifyInstall(words, index, atCommand = true) {
  const base = commandBaseName(words[index].value)
  const from = index + 1
  const jsRules = JS_MANAGERS[base]
  if (jsRules) {
    return classifyJsManager(jsRules, words, from, atCommand)
  }
  if (RUNNERS[base]) {
    return classifyRunner(RUNNERS[base], words, from)
  }
  if (PIP_RE.test(base)) {
    return classifyVerb('pip', PIP_INSTALL_VERBS, words, from)
  }
  if (PYTHON_RE.test(base)) {
    return classifyPython(words, index)
  }
  if (base === 'uv') {
    return classifyUv(words, from)
  }
  if (base === 'cargo') {
    return classifyVerb('cargo', CARGO_INSTALL_VERBS, words, from)
  }
  return undefined
}

function commandIndex(words) {
  for (let i = 0, { length } = words; i < length; i += 1) {
    const value = words[i].value
    if (!ENV_ASSIGNMENT_RE.test(value) && !KEYWORDS.has(value)) {
      return i
    }
  }
  return -1
}

function joinWords(words, from) {
  const parts = []
  for (let i = from, { length } = words; i < length; i += 1) {
    parts.push(words[i].value)
  }
  return parts.join(' ')
}

function posixShellScript(words, index) {
  for (let i = index + 1, { length } = words; i < length - 1; i += 1) {
    if (/^-[a-z]*c[a-z]*$/i.test(words[i].value)) {
      return words[i + 1].value
    }
  }
  return undefined
}

function powershellScript(words, index) {
  for (let i = index + 1, { length } = words; i < length; i += 1) {
    const flag = words[i].value.toLowerCase()
    if (/^-(?:e|ec|enc|encodedcommand)$/.test(flag)) {
      return { unverifiable: 'an encoded PowerShell command' }
    }
    if (/^-(?:c|command)$/.test(flag)) {
      return { script: joinWords(words, i + 1) }
    }
  }
  return undefined
}

function envSplitScript(words, index) {
  for (let i = index + 1, { length } = words; i < length; i += 1) {
    const value = words[i].value
    if ((value === '-S' || value === '--split-string') && i + 1 < length) {
      return joinWords(words, i + 1)
    }
    const attached = /^(?:-S|--split-string=)(.+)$/.exec(value)
    if (attached) {
      return [attached[1], joinWords(words, i + 1)].join(' ')
    }
  }
  return undefined
}

function cmdScript(words, index) {
  for (let i = index + 1, { length } = words; i < length; i += 1) {
    if (/^\/[ck]$/i.test(words[i].value)) {
      return joinWords(words, i + 1)
    }
  }
  return undefined
}

function optionalScript(script) {
  return { scripts: script === undefined ? [] : [script] }
}

export function nestedScripts(words, index, heredocs) {
  const base = commandBaseName(words[index].value)
  if (POSIX_SHELLS.has(base)) {
    const script = posixShellScript(words, index)
    return { scripts: script === undefined ? heredocs : [script] }
  }
  if (POWERSHELLS.has(base)) {
    const found = powershellScript(words, index)
    if (found?.unverifiable) {
      return { scripts: [], unverifiable: found.unverifiable }
    }
    return { scripts: found ? [found.script] : heredocs }
  }
  if (base === 'cmd') {
    return optionalScript(cmdScript(words, index))
  }
  if (base === 'eval') {
    return { scripts: [joinWords(words, index + 1)] }
  }
  if (base === 'env') {
    return optionalScript(envSplitScript(words, index))
  }
  return { scripts: [] }
}

function textStart(segment) {
  const { words } = segment
  let i = 0
  while (i < words.length - 1 && KEYWORDS.has(words[i].value)) {
    i += 1
  }
  return i === 0 ? segment.start : words[i].start
}

function installFinding(command, segment, word, ecosystem) {
  const start = textStart(segment)
  const text = command.slice(start, segment.end)
  const offset = word.start - start
  return {
    ecosystem,
    command: text,
    suggestion: `${text.slice(0, offset)}sfw ${text.slice(offset)}`,
  }
}

function unverifiableFinding(text, reason) {
  return { ecosystem: 'unknown', command: text, reason, suggestion: '' }
}

function scanNested(state, words, index, segment) {
  const before = state.found.length
  const nested = nestedScripts(words, index, segment.heredocs)
  if (nested.unverifiable) {
    const text = state.command.slice(segment.start, segment.end)
    state.found.push(unverifiableFinding(text, nested.unverifiable))
  }
  for (let i = 0, { length } = nested.scripts; i < length; i += 1) {
    collectInstalls(state, nested.scripts[i], state.depth + 1)
  }
  return state.found.length > before
}

function isCommandPosition(words, index, start) {
  if (index === start) {
    return true
  }
  const previous = words[index - 1].value
  return WRAPPERS.has(commandBaseName(previous)) || /^(?:-|\d)/.test(previous)
}

function scanSegment(state, segment) {
  const { words } = segment
  const start = commandIndex(words)
  if (start === -1 || DATA_COMMANDS.has(commandBaseName(words[start].value))) {
    return
  }
  for (let i = start, { length } = words; i < length; i += 1) {
    if (commandBaseName(words[i].value) === 'sfw') {
      return
    }
    if (scanNested(state, words, i, segment)) {
      return
    }
    const ecosystem = classifyInstall(
      words,
      i,
      isCommandPosition(words, i, start),
    )
    if (ecosystem) {
      state.found.push(
        installFinding(state.command, segment, words[i], ecosystem),
      )
      return
    }
  }
}

function collectInstalls(parent, command, depth) {
  if (typeof command !== 'string' || !command.trim()) {
    return
  }
  if (depth > MAX_DEPTH) {
    parent.found.push(
      unverifiableFinding(command, 'a command nested too deeply to check'),
    )
    return
  }
  const { tokens, substitutions } = tokenizeShellCommand(command, {
    windows: parent.windows,
  })
  const state = { ...parent, command, depth }
  const segments = splitShellSegments(tokens)
  for (let i = 0, { length } = segments; i < length; i += 1) {
    scanSegment(state, segments[i])
  }
  for (let i = 0, { length } = substitutions; i < length; i += 1) {
    collectInstalls(state, substitutions[i], depth + 1)
  }
}

function dedupeFindings(found) {
  const seen = new Set()
  return found.filter(finding => {
    const key = `${finding.ecosystem}\0${finding.suggestion || finding.command}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

export function findUnprotectedInstalls(command, options) {
  const { platform = process.platform } = { __proto__: null, ...options }
  const root = { found: [], windows: platform === 'win32' }
  collectInstalls(root, command, 0)
  return dedupeFindings(root.found)
}

export function isSfwOnPath(env) {
  const pathValue = env?.PATH ?? env?.Path ?? ''
  if (!pathValue) {
    return false
  }
  const dirs = pathValue.split(path.delimiter).filter(Boolean)
  const names = ['sfw', 'sfw.cmd', 'sfw.exe']
  return dirs.some(dir => names.some(name => existsSync(path.join(dir, name))))
}

function describeFindings(installs) {
  const lines = []
  for (let i = 0, { length } = installs; i < length; i += 1) {
    const install = installs[i]
    lines.push(
      install.suggestion
        ? `  ${install.suggestion}`
        : `  (${install.reason}: rewrite it as a plain command with sfw in front of the package manager)`,
    )
  }
  return lines.join('\n')
}

export function evaluateInstallCommand(command, options) {
  const { env = process.env, platform } = { __proto__: null, ...options }
  if (env.SOCKET_INSTALL_GATE === 'off') {
    return { decision: 'allow' }
  }
  const installs = findUnprotectedInstalls(command, { platform })
  if (installs.length === 0) {
    return { decision: 'allow' }
  }
  const sfwInstalled = isSfwOnPath(env)
  const setup = sfwInstalled
    ? ''
    : `sfw is not installed yet. Install it first with \`${SFW_INSTALL_COMMAND}\` (no Socket account or API key needed). `
  const agentMessage =
    `Protected by Socket: this command installs packages without Socket Firewall, so it was not run.\n` +
    `${setup}Run the install through sfw instead:\n${describeFindings(installs)}\n` +
    `sfw checks every package against Socket before it downloads and blocks known malware. Docs: ${SFW_DOCS_URL}`
  const userMessage =
    `Protected by Socket: package installs run through Socket Firewall (sfw). ` +
    `${sfwInstalled ? '' : `Install it with \`${SFW_INSTALL_COMMAND}\`. `}` +
    `Manage protection with a Socket account: ${SOCKET_SIGN_UP_URL}`
  return {
    decision: 'deny',
    installs,
    sfwInstalled,
    agentMessage,
    userMessage,
  }
}
