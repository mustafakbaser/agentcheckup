/**
 * Runs the drift scripts on Node.js alone, without tsx or any other dependency: Node.js strips
 * the types itself (22.18 and later), and this hook resolves the `.js` specifiers the sources
 * import to the `.ts` files next to them. The issue sync in .github/workflows/source-drift.yml
 * runs this way, so the job that can write issues installs nothing.
 *
 *   node --import ./scripts/drift/ts-hooks.ts scripts/drift/sync-issues.ts <report.json>
 *
 * Only relative specifiers are rewritten, and only when the `.js` file does not exist.
 */
import { registerHooks } from 'node:module';

function isMissingModule(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND';
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    if (!relative || !specifier.endsWith('.js')) return nextResolve(specifier, context);
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!isMissingModule(error)) throw error;
      return nextResolve(`${specifier.slice(0, -'.js'.length)}.ts`, context);
    }
  },
});
