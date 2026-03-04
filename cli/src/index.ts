#!/usr/bin/env node

/**
 * TiClaw CLI — tc
 *
 * Usage:
 *   tc bootstrap               First-time setup (interactive)
 *   tc start                    Start the TiClaw service
 *   tc stop                     Stop the TiClaw service
 *   tc status                   Show service state + detected CLIs
 *   tc skills list              List available skills
 *   tc skills add <name>        Apply a skill
 *   tc skills remove <name>     Uninstall a skill
 */

import { Command } from 'commander';
import { bootstrap } from './bootstrap.js';
import { registerSkillsCommand } from './skills.js';
import { start, stop, status } from './service.js';
import { registerEnvCommand } from './env.js';

const program = new Command();

program
  .name('tc')
  .description('TiClaw CLI — bootstrap, manage skills, and control the service')
  .version('1.0.0');

program
  .command('bootstrap')
  .description('First-time setup: detect CLIs, configure .env, apply initial skills, install service')
  .action(bootstrap);

program
  .command('start')
  .description('Start the TiClaw service')
  .action(start);

program
  .command('stop')
  .description('Stop the TiClaw service')
  .action(stop);

program
  .command('status')
  .description('Show service state, connected channels, and detected coding CLIs')
  .action(status);

registerSkillsCommand(program);
registerEnvCommand(program);

program.parse();
