#!/usr/bin/env node
/**
 * Generate Cursor plugin artifacts — .cursor-plugin/plugin.json,
 * .cursor-plugin/mcp.json, .cursor-plugin/hooks.json, and the bundled
 * install-check hook script — from .claude-plugin/plugin.json and
 * skills/_shared/hooks/.
 *
 * The mcp config declares Socket's hosted OAuth MCP server. No API key ships in
 * the plugin. The hook blocks package installs that do not run through Socket
 * Firewall; it ships as one self-contained file so it can also be copied into
 * project, user, and enterprise hooks directories.
 *
 * The plugin's mcp artifact lives under .cursor-plugin/, never at the repo
 * root, where it would overwrite a hand-maintained .mcp.json. This generator
 * must never write outside .cursor-plugin/.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { isMainModule, runMain } from './util/main.mts'
import type { ScriptMeta } from './util/main.mts'
import { parseFrontmatter } from './lib/frontmatter.mts'
import { repoClaudePluginPath } from './paths.mts'

const logger = getDefaultLogger()

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

// Manifest-relative reference to the plugin's own mcp config artifact.
const CURSOR_MCP_RELATIVE = '.cursor-plugin/mcp.json'

// Manifest-relative reference to the plugin's hooks config artifact.
export const CURSOR_HOOKS_RELATIVE = '.cursor-plugin/hooks.json'
export const CURSOR_HOOK_SCRIPT_RELATIVE =
  '.cursor-plugin/hooks/socket-install-gate.mjs'

export const SHELL_WORDS_SOURCE_RELATIVE =
  'skills/_shared/hooks/shell-words.mjs'
export const INSTALL_GATE_SOURCE_RELATIVE =
  'skills/_shared/hooks/install-gate.mjs'
export const CURSOR_HOOK_SOURCE_RELATIVE =
  'skills/_shared/hooks/cursor-before-shell-execution.mjs'

// Hand-maintained Cursor-only sources the manifest references.
export const CURSOR_LOGO_RELATIVE = '.cursor-plugin/logo.svg'
export const CURSOR_RULES_RELATIVE = '.cursor-plugin/rules'

export const CURSOR_DISPLAY_NAME = 'Socket'

// Same server name as the socket-connect marketplace entry, the Gemini
// extension, and the Codex plugin, so every agent shows one "socket" server.
export const SOCKET_MCP_SERVER_NAME = 'socket'

const PLUGIN_NAME_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/

export interface GenerateResult {
  hookScriptPath: string
  hooksPath: string
  manifestPath: string
  mcpPath: string
  outdated: string[]
}

export interface BuildCursorPluginManifestOptions {
  root?: string | undefined
}

export function buildCursorPluginManifest(
  options?: BuildCursorPluginManifestOptions | undefined,
): Record<string, unknown> {
  const { root = ROOT } = {
    __proto__: null,
    ...options,
  } as BuildCursorPluginManifestOptions
  const src = loadJson(repoClaudePluginPath(root))

  const name = src['name']
  if (typeof name !== 'string' || !name) {
    throw new Error(".claude-plugin/plugin.json must define a non-empty 'name'")
  }
  validatePluginName(name)

  const skills = collectSkillNames(path.join(root, 'skills'))
  if (skills.length === 0) {
    throw new Error('No skills discovered under skills/*/SKILL.md')
  }

  const sources = [CURSOR_LOGO_RELATIVE, CURSOR_RULES_RELATIVE]
  for (let i = 0, { length } = sources; i < length; i += 1) {
    const relative = sources[i]!
    if (!existsSync(path.join(root, relative))) {
      throw new Error(
        `Cursor plugin manifest references a missing file.\n` +
          `  Where: ${relative}\n` +
          `  Saw:   no file or directory at that path\n` +
          `  Fix:   restore ${relative}; the Cursor manifest points at it.`,
      )
    }
  }

  const manifest: Record<string, unknown> = {
    name,
    displayName: CURSOR_DISPLAY_NAME,
    skills: 'skills',
    rules: CURSOR_RULES_RELATIVE,
    mcpServers: CURSOR_MCP_RELATIVE,
    hooks: CURSOR_HOOKS_RELATIVE,
    logo: CURSOR_LOGO_RELATIVE,
  }

  const optionalKeys = [
    'description',
    'version',
    'author',
    'homepage',
    'repository',
    'license',
    'keywords',
  ]
  for (let i = 0, { length } = optionalKeys; i < length; i += 1) {
    const key = optionalKeys[i]!
    if (key in src) {
      manifest[key] = src[key]
    }
  }

  return manifest
}

