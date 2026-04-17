# Code Review Issues

## 1. Command Injection Vulnerability in Workspace Tool (`src/tools/workspace.ts`)
**Severity**: High
**Description**: The `workspaceTool` uses `execSync` with template literal interpolation of the `repoFullName` parameter, which is user-provided:
```typescript
execSync(`git clone --branch main --single-branch https://github.com/${repoFullName}.git ${cloneDir}`, { timeout: 60000 });
```
Although it splits by `/` and checks for a length of 2, this does not prevent an attacker from supplying a malicious repository name like `owner/repo; rm -rf /`.
**Recommendation**:
- Validate repository names using the regex `/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9._-]+$/` and ensure they do not contain directory traversal sequences (`..`).
- Replace `execSync` with `execFileSync` or `spawnSync` using an argument array to completely eliminate command injection risks.

## 2. Command Injection Vulnerabilities in CLI (`cli/src/bootstrap.ts`, `cli/src/env.ts`)
**Severity**: High
**Description**: Similar to the workspace tool, `execSync` is used with unescaped or poorly validated user inputs. For instance, in `cli/src/env.ts`, `branch` and `repoFullName` are embedded into strings executed via `execSync`:
```typescript
execSync(`git clone --branch ${branch} --single-branch https://github.com/${repoFullName}.git ${workspaceDir}`, { stdio: 'inherit' });
```
**Recommendation**: Replace `execSync` with `execFileSync` where shell built-ins are not required. Ensure all user inputs like branch names are rigorously validated (e.g., rejecting `;`, `|`, `&`, `$`, backticks, and newlines).

## 3. Strict Type Safety Violations (`src/agent.ts`, `cli/src/*.ts`)
**Severity**: Medium
**Description**: The codebase uses the `any` type in numerous places, such as `catch (err: any)` in `src/agent.ts`, and parsing outputs in `cli/src/env.ts`, `cli/src/bootstrap.ts`, and `cli/src/utils.ts`.
**Recommendation**: Replace `any` with `unknown` and perform necessary type guards or assertions (`err instanceof Error`). For external data like API responses and parsed YAML, use structured validation like `zod` or explicit type casting after validation (`(val as Record<string, unknown>)`).

## 4. Unsafe Execution of Shell Commands in `cli/src/service.ts`
**Severity**: Medium
**Description**: `execSync` is used heavily in `cli/src/service.ts`. While many values are hardcoded, there is a risk when using string interpolation.
**Recommendation**: Use `execFileSync` across the CLI over `spawnSync` to automatically handle non-zero exit codes. For shell builtins like `command -v`, `execSync` is acceptable if arguments are fully trusted.