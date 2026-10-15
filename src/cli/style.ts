import type { Style } from '../report/stylish.js';

/**
 * Minimal ANSI styling. Avoids a color dependency and gives the CLI exact control over when
 * color is used (see `shouldUseColor`).
 */
const wrap =
  (open: number, close: number) =>
  (text: string): string =>
    `\u001b[${open}m${text}\u001b[${close}m`;

export const ansiStyle: Style = {
  red: wrap(31, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  green: wrap(32, 39),
  gray: wrap(90, 39),
  dim: wrap(2, 22),
  bold: wrap(1, 22),
  underline: wrap(4, 24),
};

export interface ColorEnvironment {
  readonly flag: boolean | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isTTY: boolean;
}

/**
 * Precedence: explicit flag, then FORCE_COLOR, then NO_COLOR (https://no-color.org), then
 * TERM=dumb, then whether stdout is a terminal.
 */
export function shouldUseColor({ flag, env, isTTY }: ColorEnvironment): boolean {
  if (flag !== undefined) return flag;
  const force = env['FORCE_COLOR'];
  if (force !== undefined && force !== '') return force !== '0' && force !== 'false';
  const noColor = env['NO_COLOR'];
  if (noColor !== undefined && noColor !== '') return false;
  if (env['TERM'] === 'dumb') return false;
  return isTTY;
}
