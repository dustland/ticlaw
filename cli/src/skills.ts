/**
 * `tc skills` — Manage TiClaw skills.
 *
 * Subcommands:
 *   tc skills list              List available skills and their apply status
 *   tc skills add <name>        Apply a skill
 *   tc skills remove <name>     Uninstall a skill
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { Command } from 'commander';
import { PROJECT_ROOT } from './utils.js';
const SKILLS_DIR = path.join(PROJECT_ROOT, 'skills');
const STATE_PATH = path.join(PROJECT_ROOT, '.ticlaw', 'state.json');

interface SkillState {
  applied_skills?: Record<string, { applied_at: string; version: string }>;
}

function readState(): SkillState {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function listSkills(): void {
  if (!fs.existsSync(SKILLS_DIR)) {
    console.log('No skills directory found.');
    return;
  }

  const state = readState();
  const applied = state.applied_skills || {};

  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  const skills = entries.filter((e) => e.isDirectory());

  if (skills.length === 0) {
    console.log('No skills found.');
    return;
  }

  console.log('\n  Available Skills:\n');
  console.log('  Status  Name                  Description');
  console.log('  ──────  ────────────────────  ──────────────────────────────────');

  for (const skill of skills) {
    const isApplied = skill.name in applied;
    const status = isApplied ? '  ✅' : '  ──';

    // Try to read description from manifest.yaml or SKILL.md
    let description = '';
    const manifestPath = path.join(SKILLS_DIR, skill.name, 'manifest.yaml');
    const skillMdPath = path.join(SKILLS_DIR, skill.name, 'SKILL.md');

    if (fs.existsSync(manifestPath)) {
      const content = fs.readFileSync(manifestPath, 'utf-8');
      const match = content.match(/description:\s*"?([^"\n]+)"?/);
      if (match) description = match[1].trim();
    } else if (fs.existsSync(skillMdPath)) {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const match = content.match(/description:\s*(.+)/);
      if (match) description = match[1].trim();
    }

    const name = skill.name.padEnd(22);
    console.log(`${status}  ${name}${description.slice(0, 40)}`);
  }

  console.log('');
}

function addSkill(name: string): void {
  const skillDir = path.join(SKILLS_DIR, name);

  if (!fs.existsSync(skillDir)) {
    // Try with add- prefix
    const prefixed = path.join(SKILLS_DIR, `add-${name}`);
    if (fs.existsSync(prefixed)) {
      return addSkill(`add-${name}`);
    }
    console.error(`  ❌ Skill not found: ${name}`);
    console.error(`     Available: ${fs.readdirSync(SKILLS_DIR).join(', ')}`);
    process.exit(1);
  }

  console.log(`\n  📦 Applying skill: ${name}...\n`);
  try {
    execSync(`pnpm dlx tsx scripts/apply-skill.ts skills/${name}`, {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });
    console.log(`\n  ✅ Skill "${name}" applied successfully.`);
    console.log('  Run `pnpm run build` to rebuild, then `tc start` to restart.\n');
  } catch {
    console.error(`\n  ❌ Failed to apply skill "${name}".`);
    process.exit(1);
  }
}

function removeSkill(name: string): void {
  // Normalize name
  const fullName = name.startsWith('add-') ? name : `add-${name}`;

  console.log(`\n  🗑  Removing skill: ${fullName}...\n`);
  try {
    execSync(`pnpm dlx tsx scripts/uninstall-skill.ts ${fullName}`, {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });
    console.log(`\n  ✅ Skill "${fullName}" removed.`);
    console.log('  Run `pnpm run build` to rebuild, then `tc start` to restart.\n');
  } catch {
    console.error(`\n  ❌ Failed to remove skill "${fullName}".`);
    process.exit(1);
  }
}

export function registerSkillsCommand(program: Command): void {
  const skills = program
    .command('skills')
    .description('Manage TiClaw skills');

  skills
    .command('list')
    .description('List available skills and their apply status')
    .action(listSkills);

  skills
    .command('add <name>')
    .description('Apply a skill (e.g. discord, telegram, whatsapp)')
    .action(addSkill);

  skills
    .command('remove <name>')
    .description('Uninstall a skill')
    .action(removeSkill);
}
