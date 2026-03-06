import { tool } from 'ai';
import { z } from 'zod';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

import { TICLAW_HOME, ASSISTANT_NAME } from '../core/config.js';
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
    inputSchema: z.object({
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
          return `ERROR: Repository name must be in the format "owner/repo". Got: "${repoFullName}". Do NOT retry.`;
        }
        const [owner, repo] = parts;
        const folderName = `${owner}-${repo}`;
        const cloneDir = path.join(TICLAW_HOME, 'factory', folderName);

        if (operation === 'delete') {
          if (fs.existsSync(cloneDir)) {
            fs.rmSync(cloneDir, { recursive: true, force: true });
            return `Successfully deleted workspace for ${repoFullName}.`;
          } else {
            return `Workspace for ${repoFullName} does not exist on disk.`;
          }
        }

        if (operation === 'update') {
          if (fs.existsSync(cloneDir)) {
            execSync('git pull', { cwd: cloneDir, timeout: 60000 });
            return `Successfully updated workspace for ${repoFullName} (git pull complete).`;
          } else {
            return `ERROR: Workspace for ${repoFullName} does not exist. Set it up first.`;
          }
        }

        if (operation === 'setup') {
          if (!fs.existsSync(cloneDir)) {
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

            // Send a welcome message to the new channel
            await sendFn(
              newJid,
              `🦀 Workspace initialized for **${repoFullName}**\nI'm listening here — no need to @mention me.`,
            );

            const channelId = newJid.replace('dc:', '');
            return `Successfully set up workspace for ${repoFullName}. Created a dedicated Discord channel (ID: ${channelId}). Tell the user to check the new channel <#${channelId}>.`;
          } else {
            const group = registeredProjects[chatJid];
            if (group) {
              group.folder = folderName;
              group.name = repoFullName;
              registerProjectFn(chatJid, group);
            }
            return `Successfully set up workspace for ${repoFullName} in the current channel.`;
          }
        }

        return `ERROR: Unsupported operation: ${operation}`;
      } catch (err: unknown) {
        const rawMsg =
          err instanceof Error ? err.message : 'Unknown workspace error';
        logger.error({ err: rawMsg }, 'Workspace setup failed');

        // Extract the human-readable part from git errors
        let reason = rawMsg;
        if (rawMsg.includes('Repository not found')) {
          reason = `Repository "https://github.com/${repoFullName}" not found. It may not exist or may be private.`;
        } else if (rawMsg.includes('Could not resolve host')) {
          reason = 'Network error — could not reach GitHub.';
        } else if (rawMsg.includes('timeout')) {
          reason = 'Operation timed out. GitHub may be slow or unreachable.';
        }

        return `ERROR: ${reason} Do NOT retry.`;
      }
    },
  });
};
