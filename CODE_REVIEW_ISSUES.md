# Code Review Issues

## 1. Outdated Mocks in `src/__tests__/agent.test.ts`

The test `should call generateText with correct model and tools` failed due to the mocks in `src/__tests__/agent.test.ts` not matching the real implementations of `buildSessionTools` and `buildWorkspaceTool`.

**Fix**:
I have updated the test to properly mock the dynamic imports and returned values from these tool builder functions, so that the tests pass.

## 2. Dynamic ai-sdk mocking

The `ai` module is imported as `import * as ai from 'ai'` in `src/agent.ts`, so we should mock it using dynamic loading with `importOriginal` instead of just mocking partial objects in order to have everything be properly tracked.

**Fix**:
I have updated the `vi.mock('ai', ...)` block in `src/__tests__/agent.test.ts` to use `importOriginal` and correctly mock `generateText`, `tool`, and `stepCountIs`.