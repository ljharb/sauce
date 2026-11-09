/**
 * @file Split a shell command line into segments of words. Tracks quotes,
 *   command substitutions, redirections, and heredocs so callers can tell
 *   which words are commands and which are data. In Windows mode a backslash
 *   is literal and a backtick escapes the next character, as in PowerShell.
 */

const OPERATORS = ['&&', '||', ';;', ';&', '|&', ';', '|', '&', '(', ')']

const REDIRECT_RE = /^(?:&>>|&>|\d*(?:<<-|<<<|<<|>>|>&|<&|>\||<>|>|<))/

const HEREDOC_RE = /^\d*<<-?$/

const WHITESPACE_CHARS = new Set([' ', '\t', '\r'])

const BRACE_END_CHARS = new Set([' ', '\t', '\r', '\n', ';', '&', '|', ')'])

const BRACE_AFTER_OPERATORS = new Set([';', '\n', '&', '&&', '||', '|'])

export function createShellState(command, options) {
  const { windows = false } = { __proto__: null, ...options }
  return {
    attachFrom: 0,
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

function isWordAt(command, index, word) {
  return (
    command.startsWith(word, index) &&
    !/[\w-]/.test(command[index - 1] ?? ' ') &&
    !/[\w-]/.test(command[index + word.length] ?? ' ')
  )
}

function stepParen(char, depth, caseDepth) {
  if (char === '(') {
    return depth + 1
  }
  if (char === ')' && caseDepth === 0) {
    return depth - 1
  }
  return depth
}

function readDelimiterWord(command, from) {
  let i = from
  while (command[i] === ' ' || command[i] === '\t') {
    i += 1
  }
  const quote = command[i] === "'" || command[i] === '"' ? command[i] : ''
  if (quote) {
    const close = command.indexOf(quote, i + 1)
    return close === -1 ? '' : command.slice(i + 1, close)
  }
  const match = /^[^\s;&|()<>]+/.exec(command.slice(i))
  return match ? match[0].replaceAll('\\', '') : ''
}

export function skipHeredocText(command, index) {
  const stripTabs = command[index + 2] === '-'
  const delimiter = readDelimiterWord(command, index + (stripTabs ? 3 : 2))
  const lineEnd = command.indexOf('\n', index)
  if (!delimiter || lineEnd === -1) {
    return index + 2
  }
  let cursor = lineEnd + 1
  while (cursor < command.length) {
    const newline = command.indexOf('\n', cursor)
    const end = newline === -1 ? command.length : newline
    const line = command.slice(cursor, end)
    cursor = end + 1
    if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) {
      return end
    }
  }
  return command.length
}

function skipSpecial(command, i) {
  const char = command[i]
  if (char === "'" || char === '"') {
    return skipQuoted(command, i, char)
  }
  if (char === '\\') {
    return i + 2
  }
  if (command.startsWith('<<', i) && command[i + 2] !== '<') {
    return skipHeredocText(command, i)
  }
  return -1
}

export function findClosingParen(command, index) {
  let depth = 1
  let caseDepth = 0
  let i = index
  const { length } = command
  while (i < length) {
    const char = command[i]
    const skipped = skipSpecial(command, i)
    if (skipped !== -1) {
      i = skipped
      continue
    }
    if (isWordAt(command, i, 'case')) {
      caseDepth += 1
    } else if (caseDepth && isWordAt(command, i, 'esac')) {
      caseDepth -= 1
    }
    depth = stepParen(char, depth, caseDepth)
    if (depth === 0) {
      return i
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

function readAnsiCString(state, index) {
  const { command } = state
  let close = index + 2
  const { length } = command
  while (close < length && command[close] !== "'") {
    close += command[close] === '\\' ? 2 : 1
  }
  const end = Math.min(close + 1, length)
  startWord(state, index)
  state.current += command.slice(index + 2, Math.min(close, length))
  return end
}

function readSubstitution(state, index) {
  const { command } = state
  if (command[index] === '$' && command[index + 1] === '(') {
    return readDollarParen(state, index)
  }
  if (command[index] === '`' && !state.windows) {
    return readBacktick(state, index)
  }
  return -1
}

function escapeChar(state) {
  return state.windows ? '`' : '\\'
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
    if (char === escapeChar(state) && index + 1 < command.length) {
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

export function extractSubstitutions(text) {
  const found = []
  let i = 0
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2
    } else if (text.startsWith('$(', i)) {
      const close = findClosingParen(text, i + 2)
      const end = close === -1 ? text.length : close
      found.push(text.slice(i + 2, end))
      i = end + 1
    } else if (text[i] === '`') {
      const close = text.indexOf('`', i + 1)
      const end = close === -1 ? text.length : close
      found.push(text.slice(i + 1, end))
      i = end + 1
    } else {
      i += 1
    }
  }
  return found
}

function readHeredocBody(state, cursor, heredoc) {
  const { command } = state
  const lines = []
  let next = cursor
  let terminated = false
  while (next < command.length) {
    const newline = command.indexOf('\n', next)
    const lineEnd = newline === -1 ? command.length : newline
    const line = command.slice(next, lineEnd)
    next = lineEnd + 1
    const compare = heredoc.stripTabs ? line.replace(/^\t+/, '') : line
    if (compare === heredoc.delimiter) {
      terminated = true
      break
    }
    lines.push(line)
  }
  heredoc.body = lines.join('\n')
  if (!terminated) {
    state.substitutions.push(heredoc.body)
  } else if (!heredoc.quoted) {
    state.substitutions.push(...extractSubstitutions(heredoc.body))
  }
  return next
}

function stepNewline(state, index) {
  flushWord(state, index)
  attachHeredocDelimiters(state)
  state.tokens.push({ type: 'operator', value: '\n', start: index })
  let cursor = index + 1
  for (let i = 0, { length } = state.heredocs; i < length; i += 1) {
    if (state.heredocs[i].body === undefined) {
      cursor = readHeredocBody(state, cursor, state.heredocs[i])
    }
  }
  return cursor
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
  if (char === '$' && command[index + 1] === "'") {
    return readAnsiCString(state, index)
  }
  if (char === '$' && command[index + 1] === '"') {
    startWord(state, index)
    state.quote = '"'
    return index + 2
  }
  if (char === "'" || char === '"') {
    startWord(state, index)
    state.quote = char
    return index + 1
  }
  if (char === escapeChar(state) && index + 1 < command.length) {
    return stepEscape(state, index)
  }
  return -1
}

function isBraceOperator(state, index) {
  const { command } = state
  const char = command[index]
  if (char !== '{' && char !== '}') {
    return false
  }
  if (state.windows) {
    return true
  }
  if (state.start !== -1) {
    return false
  }
  const next = command[index + 1]
  if (char === '{') {
    return next === undefined || WHITESPACE_CHARS.has(next) || next === '\n'
  }
  const previous = state.tokens.at(-1)
  return (
    (next === undefined || BRACE_END_CHARS.has(next)) &&
    previous?.type === 'operator' &&
    BRACE_AFTER_OPERATORS.has(previous.value)
  )
}

function stepStructure(state, index) {
  const { command } = state
  const redirect = REDIRECT_RE.exec(command.slice(index, index + 8))
  if (redirect && (state.start === -1 || !/^\d/.test(redirect[0]))) {
    return stepRedirect(state, index, redirect[0])
  }
  if (command[index] === '\n') {
    return stepNewline(state, index)
  }
  const operator = matchOperator(command, index)
  if (operator) {
    flushWord(state, index)
    state.tokens.push({ type: 'operator', value: operator, start: index })
    return index + operator.length
  }
  if (isBraceOperator(state, index)) {
    flushWord(state, index)
    state.tokens.push({ type: 'operator', value: command[index], start: index })
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
  const { length } = tokens
  for (let i = state.attachFrom; i < length - 1; i += 1) {
    const token = tokens[i]
    const target = tokens[i + 1]
    if (
      token.type === 'redirect' &&
      HEREDOC_RE.test(token.value) &&
      target.type === 'word'
    ) {
      token.heredoc = {
        delimiter: target.value,
        quoted: /['"\\]/.test(state.command.slice(target.start, target.end)),
        stripTabs: token.value.endsWith('-'),
        body: undefined,
      }
      state.heredocs.push(token.heredoc)
    }
  }
  state.attachFrom = Math.max(state.attachFrom, length - 1)
}

export function tokenizeShellCommand(command, options) {
  const state = createShellState(command, options)
  const { length } = command
  let index = 0
  while (index < length) {
    index = stepTokenizer(state, index)
  }
  flushWord(state, length)
  attachHeredocDelimiters(state)
  return {
    tokens: state.tokens,
    substitutions: state.substitutions,
  }
}

function newSegment(operator) {
  return { words: [], heredocs: [], start: -1, end: -1, after: operator }
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
  let segment = newSegment('')
  for (let i = 0, { length } = tokens; i < length; i += 1) {
    const token = tokens[i]
    if (token.type === 'operator') {
      if (segment.start !== -1) {
        segments.push(segment)
      }
      segment = newSegment(token.value)
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
