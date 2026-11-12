import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import { REPO_ROOT } from '../../../../scripts/repo/paths.mts'

export const SKILLS_DIR = path.join(REPO_ROOT, 'skills')

/**
 * Skill directories expected directly under skills/
 */
const EXPECTED_SKILLS = [
  'brew-publish',
  'cargo-publish',
  'github-release',
  'knowledge-update',
  'npm-publish',
  'socket-connect',
  'socket-dep-cleanup',
  'socket-dep-patch',
  'socket-dep-replace',
  'socket-dep-upgrade',
  'socket-firewall',
  'socket-fix',
  'socket-incident-response',
  'socket-inspect',
  'socket-policy',
  'socket-pr-alerts',
  'socket-reachability',
  'socket-release',
  'socket-sbom',
  'socket-scan',
  'socket-scan-setup',
  'socket-setup',
  'socket-vet-agent-tools',
]

export function getSkillDirs(): string[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(
      e =>
        e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'),
    )
    .map(e => e.name)
    .toSorted()
}

/**
 * Every skill directory path relative to skills/, which is its name.
 */
export function getAllSkillPaths(): string[] {
  return getSkillDirs()
}

describe('Skill Discovery', () => {
  it('skills directory exists', () => {
    expect(existsSync(SKILLS_DIR)).toBe(true)
  })

  it('holds exactly the expected skill directories', () => {
    expect(
      getSkillDirs(),
      'Update EXPECTED_SKILLS in this test if a skill was added or removed.',
    ).toStrictEqual(EXPECTED_SKILLS)
  })

  it('every skill directory contains a SKILL.md', () => {
    for (const skill of getSkillDirs()) {
      expect(
        existsSync(path.join(SKILLS_DIR, skill, 'SKILL.md')),
        `${skill}/SKILL.md does not exist`,
      ).toBe(true)
    }
  })
})