/**
 * The hosted Socket MCP server. It signs users in with OAuth (dynamic client
 * registration + PKCE against api.socket.dev), so the plugin ships no API key
 * and users never paste one. Keep in sync with the socket-connect entry in
 * .claude-plugin/marketplace.json and with gemini-extension.json.
 */
export const SOCKET_MCP_URL = 'https://mcp.socket.dev/'

export function buildMcpConfig(): Record<string, unknown> {
  return {
    mcpServers: {
      [SOCKET_MCP_SERVER_NAME]: { url: SOCKET_MCP_URL },
    },
  }
}

export function buildHooksConfig(): Record<string, unknown> {
  return {
    version: 1,
    hooks: {
      beforeShellExecution: [
        {
          command: `node "\${CURSOR_PLUGIN_ROOT}/${CURSOR_HOOK_SCRIPT_RELATIVE}"`,
          timeout: 10,
        },
      ],
    },
  }
}

export const HOOK_SOURCES_RELATIVE = [
  SHELL_WORDS_SOURCE_RELATIVE,
  INSTALL_GATE_SOURCE_RELATIVE,
  CURSOR_HOOK_SOURCE_RELATIVE,
] as const

const IMPORT_LINE_RE = /^import ([^\n]+) from '([^']+)'\n/gm

const NAMED_IMPORT_RE = /^\{([^}]*)\}$/

const DEFAULT_IMPORT_RE = /^[A-Za-z_$][\w$]*$/

interface HookImports {
  defaults: Map<string, string>
  named: Map<string, Set<string>>
}

function unbundleableImport(relative: string, saw: string): Error {
  return new Error(
    `Cursor hook source has an import the bundler cannot inline.\n` +
      `  Where: ${relative}\n` +
      `  Saw:   ${saw}\n` +
      `  Fix:   use one single-line \`import name from\` or \`import { a, b } from\` per module.`,
  )
}

function collectHookImport(
  imports: HookImports,
  relative: string,
  clause: string,
  from: string,
): void {
  const trimmed = clause.trim()
  const match = NAMED_IMPORT_RE.exec(trimmed)
  if (match) {
    const names = imports.named.get(from) ?? new Set<string>()
    for (const name of match[1]!.split(',')) {
      if (name.trim()) {
        names.add(name.trim())
      }
    }
    imports.named.set(from, names)
    return
  }
  if (!DEFAULT_IMPORT_RE.test(trimmed)) {
    throw unbundleableImport(relative, `import ${trimmed} from '${from}'`)
  }
  imports.defaults.set(from, trimmed)
}

function renderHookImports(imports: HookImports): string[] {
  const modules = [
    ...new Set([...imports.defaults.keys(), ...imports.named.keys()]),
  ].toSorted()
  const lines: string[] = []
  for (let i = 0, { length } = modules; i < length; i += 1) {
    const from = modules[i]!
    const defaultName = imports.defaults.get(from)
    if (defaultName) {
      lines.push(`import ${defaultName} from '${from}'`)
    }
    const names = imports.named.get(from)
    if (names?.size) {
      lines.push(
        `import { ${[...names].toSorted().join(', ')} } from '${from}'`,
      )
    }
  }
  return lines
}

export function buildHookScript(root: string): string {
  const imports: HookImports = { defaults: new Map(), named: new Map() }
  const bodies: string[] = []
  for (let i = 0, { length } = HOOK_SOURCES_RELATIVE; i < length; i += 1) {
    const relative = HOOK_SOURCES_RELATIVE[i]!
    const source = readFileSync(path.join(root, relative), 'utf8')
    const body = source.replace(
      IMPORT_LINE_RE,
      (_line, clause: string, from: string) => {
        if (!from.startsWith('.')) {
          collectHookImport(imports, relative, clause, from)
        }
        return ''
      },
    )
    const leftover = /^import\b.*$/m.exec(body)
    if (leftover) {
      throw unbundleableImport(relative, leftover[0])
    }
    bodies.push(body.replace(/\n{3,}/g, '\n\n').trim())
  }
  const header =
    `// Generated by scripts/repo/generate-cursor-plugin.mts from\n` +
    HOOK_SOURCES_RELATIVE.map(relative => `// ${relative}\n`).join('') +
    `// Edit those files, then run pnpm run generate.\n`
  return `${header}\n${renderHookImports(imports).join('\n')}\n\n${bodies.join('\n\n')}\n`
}

