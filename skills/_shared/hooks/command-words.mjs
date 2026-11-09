/**
 * @file Find the command word of a shell segment and the scripts it runs.
 *   Walks wrapper commands (sudo, env, timeout, xargs, ...) with each
 *   wrapper's own options, so the word they run is found exactly, and
 *   extracts scripts passed to shells and other command runners.
 */

import path from 'node:path'

export const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/

const KEYWORDS = new Set([
  '!',
  'coproc',
  'do',
  'elif',
  'else',
  'if',
  'then',
  'until',
  'while',
])

function flags(...names) {
  return new Set(names)
}

const PYTHON_ENV_RUN = { subcommands: flags('run') }

const DASH_C_STOP = flags('-c', '--command')

const WRAPPERS = {
  __proto__: null,
  arch: {},
  builtin: {},
  caffeinate: { valueFlags: flags('-t', '-w') },
  conda: {
    subcommands: flags('run'),
    valueFlags: flags('-n', '-p', '--cwd', '--name', '--prefix'),
  },
  direnv: { positionals: 1, subcommands: flags('exec') },
  flock: { positionals: 1, stopFlags: DASH_C_STOP, valueFlags: flags('-w') },
  hatch: PYTHON_ENV_RUN,
  lerna: {
    subcommands: flags('exec'),
    valueFlags: flags('--concurrency', '--ignore', '--scope'),
  },
  mamba: {
    subcommands: flags('run'),
    valueFlags: flags('-n', '-p', '--name', '--prefix'),
  },
  micromamba: {
    subcommands: flags('run'),
    valueFlags: flags('-n', '-p', '--name', '--prefix'),
  },
  parallel: { valueFlags: flags('-j', '-P', '--jobs') },
  pdm: PYTHON_ENV_RUN,
  pipenv: PYTHON_ENV_RUN,
  poetry: PYTHON_ENV_RUN,
  rye: PYTHON_ENV_RUN,
  runuser: {
    stopFlags: DASH_C_STOP,
    valueFlags: flags('-g', '-u', '--group', '--user'),
  },
  script: { positionals: 1, stopFlags: DASH_C_STOP, valueFlags: flags('-t') },
  setsid: {},
  taskset: { positionals: 1 },
  unbuffer: {},
  chrt: { positionals: 1 },
  command: { lookupFlags: flags('-v', '-V') },
  corepack: {},
  'cross-env': { assignments: true },
  doas: { valueFlags: flags('-u', '-C') },
  dotenv: { valueFlags: flags('-e', '-v', '-c') },
  env: {
    assignments: true,
    stopFlags: flags('-S', '--split-string'),
    valueFlags: flags('-u', '-C', '--unset', '--chdir'),
  },
  exec: { valueFlags: flags('-a') },
  ionice: { valueFlags: flags('-c', '-n', '-p', '--class', '--classdata') },
  mise: { skipToDoubleDash: true, subcommands: flags('exec', 'x') },
  nice: { valueFlags: flags('-n', '--adjustment') },
  nohup: {},
  stdbuf: { valueFlags: flags('-i', '-o', '-e') },
  sudo: {
    valueFlags: flags(
      '-C',
      '-D',
      '-g',
      '-h',
      '-p',
      '-r',
      '-T',
      '-t',
      '-U',
      '-u',
      '--chdir',
      '--group',
      '--host',
      '--other-user',
      '--prompt',
      '--role',
      '--type',
      '--user',
    ),
  },
  time: { valueFlags: flags('-f', '-o', '--format', '--output') },
  timeout: {
    positionals: 1,
    valueFlags: flags('-k', '-s', '--kill-after', '--signal'),
  },
  volta: {
    subcommands: flags('run'),
    valueFlags: flags('--env', '--node', '--npm', '--pnpm', '--yarn'),
  },
  xargs: {
    valueFlags: flags(
      '-a',
      '-d',
      '-E',
      '-I',
      '-L',
      '-n',
      '-P',
      '-s',
      '--arg-file',
      '--delimiter',
      '--max-args',
      '--max-chars',
      '--max-lines',
      '--max-procs',
      '--replace',
    ),
  },
}

export const POSIX_SHELLS = new Set([
  'bash',
  'dash',
  'fish',
  'ksh',
  'sh',
  'zsh',
])

const POWERSHELLS = new Set(['powershell', 'pwsh'])

const EXPRESSION_RUNNERS = new Set(['eval', 'iex', 'invoke-expression'])

