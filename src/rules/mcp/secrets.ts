/**
 * High-confidence credential detection by vendor token prefix. Every pattern is a fixed prefix
 * followed by a bounded run of one character class, checked with plain string scanning: linear
 * in the input, no regular expressions over untrusted text.
 *
 * Formats (checked 2026-10-14; sources in ./sources.ts):
 * - GitHub: ghp_/gho_/ghu_/ghs_/ghr_ + 36 base62 (40 in total); 2026 installation tokens
 *   ghs_ + JWT (~520 chars, two dots); github_pat_ + 82 [A-Za-z0-9_] (length from gitleaks).
 * - OpenAI: sk-, sk-proj-, sk-svcacct-, sk-admin- keys contain the marker `T3BlbkFJ`
 *   (base64 of "OpenAI"); marker and lengths from gitleaks.
 * - Anthropic: sk-ant-apiNN- and sk-ant-adminNN- (prefixes documented; length from gitleaks).
 * - Slack: xoxb-, xoxp-, xoxa-, xoxr-, xoxs-, xoxe-, xoxe.xoxb-, xoxe.xoxp-, xapp-.
 * - AWS access key IDs: AKIA / ASIA + 16 base32 characters.
 * - GitLab: glpat- + 20 characters, or the routable format ending in `.vv.` + 9 base36.
 * - Stripe live secret and restricted keys: sk_live_, rk_live_.
 * - Google API keys: AIza + 35 characters. npm: npm_ + 36 base62. Hugging Face: hf_ + 34
 *   letters. PyPI: pypi-AgEIcHlwaS5vcmc… DigitalOcean: dop_v1_/doo_v1_/dor_v1_ + 64 hex.
 *   Shopify: shpat_/shppa_/shpca_/shpss_ + 32 hex. Doppler: dp.pt./dp.st./… + 40–44.
 */

export interface SecretMatch {
  readonly vendor: string;
  /** Environment variable name to suggest in the fix. */
  readonly variable: string;
  readonly start: number;
  readonly length: number;
  /**
   * The token identifies a credential but does not grant access on its own (an AWS access key ID
   * needs its secret access key).
   */
  readonly identifier: boolean;
}

type CharTest = (code: number) => boolean;

const isDigit: CharTest = (c) => c >= 0x30 && c <= 0x39;
const isUpper: CharTest = (c) => c >= 0x41 && c <= 0x5a;
const isLower: CharTest = (c) => c >= 0x61 && c <= 0x7a;
const isLetter: CharTest = (c) => isUpper(c) || isLower(c);
const isAlnum: CharTest = (c) => isLetter(c) || isDigit(c);
const isWord: CharTest = (c) => isAlnum(c) || c === 0x5f;
const isUrlSafe: CharTest = (c) => isWord(c) || c === 0x2d;
const isUrlSafeDot: CharTest = (c) => isUrlSafe(c) || c === 0x2e;
const isSlack: CharTest = (c) => isAlnum(c) || c === 0x2d;
const isBase32: CharTest = (c) => isUpper(c) || (c >= 0x32 && c <= 0x37);
const isLowerHex: CharTest = (c) => isDigit(c) || (c >= 0x61 && c <= 0x66);
const isHex: CharTest = (c) => isLowerHex(c) || (c >= 0x41 && c <= 0x46);

interface Pattern {
  readonly vendor: string;
  readonly variable: string;
  readonly prefixes: readonly string[];
  readonly body: CharTest;
  readonly min: number;
  readonly max: number;
  readonly check?: (body: string) => boolean;
  /** See {@link SecretMatch.identifier}. */
  readonly identifier?: boolean;
}

function digitsThenDash(body: string): boolean {
  return isDigit(body.charCodeAt(0)) && isDigit(body.charCodeAt(1)) && body.charAt(2) === '-';
}

function countOf(text: string, char: string): number {
  let count = 0;
  for (let i = text.indexOf(char); i !== -1; i = text.indexOf(char, i + 1)) count++;
  return count;
}

/** `….vv.` + 9 lower-case base36 characters at the end of a routable GitLab token. */
function gitlabRoutable(body: string): boolean {
  const n = body.length;
  if (n < 40 || body.charAt(n - 10) !== '.' || body.charAt(n - 13) !== '.') return false;
  for (let i = n - 12; i < n; i++) {
    if (i === n - 10) continue;
    const c = body.charCodeAt(i);
    if (!isDigit(c) && !isLower(c)) return false;
  }
  return true;
}

