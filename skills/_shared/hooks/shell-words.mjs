/**
 * @file Split a shell command line into segments of words. Tracks quotes,
 *   command substitutions, redirections, and heredocs so callers can tell
 *   which words are commands and which are data.
 */

const OPERATORS = ['&&', '||', ';;', ';&', '|&', ';', '|', '&', '\n', '(', ')']

const REDIRECT_RE = /^(?:&>>|&>|\d*(?:<<-|<<<|<<|>>|>&|<&|>\||<>|>|<))/

const WHITESPACE_CHARS = new Set([' ', '\t', '\r'])

const BRACE_CHARS = new Set(['{', '}'])

export function createShellState(command, options) {
  const { windows = false } = { __proto__: null, ...options }
  return {
    command,
    current: '',
    heredocs: [],
    quote: '',
    start: -1,
    substitutions: [],
    tokens: [],
    windows,
  }
}

function startWord(state, index) {
  if (state.start === -1) {
    state.start = index
  }
}

function flushWord(state, end) {
  if (state.start !== -1) {
    state.tokens.push({
      type: 'word',
      value: state.current,
      start: state.start,
      end,
    })
  }
  state.current = ''
  state.start = -1
}

function matchOperator(command, index) {
  for (let i = 0, { length } = OPERATORS; i < length; i += 1) {
    if (command.startsWith(OPERATORS[i], index)) {
      return OPERATORS[i]
    }
  }
  return ''
}

function skipQuoted(command, index, quote) {
  let i = index + 1
  const { length } = command
  while (i < length && command[i] !== quote) {
    i += command[i] === '\\' && quote === '"' ? 2 : 1
  }
  return i + 1
}

export function findClosingParen(command, index) {
  let depth = 1
  let i = index
  const { length } = command
  while (i < length) {
    const char = command[i]
    if (char === "'" || char === '"') {
      i = skipQuoted(command, i, char)
      continue
    }
    if (char === '\\') {
      i += 2
      continue
    }
    if (char === '(') {
      depth += 1
    } else if (char === ')') {
      depth -= 1
      if (depth === 0) {
        return i
      }
    }
    i += 1
  }
  return -1
}

function readDollarParen(state, index) {
  const { command } = state
  const close = findClosingParen(command, index + 2)
  const end = close === -1 ? command.length : close + 1
  state.substitutions.push(command.slice(index + 2, close === -1 ? end : close))
  startWord(state, index)
  state.current += command.slice(index, end)
  return end
}

function readBacktick(state, index) {
  const { command } = state
  let close = index + 1
  const { length } = command
  while (close < length && command[close] !== '`') {
    close += command[close] === '\\' ? 2 : 1
  }
  const end = Math.min(close + 1, length)
  state.substitutions.push(command.slice(index + 1, Math.min(close, length)))
  startWord(state, index)
  state.current += command.slice(index, end)
  return end
}

function readSubstitution(state, index) {
  const { command } = state
  if (command[index] === '$' && command[index + 1] === '(') {
    return readDollarParen(state, index)
  }
  if (command[index] === '`') {
    return readBacktick(state, index)
  }
  return -1
}

function stepQuoted(state, index) {
  const { command } = state
  const char = command[index]
  if (char === state.quote) {
    state.quote = ''
    return index + 1
  }
  if (state.quote === '"') {
    const next = readSubstitution(state, index)
    if (next !== -1) {
      return next
    }
    if (char === '\\' && !state.windows && index + 1 < command.length) {
      state.current += command[index + 1]
      return index + 2
    }
  }
  state.current += char
  return index + 1
}

function stepEscape(state, index) {
  const next = state.command[index + 1]
  if (next === '\n') {
    return index + 2
  }
  startWord(state, index)
  state.current += next
  return index + 2
}

function readHeredocBodies(state, index) {
  const { command } = state
  let cursor = index + 1
  const pending = state.heredocs.filter(heredoc => heredoc.body === undefined)
  for (let i = 0, { length } = pending; i < length; i += 1) {
    const heredoc = pending[i]
    const lines = []
    while (cursor < command.length) {
      const newline = command.indexOf('\n', cursor)
      const lineEnd = newline === -1 ? command.length : newline
      const line = command.slice(cursor, lineEnd)
      cursor = lineEnd + 1
      const compare = heredoc.stripTabs ? line.replace(/^\t+/, '') : line
      if (compare === heredoc.delimiter) {
        break
      }
      lines.push(line)
    }
    heredoc.body = lines.join('\n')
  }
  return cursor
}

function stepNewline(state, index) {
  flushWord(state, index)
  state.tokens.push({ type: 'operator', value: '\n', start: index })
  if (state.heredocs.some(heredoc => heredoc.body === undefined)) {
    return readHeredocBodies(state, index)
  }
  return index + 1
}

