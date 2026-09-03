import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{shared,bridge,agent,egress}/test/**/*.test.ts'],
    environment: 'node',
    // Several suites write to temporary directories and manipulate module-level
    // state; running files in separate processes keeps them from colliding.
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['{shared,bridge,agent,egress}/src/**/*.ts'],
      // The parts that decide whether something dangerous is permitted. These
      // are the functions a reviewer should expect to be exercised hard.
      thresholds: {
        'egress/src/allowlist.ts': { statements: 100, branches: 95, functions: 100, lines: 100 },
        'egress/src/addresses.ts': { statements: 100, branches: 90, functions: 100, lines: 100 },
      },
    },
  },
});