function slackShape(body: string): boolean {
  const last = body.slice(body.lastIndexOf('-') + 1);
  return body.includes('-') && last.length >= 10 && /\d/.test(body);
}

export const SECRET_PATTERNS: readonly Pattern[] = [
  {
    vendor: 'GitHub personal access token',
    variable: 'GITHUB_TOKEN',
    prefixes: ['ghp_'],
    body: isAlnum,
    min: 36,
    max: 36,
  },
  {
    vendor: 'GitHub OAuth token',
    variable: 'GITHUB_TOKEN',
    prefixes: ['gho_'],
    body: isAlnum,
    min: 36,
    max: 36,
  },
  {
    vendor: 'GitHub user-to-server token',
    variable: 'GITHUB_TOKEN',
    prefixes: ['ghu_'],
    body: isAlnum,
    min: 36,
    max: 36,
  },
  {
    vendor: 'GitHub App installation token',
    variable: 'GITHUB_TOKEN',
    prefixes: ['ghs_'],
    body: isAlnum,
    min: 36,
    max: 36,
  },
  {
    vendor: 'GitHub App installation token',
    variable: 'GITHUB_TOKEN',
    prefixes: ['ghs_'],
    body: isUrlSafeDot,
    min: 100,
    max: 2048,
    check: (body) => countOf(body, '.') >= 2,
  },
  {
    vendor: 'GitHub refresh token',
    variable: 'GITHUB_TOKEN',
    prefixes: ['ghr_'],
    body: isAlnum,
    min: 36,
    max: 36,
  },
  {
    vendor: 'GitHub fine-grained personal access token',
    variable: 'GITHUB_TOKEN',
    prefixes: ['github_pat_'],
    body: isWord,
    min: 70,
    max: 255,
  },
  {
    vendor: 'OpenAI API key',
    variable: 'OPENAI_API_KEY',
    prefixes: ['sk-proj-', 'sk-svcacct-', 'sk-admin-', 'sk-'],
    body: isUrlSafe,
    min: 40,
    max: 400,
    check: (body) => body.includes('T3BlbkFJ'),
  },
  {
    vendor: 'Anthropic API key',
    variable: 'ANTHROPIC_API_KEY',
    prefixes: ['sk-ant-api'],
    body: isUrlSafe,
    min: 83,
    max: 300,
    check: digitsThenDash,
  },
  {
    vendor: 'Anthropic Admin API key',
    variable: 'ANTHROPIC_ADMIN_KEY',
    prefixes: ['sk-ant-admin'],
    body: isUrlSafe,
    min: 83,
    max: 300,
    check: digitsThenDash,
  },
  {
    vendor: 'Slack token',
    variable: 'SLACK_TOKEN',
    prefixes: [
      'xoxe.xoxb-',
      'xoxe.xoxp-',
      'xoxb-',
      'xoxp-',
      'xoxa-',
      'xoxr-',
      'xoxs-',
      'xoxe-',
      'xapp-',
    ],
    body: isSlack,
    min: 20,
    max: 255,
    check: slackShape,
  },
  {
    vendor: 'AWS access key ID',
    variable: 'AWS_ACCESS_KEY_ID',
    identifier: true,
    prefixes: ['AKIA', 'ASIA'],
    body: isBase32,
    min: 16,
    max: 16,
  },
  {
    vendor: 'GitLab personal access token',
    variable: 'GITLAB_TOKEN',
    prefixes: ['glpat-'],
    body: isUrlSafe,
    min: 20,
    max: 20,
  },
  {
    vendor: 'GitLab personal access token',
    variable: 'GITLAB_TOKEN',
    prefixes: ['glpat-'],
    body: isUrlSafeDot,
    min: 40,
    max: 330,
    check: gitlabRoutable,
  },
  {
    vendor: 'Stripe live API key',
    variable: 'STRIPE_API_KEY',
    prefixes: ['sk_live_', 'rk_live_'],
    body: isAlnum,
    min: 20,
    max: 255,
  },
  {
    vendor: 'Google API key',
    variable: 'GOOGLE_API_KEY',
    prefixes: ['AIza'],
    body: isUrlSafe,
    min: 35,
    max: 35,
    // The example key in Google's documentation.
    check: (body) => body !== 'SyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe',
  },
  {
    vendor: 'npm access token',
    variable: 'NPM_TOKEN',
    prefixes: ['npm_'],
    body: isAlnum,
    min: 36,
    max: 36,
  },
  {
    vendor: 'Hugging Face access token',
    variable: 'HF_TOKEN',
    prefixes: ['hf_'],
    body: isLetter,
    min: 34,
    max: 34,
  },
  {
    vendor: 'PyPI API token',
    variable: 'PYPI_TOKEN',
    prefixes: ['pypi-AgEIcHlwaS5vcmc'],
    body: isUrlSafe,
    min: 50,
    max: 2048,
  },
  {
    vendor: 'DigitalOcean token',
    variable: 'DIGITALOCEAN_TOKEN',
    prefixes: ['dop_v1_', 'doo_v1_', 'dor_v1_'],
    body: isLowerHex,
    min: 64,
    max: 64,
  },
  {
    vendor: 'Shopify access token',
    variable: 'SHOPIFY_ACCESS_TOKEN',
    prefixes: ['shpat_', 'shppa_', 'shpca_', 'shpss_'],
    body: isHex,
    min: 32,
    max: 32,
  },
  {
    vendor: 'Doppler token',
    variable: 'DOPPLER_TOKEN',
    prefixes: ['dp.pt.', 'dp.st.', 'dp.ct.', 'dp.sa.', 'dp.scim.', 'dp.audit.'],
    body: isAlnum,
    min: 40,
    max: 44,
  },
];

