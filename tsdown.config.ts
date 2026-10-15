import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli/main.ts',
  },
  format: 'esm',
  // package.json has "type": "module", so plain .js/.d.ts are ESM; keep the published paths stable.
  fixedExtension: false,
  platform: 'node',
  target: 'node22.12',
  // Every runtime dependency lives in devDependencies and is bundled, so the published
  // package has zero dependencies: `npx agentcheck` installs one tarball and nothing can
  // change underneath a user between releases.
  // jsonc-parser's default entry is a UMD build that loads its own modules with runtime
  // require() calls, which break once bundled. Its ESM build is statically analyzable.
  alias: { 'jsonc-parser': 'jsonc-parser/lib/esm/main.js' },
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Compress and drop whitespace, but keep identifier names: stack traces stay readable and the
  // published code stays auditable. Source maps ship alongside.
  minify: { compress: true, mangle: false },
  // publint and attw run in `pnpm check:package` against the real `npm pack` output.
  publint: false,
  attw: false,
});
