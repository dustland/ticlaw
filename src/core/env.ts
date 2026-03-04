import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'yaml';
import { logger } from './logger.js';

const TICLAW_CONFIG_PATH = path.join(
  process.env.HOME || os.homedir(),
  'ticlaw',
  'config.yaml',
);

/**
 * Config key mapping: YAML paths → env-style keys.
 * This flattens the YAML structure so readEnvFile() callers
 * don't need to change.
 */
const YAML_KEY_MAP: Record<string, string[]> = {
  TC_CODING_CLI: ['coding_cli'],
  ASSISTANT_NAME: ['assistant_name'],
  ASSISTANT_HAS_OWN_NUMBER: ['assistant_has_own_number'],
  HTTPS_PROXY: ['proxy'],
  HTTP_PROXY: ['proxy'],
  TC_DISCORD_TOKEN: ['channels', 'discord', 'token'],
  DISCORD_BOT_TOKEN: ['channels', 'discord', 'token'],
  TC_TELEGRAM_BOT_TOKEN: ['channels', 'telegram', 'token'],
  TC_SLACK_TOKEN: ['channels', 'slack', 'token'],
  GEMINI_API_KEY: ['api_keys', 'gemini'],
  ANTHROPIC_API_KEY: ['api_keys', 'anthropic'],
  CLAUDE_CODE_OAUTH_TOKEN: ['api_keys', 'claude_oauth'],
  TC_PREVIEW_URL_PATTERN: ['preview_url_pattern'],
  CONTAINER_IMAGE: ['container', 'image'],
  CONTAINER_TIMEOUT: ['container', 'timeout'],
  MAX_CONCURRENT_CONTAINERS: ['container', 'max_concurrent'],
  OPENROUTER_API_KEY: ['llm', 'api_key'],
  LLM_MODEL: ['llm', 'model'],
  LLM_BASE_URL: ['llm', 'base_url'],
};

/**
 * Read config values from ~/ticlaw/config.yaml.
 * Returns a flat key-value map using env-style keys.
 */
export function readConfigYaml(keys: string[]): Record<string, string> {
  let doc: any;
  try {
    const content = fs.readFileSync(TICLAW_CONFIG_PATH, 'utf-8');
    doc = yaml.parse(content);
  } catch {
    return {};
  }

  if (!doc || typeof doc !== 'object') return {};

  const result: Record<string, string> = {};
  for (const key of keys) {
    const yamlPath = YAML_KEY_MAP[key];
    if (!yamlPath) continue;

    let value: any = doc;
    for (const segment of yamlPath) {
      if (value == null || typeof value !== 'object') {
        value = undefined;
        break;
      }
      value = value[segment];
    }

    if (value != null && value !== '') {
      result[key] = String(value);
    }
  }

  return result;
}

/**
 * Read config values. Priority: process.env → config.yaml → .env (dev fallback).
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  // 1. Read from ~/ticlaw/config.yaml (production)
  const yamlConfig = readConfigYaml(keys);

  // 2. Read from .env (dev fallback)
  const envFile = path.join(process.cwd(), '.env');
  let dotenvConfig: Record<string, string> = {};
  try {
    const content = fs.readFileSync(envFile, 'utf-8');
    const wanted = new Set(keys);

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      if (!wanted.has(key)) continue;
      let value = trimmed.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (value) dotenvConfig[key] = value;
    }
  } catch {
    logger.debug('.env file not found, using config.yaml or defaults');
  }

  // YAML takes priority over .env
  return { ...dotenvConfig, ...yamlConfig };
}

/** Path to the YAML config file */
export { TICLAW_CONFIG_PATH };
