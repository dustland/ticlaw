#!/usr/bin/env node

/**
 * AquaClaw CLI — ac
 *
 * Usage:
 *   ac bootstrap               First-time setup (interactive)
 *   ac start                    Start the AquaClaw service
 *   ac stop                     Stop the AquaClaw service
 *   ac status                   Show service state + detected CLIs
 *   ac skills list              List available skills
 *   ac skills add <name>        Apply a skill
 *   ac skills remove <name>     Uninstall a skill
 */

import { Command } from 'commander';
import { bootstrap } from './bootstrap.js';
import { registerSkillsCommand } from './skills.js';
import { start, stop, status } from './service.js';
import { registerEnvCommand } from './env.js';

const program = new Command();

program
  .name('ac')
  .description('AquaClaw CLI — bootstrap, manage skills, and control the service')
  .version('1.0.0');

program
  .command('bootstrap')
  .description('First-time setup: detect CLIs, configure .env, apply initial skills, install service')
  .action(bootstrap);

program
  .command('start')
  .description('Start the AquaClaw service')
  .action(start);

program
  .command('stop')
  .description('Stop the AquaClaw service')
  .action(stop);

program
  .command('status')
  .description('Show service state, connected channels, and detected coding CLIs')
  .action(status);

registerSkillsCommand(program);
registerEnvCommand(program);

program.parse();
