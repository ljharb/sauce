/**
 * The one way to find skills. Every plugin target, the agents/README.md
 * generator, and the structural tests read skills through discoverSkills, so
 * they agree on which directories are skills, what each one is named, and
 * what its frontmatter says.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import * as path from 'node:path'

import {
  isNonStringScalar,
  parseSkillFrontmatter,
} from '../lib/frontmatter.mts'

export interface Skill {
  /**
   * The frontmatter name, which is also the directory name.
   */
  name: string
  description: string
  /**
   * Absolute path of the skill directory, skills/<name>.
   */
  dir: string
  /**
   * The Agent Skills `metadata` map.
   */
  metadata: Readonly<Record<string, string>>
  /**
   * The SKILL.md frontmatter keys, for target-specific checks.
   */
  frontmatter: ReadonlyMap<string, unknown>
}

/**
 * Metadata keys skills may declare. Targets read these instead of keeping
 * their own per-skill lists.
 */
export const SKILL_METADATA_KEYS = {
  /**
   * Where the skill appears in the README skills table.
   */
  category: 'category',
  /**
   * Comma-separated names of skills this skill needs installed with it.
   */
  requires: 'requires',
} as const

export const SKILL_NAME_RE = /^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$/
export const MAX_SKILL_NAME_LENGTH = 64
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024
export const MAX_SKILL_COMPATIBILITY_LENGTH = 500

/**
 * Claude Code always, and Hermes Agent when skills.inline_shell is on, run
 * an exclamation mark directly followed by a backtick-quoted command as a
 * shell command when a skill loads.
 */
export const INLINE_SHELL_RE = /!`[^`\n]+`/

/**
 * Markdown files in any skill that hold an inline shell snippet.
 */
export function findInlineShell(skills: readonly Skill[]): string[] {
  const offenders: string[] = []
  for (const skill of skills) {
    for (const { 0: rel, 1: file } of skillOwnFiles(skill)) {
      if (
        rel.endsWith('.md') &&
        INLINE_SHELL_RE.test(readFileSync(file, 'utf-8'))
      ) {
        offenders.push(`skills/${skill.name}/${rel}`)
      }
    }
  }
  return offenders
}

export function skillsDir(root: string): string {
  return path.join(root, 'skills')
}

export function isSkippedEntry(name: string): boolean {
  return name.startsWith('_') || name.startsWith('.')
}

export function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function sortedEntries(dir: string): Dirent[] {
  return readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
    compareCodePoints(a.name, b.name),
  )
}

export function symlinkError(where: string): Error {
  return new Error(
    `Skills must not contain symlinks; agents that copy a plugin do not follow them.\n` +
      `  Where: ${where}`,
  )
}

/**
 * Every skill, sorted by name. A skill is a directory directly under skills/
 * that holds a SKILL.md; some agents load skills only from that one level.
 * Directories whose names start with '_' or '.' are skipped. Throws on a
 * symlink, on a SKILL.md anywhere deeper, on a SKILL.md that breaks the
 * Agent Skills rules, and on a `requires` entry that names no skill.
 */
export function discoverSkills(root: string): Skill[] {
  const dir = skillsDir(root)
  const skills: Skill[] = []
  const problems: string[] = []
  if (existsSync(dir)) {
    for (const entry of sortedEntries(dir)) {
      if (isSkippedEntry(entry.name)) {
        continue
      }
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        throw symlinkError(full)
      }
      if (!entry.isDirectory()) {
        continue
      }
      if (existsSync(path.join(full, 'SKILL.md'))) {
        skills.push(readSkill(full))
      }
      for (const nested of findNestedSkillMds(full, entry.name)) {
        problems.push(
          `skills/${nested} is nested; move it to skills/<name>/SKILL.md`,
        )
      }
    }
  }
  const names = new Set(skills.map(skill => skill.name))
  for (const skill of skills) {
    for (const required of skillRequires(skill)) {
      if (!names.has(required)) {
        problems.push(
          `skills/${skill.name}/SKILL.md requires '${required}', which is not a skill`,
        )
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Invalid skills:\n${problems.map(p => `  - ${p}`).join('\n')}`,
    )
  }
  return skills.toSorted((a, b) => compareCodePoints(a.name, b.name))
}

