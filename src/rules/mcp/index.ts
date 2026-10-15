import type { AnyRule } from '../../core/types.js';
import { envSyntaxMismatchRule } from './env-syntax-mismatch.js';
import { geminiServerNameRule } from './gemini-server-name.js';
import { geminiTrustRule } from './gemini-trust.js';
import { insecureTransportRule } from './insecure-transport.js';
import { literalSecretRule } from './literal-secret.js';
import { urlWithoutTypeRule } from './url-without-type.js';

export const mcpRules: readonly AnyRule[] = [
  envSyntaxMismatchRule,
  geminiServerNameRule,
  geminiTrustRule,
  insecureTransportRule,
  literalSecretRule,
  urlWithoutTypeRule,
];