const DASH_C_RUNNERS = {
  __proto__: null,
  flock: flags('-c', '--command'),
  runuser: flags('-c', '--command'),
  script: flags('-c', '--command'),
  su: flags('-c', '--command'),
  'nix-shell': flags('--command', '--run'),
}

export function commandBaseName(word) {
  const base = path.posix.basename(word.replaceAll('\\', '/'))
  return base
    .replace(/\.(?:bat|cmd|exe|ps1)$/i, '')
    .replace(/(?<=.)@[\w.^~<>=*-]*$/, '')
    .toLowerCase()
}

export function skipKeywords(words) {
  let i = 0
  while (i < words.length && KEYWORDS.has(words[i].value)) {
    i += 1
  }
  return i
}

function skipAssignments(words, from) {
  let i = from
  while (i < words.length && ENV_ASSIGNMENT_RE.test(words[i].value)) {
    i += 1
  }
  return i
}

function isOption(value) {
  return value.length > 1 && value.startsWith('-')
}

function wrapperOptionStep(spec, value) {
  if (spec.lookupFlags?.has(value)) {
    return 'lookup'
  }
  if (
    spec.stopFlags?.has(value) ||
    (spec.stopFlags?.has('-S') && /^(?:-S|--split-string=)./.test(value))
  ) {
    return 'stop'
  }
  return spec.valueFlags?.has(value) ? 2 : 1
}

function skipWrapperArgs(spec, words, from) {
  let j = from
  let positionals = spec.positionals ?? 0
  while (j < words.length) {
    const value = words[j].value
    if (value === '--') {
      return { next: j + 1 }
    }
    if (isOption(value)) {
      const step = wrapperOptionStep(spec, value)
      if (typeof step === 'string') {
        return { stop: step }
      }
      j += step
      continue
    }
    if (spec.assignments && ENV_ASSIGNMENT_RE.test(value)) {
      j += 1
      continue
    }
    if (positionals === 0) {
      break
    }
    positionals -= 1
    j += 1
  }
  return { next: j }
}

function wrapperArgsStart(spec, words, index) {
  if (!spec.subcommands) {
    return index + 1
  }
  const sub = words[index + 1]?.value
  if (!sub || !spec.subcommands.has(sub)) {
    return -1
  }
  if (spec.skipToDoubleDash) {
    const dashes = words.findIndex(
      (word, i) => i > index && word.value === '--',
    )
    return dashes === -1 ? index + 2 : dashes
  }
  return index + 2
}

export function resolveCommandWord(words) {
  let i = skipKeywords(words)
  while (i < words.length) {
    i = skipAssignments(words, i)
    if (i >= words.length) {
      return { index: -1 }
    }
    const spec = WRAPPERS[commandBaseName(words[i].value)]
    const argsStart = spec ? wrapperArgsStart(spec, words, i) : -1
    if (argsStart === -1) {
      return { index: i }
    }
    const skipped = skipWrapperArgs(spec, words, argsStart)
    if (skipped.stop === 'lookup') {
      return { index: -1 }
    }
    if (skipped.stop === 'stop') {
      return { index: i }
    }
    i = skipped.next
    i += skipKeywords(words.slice(i))
  }
  return { index: -1 }
}

export function joinWords(words, from, until) {
  const parts = []
  for (let i = from, { length } = words; i < length; i += 1) {
    if (until?.has(words[i].value)) {
      break
    }
    parts.push(words[i].value)
  }
  return parts.join(' ')
}

function isDashC(value) {
  if (value.length < 2 || value[0] !== '-' || value[1] === '-') {
    return false
  }
  const letters = value.slice(1)
  return /^[a-z]+$/i.test(letters) && letters.includes('c')
}

const SHELL_OPTION_VALUE_FLAGS = flags('-o', '+o', '-O', '+O')

function shellOperand(words, from) {
  let i = from
  while (i < words.length) {
    const value = words[i].value
    if (value === '--') {
      return words[i + 1]?.value
    }
    if (!/^[-+]./.test(value)) {
      return value
    }
    i += SHELL_OPTION_VALUE_FLAGS.has(value) ? 2 : 1
  }
  return undefined
}

function posixShellScript(words, index) {
  for (let i = index + 1, { length } = words; i < length; i += 1) {
    if (isDashC(words[i].value)) {
      return shellOperand(words, i + 1)
    }
  }
  return undefined
}