export function skillRequires(skill: Skill): string[] {
  const value = skill.metadata[SKILL_METADATA_KEYS.requires]
  if (!value) {
    return []
  }
  return value
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
}

export function skillCategory(skill: Skill): string | undefined {
  return skill.metadata[SKILL_METADATA_KEYS.category]
}

/**
 * Check SKILL.md text against the Agent Skills rules the agents enforce.
 * Returns one message per problem.
 */
export function validateSkillMd(dirName: string, text: string): string[] {
  const parsed = parseSkillFrontmatter(text)
  if (!parsed.found) {
    return parsed.problems
  }
  if (!parsed.terminated) {
    return ['unterminated YAML frontmatter']
  }
  if (parsed.problems.length > 0) {
    return parsed.problems
  }
  const { fields } = parsed
  const problems: string[] = []
  const name = fields.get('name')
  if (
    typeof name !== 'string' ||
    name !== dirName ||
    name.length > MAX_SKILL_NAME_LENGTH ||
    !SKILL_NAME_RE.test(name)
  ) {
    problems.push(
      `name ${JSON.stringify(name ?? null)} must equal its directory name '${dirName}' and be a valid skill name`,
    )
  }
  problems.push(
    ...checkLength(
      'description',
      fields.get('description'),
      MAX_SKILL_DESCRIPTION_LENGTH,
    ),
  )
  for (const key of ['license', 'allowed-tools']) {
    if (fields.has(key) && typeof fields.get(key) !== 'string') {
      problems.push(`${key} must be a string`)
    }
  }
  if (fields.has('compatibility')) {
    problems.push(
      ...checkLength(
        'compatibility',
        fields.get('compatibility'),
        MAX_SKILL_COMPATIBILITY_LENGTH,
      ),
    )
  }
  return problems
}

function checkLength(key: string, value: unknown, max: number): string[] {
  if (typeof value === 'string' && value.length >= 1 && value.length <= max) {
    return []
  }
  return [`${key} must be a string of 1 to ${max} characters`]
}

function readSkill(dir: string): Skill {
  const name = path.basename(dir)
  const skillMd = path.join(dir, 'SKILL.md')
  const text = readFileSync(skillMd, 'utf-8')
  const problems = validateSkillMd(name, text)
  if (problems.length > 0) {
    throw new Error(
      `skills/${name}/SKILL.md breaks the Agent Skills rules:\n${problems.map(p => `  - ${p}`).join('\n')}`,
    )
  }
  const { fields, metadata = {} } = parseSkillFrontmatter(text)
  const description = fields.get('description')
  return {
    name,
    description: isNonStringScalar(description)
      ? description.nonString
      : String(description),
    dir,
    metadata,
    frontmatter: fields,
  }
}

/**
 * Every SKILL.md below a top-level directory of skills/, as paths relative
 * to skills/. Throws on a symlink.
 */
function findNestedSkillMds(dir: string, rel: string): string[] {
  const found: string[] = []
  for (const entry of sortedEntries(dir)) {
    if (isSkippedEntry(entry.name)) {
      continue
    }
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      throw symlinkError(full)
    }
    if (!entry.isDirectory()) {
      continue
    }
    const childRel = `${rel}/${entry.name}`
    if (existsSync(path.join(full, 'SKILL.md'))) {
      found.push(`${childRel}/SKILL.md`)
    }
    found.push(...findNestedSkillMds(full, childRel))
  }
  return found
}

/**
 * The files that belong to one skill: everything in its directory except
 * '_'/'.' entries, keyed by path relative to the skill directory
 * ('/'-separated).
 */
export function skillOwnFiles(skill: Skill): Map<string, string> {
  const files = new Map<string, string>()
  collectOwnFiles(skill.dir, '', files)
  return files
}

function collectOwnFiles(
  dir: string,
  prefix: string,
  out: Map<string, string>,
): void {
  for (const entry of sortedEntries(dir)) {
    if (isSkippedEntry(entry.name)) {
      continue
    }
    const full = path.join(dir, entry.name)
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) {
      throw symlinkError(full)
    }
    if (entry.isDirectory()) {
      collectOwnFiles(full, rel, out)
    } else if (entry.isFile()) {
      out.set(rel, full)
    }
  }
}