function stepRedirect(state, index, redirect) {
  flushWord(state, index)
  state.tokens.push({ type: 'redirect', value: redirect, start: index })
  return index + redirect.length
}

function stepUnquoted(state, index) {
  const { command } = state
  const char = command[index]
  const substitution = readSubstitution(state, index)
  if (substitution !== -1) {
    return substitution
  }
  if (char === "'" || char === '"') {
    startWord(state, index)
    state.quote = char
    return index + 1
  }
  if (char === '\\' && !state.windows && index + 1 < command.length) {
    return stepEscape(state, index)
  }
  return -1
}

function stepStructure(state, index) {
  const { command } = state
  const char = command[index]
  const redirectSource =
    state.start === -1 ? command.slice(index) : command.slice(index, index + 3)
  const redirect = REDIRECT_RE.exec(redirectSource)
  if (redirect && (state.start === -1 || !/^\d/.test(redirect[0]))) {
    return stepRedirect(state, index, redirect[0])
  }
  if (char === '\n') {
    return stepNewline(state, index)
  }
  const operator = matchOperator(command, index)
  if (operator) {
    flushWord(state, index)
    state.tokens.push({ type: 'operator', value: operator, start: index })
    return index + operator.length
  }
  if (state.start === -1 && BRACE_CHARS.has(char)) {
    state.tokens.push({ type: 'operator', value: char, start: index })
    return index + 1
  }
  return -1
}

function stepTokenizer(state, index) {
  const { command } = state
  const char = command[index]
  if (state.quote) {
    return stepQuoted(state, index)
  }
  const quoted = stepUnquoted(state, index)
  if (quoted !== -1) {
    return quoted
  }
  const structural = stepStructure(state, index)
  if (structural !== -1) {
    return structural
  }
  if (WHITESPACE_CHARS.has(char)) {
    flushWord(state, index)
    return index + 1
  }
  if (char === '#' && state.start === -1) {
    const newline = command.indexOf('\n', index)
    return newline === -1 ? command.length : newline
  }
  startWord(state, index)
  state.current += char
  return index + 1
}

function attachHeredocDelimiters(state) {
  const { tokens } = state
  for (let i = 0, { length } = tokens; i < length - 1; i += 1) {
    const token = tokens[i]
    const target = tokens[i + 1]
    if (
      token.type === 'redirect' &&
      /<<-?$/.test(token.value) &&
      target.type === 'word' &&
      !token.heredoc
    ) {
      token.heredoc = {
        delimiter: target.value,
        stripTabs: token.value.endsWith('-'),
        body: undefined,
      }
      state.heredocs.push(token.heredoc)
    }
  }
}

export function tokenizeShellCommand(command, options) {
  const state = createShellState(command, options)
  const { length } = command
  let index = 0
  while (index < length) {
    if (!state.quote && command[index] === '\n') {
      flushWord(state, index)
      attachHeredocDelimiters(state)
    }
    index = stepTokenizer(state, index)
  }
  flushWord(state, length)
  attachHeredocDelimiters(state)
  return {
    tokens: state.tokens,
    substitutions: state.substitutions,
  }
}

function newSegment() {
  return { words: [], heredocs: [], start: -1, end: -1 }
}

function extendSegment(segment, token) {
  if (segment.start === -1) {
    segment.start = token.start
  }
  segment.end = token.end ?? token.start + token.value.length
}

function redirectTakesTarget(token, target) {
  if (target?.type !== 'word') {
    return false
  }
  return !token.value.endsWith('&') || /^(?:\d+|-)$/.test(target.value)
}

function addRedirect(segment, token, target) {
  if (token.heredoc?.body !== undefined) {
    segment.heredocs.push(token.heredoc.body)
  } else if (token.value.endsWith('<<<') && target?.type === 'word') {
    segment.heredocs.push(target.value)
  }
  if (!redirectTakesTarget(token, target)) {
    return false
  }
  extendSegment(segment, target)
  return true
}

export function splitShellSegments(tokens) {
  const segments = []
  let segment = newSegment()
  for (let i = 0, { length } = tokens; i < length; i += 1) {
    const token = tokens[i]
    if (token.type === 'operator') {
      if (segment.start !== -1) {
        segments.push(segment)
      }
      segment = newSegment()
      continue
    }
    extendSegment(segment, token)
    if (token.type === 'redirect') {
      i += addRedirect(segment, token, tokens[i + 1]) ? 1 : 0
      continue
    }
    segment.words.push(token)
  }
  if (segment.start !== -1) {
    segments.push(segment)
  }
  return segments
}