const PLACEHOLDER_WORDS = [
  'example',
  'placeholder',
  'your',
  'redacted',
  'dummy',
  'sample',
  'changeme',
  'insert',
  'xxxx',
];

/** Documentation placeholders: runs of one character, placeholder words, very few distinct characters. */
export function looksLikePlaceholder(body: string): boolean {
  const lower = body.toLowerCase();
  if (PLACEHOLDER_WORDS.some((word) => lower.includes(word))) return true;
  let run = 1;
  const distinct = new Set<string>();
  for (let i = 0; i < body.length; i++) {
    distinct.add(body.charAt(i));
    run = i > 0 && body.charAt(i) === body.charAt(i - 1) ? run + 1 : 1;
    if (run >= 6) return true;
  }
  return body.length >= 16 && distinct.size < 8;
}

function matchAt(text: string, start: number, prefix: string, pattern: Pattern): number {
  if (start > 0 && isAlnum(text.charCodeAt(start - 1))) return -1;
  const bodyStart = start + prefix.length;
  let end = bodyStart;
  while (end < text.length && end - bodyStart <= pattern.max && pattern.body(text.charCodeAt(end)))
    end++;
  const length = end - bodyStart;
  if (length < pattern.min || length > pattern.max) return -1;
  const body = text.slice(bodyStart, end);
  if (pattern.check !== undefined && !pattern.check(body)) return -1;
  if (looksLikePlaceholder(body)) return -1;
  return end;
}

/** Scans per pattern and prefix; occurrences examined per prefix are capped. */
const OCCURRENCE_LIMIT = 256;

/** The first credential in `text`, by position. */
export function findSecret(text: string): SecretMatch | undefined {
  // The earliest credential wins; an identifier only when the text holds no credential.
  let credential: SecretMatch | undefined;
  let identifier: SecretMatch | undefined;
  for (const pattern of SECRET_PATTERNS) {
    const isIdentifier = pattern.identifier === true;
    for (const prefix of pattern.prefixes) {
      let seen = 0;
      for (let at = text.indexOf(prefix); at !== -1; at = text.indexOf(prefix, at + 1)) {
        const best = isIdentifier ? identifier : credential;
        if (best !== undefined && at >= best.start) break;
        if (++seen > OCCURRENCE_LIMIT) break;
        const end = matchAt(text, at, prefix, pattern);
        if (end === -1) continue;
        const match = {
          vendor: pattern.vendor,
          variable: pattern.variable,
          start: at,
          length: end - at,
          identifier: isIdentifier,
        };
        if (isIdentifier) identifier = match;
        else credential = match;
        break;
      }
    }
  }
  return credential ?? identifier;
}
