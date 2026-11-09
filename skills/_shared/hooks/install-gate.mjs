/**
 * @file Decide whether an agent's shell command installs packages without
 *   Socket Firewall. Agent hooks (Cursor, Claude Code, Codex) call
 *   evaluateInstallCommand and map the result onto their own hook output.
 *   Dependency-free: it runs from an installed plugin with only Node.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {
  commandBaseName,
  nestedScripts,
  pipedScripts,
  resolveCommandWord,
  skipKeywords,
} from './command-words.mjs'
import { classifyInstall } from './install-classify.mjs'
import { splitShellSegments, tokenizeShellCommand } from './shell-words.mjs'

export const SOCKET_SIGN_UP_URL = 'https://socket.dev/'
export const SFW_DOCS_URL = 'https://docs.socket.dev/docs/socket-firewall-free'
export const SFW_INSTALL_COMMAND = 'npm install -g sfw'

const MAX_DEPTH = 4

const MAX_COMMAND_LENGTH = 100_000

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
  'fgrep',
  'grep',
  'hash',
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

function installFinding(command, segment, word, ecosystem) {
  const keywordEnd = skipKeywords(segment.words)
  const start =
    keywordEnd === 0 || keywordEnd >= segment.words.length
      ? segment.start
      : segment.words[keywordEnd].start
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

function scanNested(state, segment, index, previous) {
  const stdin = [
    ...segment.heredocs,
    ...(segment.after === '|' ? pipedScripts(previous) : []),
  ]
  const nested = nestedScripts(segment.words, index, stdin)
  if (nested.unverifiable) {
    const text = state.command.slice(segment.start, segment.end)
    state.found.push(unverifiableFinding(text, nested.unverifiable))
  }
  for (let i = 0, { length } = nested.scripts; i < length; i += 1) {
    collectInstalls(state, nested.scripts[i], state.depth + 1)
  }
  return nested.scripts.length > 0 || Boolean(nested.unverifiable)
}

function scanSegment(state, segment, previous) {
  const { words } = segment
  const { index } = resolveCommandWord(words)
  if (index === -1) {
    return
  }
  const base = commandBaseName(words[index].value)
  if (base === 'sfw' || scanNested(state, segment, index, previous)) {
    return
  }
  if (DATA_COMMANDS.has(base)) {
    return
  }
  const ecosystem = classifyInstall(words, index, { cwd: state.cwd })
  if (ecosystem) {
    state.found.push(
      installFinding(state.command, segment, words[index], ecosystem),
    )
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
    scanSegment(state, segments[i], segments[i - 1])
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
  const { cwd, platform = process.platform } = { __proto__: null, ...options }
  if (typeof command === 'string' && command.length > MAX_COMMAND_LENGTH) {
    return [unverifiableFinding('', 'a command too long to check')]
  }
  const found = []
  const modes = platform === 'win32' ? [false, true] : [false]
  for (let i = 0, { length } = modes; i < length; i += 1) {
    collectInstalls({ cwd, found, windows: modes[i] }, command, 0)
  }
  return dedupeFindings(found)
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
  const { cwd, env = process.env, platform } = { __proto__: null, ...options }
  if (env.SOCKET_INSTALL_GATE === 'off') {
    return { decision: 'allow' }
  }
  const installs = findUnprotectedInstalls(command, { cwd, platform })
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
