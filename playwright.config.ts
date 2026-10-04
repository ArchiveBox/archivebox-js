import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import path from 'node:path';

export default defineConfig({
  testDir: './tests',
  outputDir: path.join(tmpdir(), 'archivebox-wacz-extension-test-results'),
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 120_000,
  expect: {
    timeout: 10_000,
  },
});
