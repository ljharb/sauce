/**
 * @file Cursor beforeShellExecution hook: reads the hook input from stdin
 *   and answers with a permission that blocks package installs which do not
 *   run through Socket Firewall.
 */

import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { evaluateInstallCommand } from './install-gate.mjs'

export function buildCursorHookResponse(input, env) {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.command !== 'string'
  ) {
    return buildCursorHookFailure(
      new TypeError('hook input has no string "command" field'),
    )
  }
  const result = evaluateInstallCommand(input.command, {
    cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
    env,
  })
  if (result.decision === 'allow') {
    return { permission: 'allow' }
  }
  return {
    permission: 'deny',
    user_message: result.userMessage,
    agent_message: result.agentMessage,
  }
}

export function buildCursorHookFailure(error) {
  const detail =
    `Socket install check failed.\n` +
    `  Where: Cursor beforeShellExecution hook\n` +
    `  Saw:   ${error?.message ?? error}\n` +
    `  Fix:   check that Cursor sent JSON hook input on stdin, then run the command again.`
  return {
    permission: 'deny',
    user_message: detail,
    agent_message: detail,
  }
}

export async function readStdin(stream) {
  let text = ''
  stream.setEncoding('utf8')
  for await (const chunk of stream) {
    text += chunk
  }
  return text
}

export async function runCursorHook(stream, env) {
  const text = await readStdin(stream)
  const input = JSON.parse(text)
  return buildCursorHookResponse(input, env)
}

export function isEntryScript(moduleUrl, argvPath) {
  if (!argvPath) {
    return false
  }
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

if (isEntryScript(import.meta.url, process.argv[1])) {
  runCursorHook(process.stdin, process.env).then(
    response => {
      process.stdout.write(`${JSON.stringify(response)}\n`)
    },
    error => {
      process.stdout.write(`${JSON.stringify(buildCursorHookFailure(error))}\n`)
    },
  )
}