export function collectSkillNames(dir: string): string[] {
  if (!existsSync(dir)) {
    return []
  }

  const names: string[] = []
  const entries = readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )
  for (let i = 0, { length } = entries; i < length; i += 1) {
    const entry = entries[i]!
    if (!entry.isDirectory() || entry.name.startsWith('_')) {
      continue
    }
    const skillMd = path.join(dir, entry.name, 'SKILL.md')
    if (!existsSync(skillMd)) {
      continue
    }

    const meta = parseFrontmatter(readFileSync(skillMd, 'utf-8'))
    const name = meta['name']?.trim()
    if (name) {
      names.push(name)
    }

    // Recurse into subdirectories to discover subskills
    names.push(...collectSkillNames(path.join(dir, entry.name)))
  }

  return names
}

export function generateCursorPlugin(
  root: string,
  config: { check: boolean },
): GenerateResult {
  const { check } = { __proto__: null, ...config } as typeof config

  const manifestPath = path.join(root, '.cursor-plugin', 'plugin.json')
  const mcpPath = path.join(root, CURSOR_MCP_RELATIVE)
  const hooksPath = path.join(root, CURSOR_HOOKS_RELATIVE)
  const hookScriptPath = path.join(root, CURSOR_HOOK_SCRIPT_RELATIVE)

  const outputs: Array<[string, string]> = [
    [manifestPath, renderJson(buildCursorPluginManifest({ root }))],
    [mcpPath, renderJson(buildMcpConfig())],
    [hooksPath, renderJson(buildHooksConfig())],
    [hookScriptPath, buildHookScript(root)],
  ]

  const outdated: string[] = []
  for (let i = 0, { length } = outputs; i < length; i += 1) {
    const [filePath, content] = outputs[i]!
    if (!writeOrCheck(filePath, content, { check })) {
      outdated.push(path.relative(root, filePath))
    }
  }

  return { hookScriptPath, hooksPath, manifestPath, mcpPath, outdated }
}

export function loadJson(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    throw new Error(`Missing required file: ${filePath}`)
  }
  return JSON.parse(readFileSync(filePath, 'utf-8'))
}

export function renderJson(data: Record<string, unknown>): string {
  return JSON.stringify(data, null, 2) + '\n'
}

export function validatePluginName(name: string): void {
  if (!PLUGIN_NAME_RE.test(name)) {
    throw new Error(
      `Invalid plugin name in .claude-plugin/plugin.json: '${name}'. ` +
        `Must be lowercase and match ${PLUGIN_NAME_RE.source}`,
    )
  }
}

export function writeOrCheck(
  filePath: string,
  content: string,
  config: { check: boolean },
): boolean {
  const { check } = { __proto__: null, ...config } as typeof config
  let current: string | undefined
  if (existsSync(filePath)) {
    current = readFileSync(filePath, 'utf-8')
  }

  if (current === content) {
    return true
  }

  if (check) {
    return false
  }

  const dir = path.dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(filePath, content, 'utf-8')
  return true
}

function main(): void {
  const checkMode = process.argv.includes('--check')

  const result = generateCursorPlugin(ROOT, { check: checkMode })

  if (checkMode) {
    if (result.outdated.length > 0) {
      logger.fail('Generated Cursor artifacts are out of date:')
      for (let i = 0, { length } = result.outdated; i < length; i += 1) {
        const item = result.outdated[i]
        logger.fail(`  - ${item}`)
      }
      logger.fail('Run: node scripts/repo/generate-cursor-plugin.mts')
      process.exit(1)
    }

    logger.log('Cursor plugin artifacts are up to date.')
    return
  }

  const written = [
    result.manifestPath,
    result.mcpPath,
    result.hooksPath,
    result.hookScriptPath,
  ]
  for (let i = 0, { length } = written; i < length; i += 1) {
    logger.log(`Wrote ${path.relative(ROOT, written[i]!)}`)
  }
}

const SCRIPT_META: ScriptMeta = {
  describe: 'generates Cursor plugin artifacts',
  help: 'Usage: node scripts/repo/generate-cursor-plugin.mts [--check]',
  json: 'result',
}

if (isMainModule(import.meta.url)) {
  runMain(() => main(), SCRIPT_META)
}
