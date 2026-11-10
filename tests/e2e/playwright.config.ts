import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: '.', timeout: 90_000, workers: 1, reporter: 'list', outputDir: '../../test-results',
  use: { baseURL: 'http://localhost:8650', ...devices['Pixel 7'] },
});
