import { tool } from 'ai';
import { z } from 'zod';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

import { AQUACLAW_HOME, ASSISTANT_NAME } from '../core/config.js';
import { logger } from '../core/logger.js';
import { RegisteredProject } from '../core/types.js';

export const buildWorkspaceTool = (
  chatJid: string,
  sendFn: (jid: string, text: string) => Promise<void>,
  createChannelFn: (fromJid: string, name: string) => Promise<string | null>,
  registerProjectFn: (jid: string, group: RegisteredProject) => void,
  isChannelAliveFn: (jid: string) => Promise<boolean>,
  registeredProjects: Record<string, RegisteredProject>,
) => {
  return tool({
    description: `Manage workspaces for GitHub repositories. You can setup (clone), update (git pull), or delete a workspace.`,
    parameters: z.object({
      operation: z
        .enum(['setup', 'update', 'delete'])
        .describe('The operation to perform on the workspace.'),
      repoFullName: z
        .string()
        .describe(
          'The full name of the GitHub repository (e.g., "owner/repo").',
        ),
    }),
    execute: async ({ operation, repoFullName }) => {
      logger.info(
        { chatJid, repoFullName, operation },
        'Executing workspace tool',
      );

      try {
        const parts = repoFullName.split('/');
        if (parts.length !== 2) {
          throw new Error('Repository name must be in the format owner/repo');
        }
        const [owner, repo] = parts;
        const folderName = `${owner}-${repo}`;
        const cloneDir = path.join(AQUACLAW_HOME, 'factory', folderName);

        if (operation === 'delete') {
          if (fs.existsSync(cloneDir)) {
            fs.rmSync(cloneDir, { recursive: true, force: true });
            await sendFn(
              chatJid,
              `🗑️ Workspace **${repoFullName}** has been deleted from disk.`,
            );
            return `Successfully deleted workspace for ${repoFullName}.`;
          } else {
            return `Workspace for ${repoFullName} does not exist.`;
          }
        }

        if (operation === 'update') {
          if (fs.existsSync(cloneDir)) {
            await sendFn(
              chatJid,
              `🔄 Updating workspace for **${repoFullName}**...`,
            );
            execSync('git pull', { cwd: cloneDir, timeout: 60000 });
            await sendFn(
              chatJid,
              `✅ Workspace **${repoFullName}** is now up to date.`,
            );
            return `Successfully updated workspace for ${repoFullName}.`;
          } else {
            return `Workspace for ${repoFullName} does not exist. You must set it up first.`;
          }
        }

        if (operation === 'setup') {
          if (!fs.existsSync(cloneDir)) {
            await sendFn(
              chatJid,
              `🦀 Setting up workspace for **${repoFullName}**...`,
            );
            fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
            execSync(
              `git clone --branch main --single-branch https://github.com/${repoFullName}.git ${cloneDir}`,
              { timeout: 60000 },
            );
          }

          const existingEntry = Object.entries(registeredProjects).find(
            ([, g]) => g.folder === folderName,
          );
          let newJid: string | null = null;
          if (existingEntry && (await isChannelAliveFn(existingEntry[0]))) {
            newJid = existingEntry[0];
          } else {
            if (existingEntry) {
              logger.info(
                { staleJid: existingEntry[0] },
                'Recreating channel for existing workspace',
              );
            }
            newJid = await createChannelFn(chatJid, repo);
          }

          if (newJid) {
            const newGroup: RegisteredProject = {
              name: repoFullName,
              folder: folderName,
              trigger: `@${ASSISTANT_NAME}`,
              added_at: new Date().toISOString(),
              requiresTrigger: false,
              isMain: false,
            };
            registerProjectFn(newJid, newGroup);

            await sendFn(
              chatJid,
              `✅ Workspace ready! Created <#${newJid.replace('dc:', '')}> for **${repoFullName}**`,
            );
            await sendFn(
              newJid,
              `🦀 Workspace initialized for **${repoFullName}**\nI'm listening here — no need to @mention me.`,
            );
          } else {
            const group = registeredProjects[chatJid];
            if (group) {
              group.folder = folderName;
              group.name = repoFullName;
              registerProjectFn(chatJid, group);
            }
            await sendFn(chatJid, `✅ Workspace ready: \`${repoFullName}\``);
          }
          return `Successfully set up the workspace for ${repoFullName}.`;
        }

        return `Unsupported operation: ${operation}`;
      } catch (err: any) {
        logger.error({ err: err.message }, 'Workspace setup failed');
        await sendFn(
          chatJid,
          `⚠️ Workspace operation failed for ${repoFullName}: ${err.message}`,
        );
      }
    },
  } as any);
};
