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
          failClosed: true,
          timeout: 10,
        },
      ],
    },
  }
}

const IMPORT_LINE_RE = /^import ([^\n]+) from '([^']+)'\n/gm

const NAMED_IMPORT_RE = /^\{([^}]*)\}$/

export function buildHookScript(root: string): string {
  const core = readFileSync(
    path.join(root, INSTALL_GATE_SOURCE_RELATIVE),
    'utf8',
  )
  const adapter = readFileSync(
    path.join(root, CURSOR_HOOK_SOURCE_RELATIVE),
    'utf8',
  )
  const defaults = new Map<string, string>()
  const named = new Map<string, Set<string>>()
  const bodies = [core, adapter].map(source =>
    source.replace(IMPORT_LINE_RE, (_line, clause: string, from: string) => {
      if (from.startsWith('.')) {
        return ''
      }
      const match = NAMED_IMPORT_RE.exec(clause.trim())
      if (match) {
        const names = named.get(from) ?? new Set<string>()
        for (const name of match[1]!.split(',')) {
          if (name.trim()) {
            names.add(name.trim())
          }
        }
        named.set(from, names)
      } else {
        defaults.set(from, clause.trim())
      }
      return ''
    }),
  )
  const modules = [...new Set([...defaults.keys(), ...named.keys()])].toSorted()
  const imports: string[] = []
  for (let i = 0, { length } = modules; i < length; i += 1) {
    const from = modules[i]!
    const defaultName = defaults.get(from)
    if (defaultName) {
      imports.push(`import ${defaultName} from '${from}'`)
    }
    const names = named.get(from)
    if (names?.size) {
      imports.push(
        `import { ${[...names].toSorted().join(', ')} } from '${from}'`,
      )
    }
  }
  const header =
    `// Generated by scripts/repo/generate-cursor-plugin.mts from\n` +
    `// ${INSTALL_GATE_SOURCE_RELATIVE} and\n` +
    `// ${CURSOR_HOOK_SOURCE_RELATIVE}.\n` +
    `// Edit those files, then run pnpm run generate.\n`
  const body = bodies.map(text => text.replace(/\n{3,}/g, '\n\n').trim())
  return `${header}\n${imports.join('\n')}\n\n${body.join('\n\n')}\n`
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
