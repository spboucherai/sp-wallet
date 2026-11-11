import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: '.', timeout: 90_000, workers: 1, reporter: 'list', outputDir: '../../test-results',
  // SPW_E2E_BASE: the stack of scripts/dev-stack.sh when it does not run on its default port (SPW_DEV_PORT)
  use: { baseURL: process.env.SPW_E2E_BASE ?? 'http://localhost:8650', ...devices['Pixel 7'] },
});
