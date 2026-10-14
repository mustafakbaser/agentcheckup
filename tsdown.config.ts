import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli/main.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node22.12',
  // Every runtime dependency lives in devDependencies and is bundled, so the published
  // package has zero dependencies: `npx agentcheck` installs one tarball and nothing can
  // change underneath a user between releases.
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  publint: true,
  attw: { profile: 'esm-only' },
});