function optionValue(words, index, names) {
  for (let i = index + 1, { length } = words; i < length; i += 1) {
    const value = words[i].value
    if (names.has(value) && i + 1 < length) {
      return words[i + 1].value
    }
    const eq = value.indexOf('=')
    if (eq !== -1 && names.has(value.slice(0, eq))) {
      return value.slice(eq + 1)
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
    if (value === '-S' || value === '--split-string') {
      return joinWords(words, i + 1)
    }
    const attached = /^(?:-S|--split-string=)(.+)$/.exec(value)
    if (attached) {
      return [attached[1], joinWords(words, i + 1)].join(' ').trim()
    }
  }
  return undefined
}

function positionalFrom(words, from, valueFlags) {
  let i = from
  while (i < words.length && isOption(words[i].value)) {
    i += valueFlags.has(words[i].value) ? 2 : 1
  }
  return i
}

const GIT_VALUE_FLAGS = flags(
  '-C',
  '-c',
  '--git-dir',
  '--namespace',
  '--work-tree',
)

function gitScript(words, index) {
  const subIndex = positionalFrom(words, index + 1, GIT_VALUE_FLAGS)
  const sub = words[subIndex]?.value
  if (sub === 'submodule' && words[subIndex + 1]?.value === 'foreach') {
    return joinWords(words, positionalFrom(words, subIndex + 2, new Set()))
  }
  if (sub === 'bisect' && words[subIndex + 1]?.value === 'run') {
    return joinWords(words, subIndex + 2)
  }
  if (sub === 'rebase') {
    return optionValue(words, index, flags('-x', '--exec'))
  }
  return undefined
}

function ghScript(words, index) {
  if (words[index + 1]?.value !== 'codespace') {
    return undefined
  }
  const dashes = words.findIndex((word, i) => i > index && word.value === '--')
  return dashes === -1 ? undefined : joinWords(words, dashes + 1)
}

function findExecScript(words, index) {
  const exec = words.findIndex(
    (word, i) => i > index && /^-(?:exec|execdir|ok|okdir)$/.test(word.value),
  )
  return exec === -1 ? undefined : joinWords(words, exec + 1, flags(';', '+'))
}

function nixScript(words, index) {
  const sub = words[index + 1]?.value
  if (sub !== 'develop' && sub !== 'shell') {
    return undefined
  }
  const flag = words.findIndex(
    (word, i) =>
      i > index && (word.value === '-c' || word.value === '--command'),
  )
  return flag === -1 ? undefined : joinWords(words, flag + 1)
}

function watchScript(words, index) {
  return joinWords(
    words,
    positionalFrom(words, index + 1, flags('-n', '--interval', '-q')),
  )
}

const SCRIPT_RUNNERS = {
  __proto__: null,
  cmd: (words, index) => {
    const flag = words.findIndex(
      (word, i) => i > index && /^\/[ck]$/i.test(word.value),
    )
    return flag === -1 ? undefined : joinWords(words, flag + 1)
  },
  env: envSplitScript,
  find: findExecScript,
  gh: ghScript,
  git: gitScript,
  nix: nixScript,
  trap: (words, index) => words[index + 1]?.value,
  watch: watchScript,
}

function optionalScript(script) {
  return { scripts: script ? [script] : [] }
}

export function nestedScripts(words, index, stdinScripts) {
  const base = commandBaseName(words[index].value)
  if (POSIX_SHELLS.has(base)) {
    const script = posixShellScript(words, index)
    return { scripts: script === undefined ? stdinScripts : [script] }
  }
  if (POWERSHELLS.has(base)) {
    const found = powershellScript(words, index)
    if (found?.unverifiable) {
      return { scripts: [], unverifiable: found.unverifiable }
    }
    return { scripts: found ? [found.script] : stdinScripts }
  }
  if (EXPRESSION_RUNNERS.has(base)) {
    return { scripts: [joinWords(words, index + 1)] }
  }
  if (DASH_C_RUNNERS[base]) {
    return optionalScript(optionValue(words, index, DASH_C_RUNNERS[base]))
  }
  const runner = SCRIPT_RUNNERS[base]
  return runner ? optionalScript(runner(words, index)) : { scripts: [] }
}

export function pipedScripts(previous) {
  if (!previous) {
    return []
  }
  const scripts = [...previous.heredocs]
  const index = resolveCommandWord(previous.words).index
  if (index === -1) {
    return scripts
  }
  const base = commandBaseName(previous.words[index].value)
  if (base === 'echo' || base === 'printf') {
    scripts.push(
      joinWords(
        previous.words,
        positionalFrom(previous.words, index + 1, new Set()),
      ),
    )
  }
  return scripts
}
