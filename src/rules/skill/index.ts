import type { AnyRule } from '../../core/types.js';
import { bodyTooLongRule } from './body-too-long.js';
import { broadAllowedToolsRule } from './broad-allowed-tools.js';
import { brokenReferenceRule } from './broken-reference.js';
import { descriptionMissingRule } from './description-missing.js';
import { descriptionQualityRule } from './description-quality.js';
import { descriptionTooLongRule } from './description-too-long.js';
import { duplicateNameRule } from './duplicate-name.js';
import { fieldTypeRule } from './field-type.js';
import { frontmatterBomRule } from './frontmatter-bom.js';
import { frontmatterInvalidRule } from './frontmatter-invalid.js';
import { frontmatterMissingRule } from './frontmatter-missing.js';
import { nameDirMismatchRule } from './name-dir-mismatch.js';
import { nameFormatRule } from './name-format.js';
import { nameMissingRule } from './name-missing.js';
import { nameReservedWordRule } from './name-reserved-word.js';
import { nonPortableFieldRule } from './non-portable-field.js';
import { shellPreprocessingRule } from './shell-preprocessing.js';
import { yamlPortabilityRule } from './yaml-portability.js';

export const skillRules: readonly AnyRule[] = [
  bodyTooLongRule,
  broadAllowedToolsRule,
  brokenReferenceRule,
  descriptionMissingRule,
  descriptionQualityRule,
  descriptionTooLongRule,
  duplicateNameRule,
  fieldTypeRule,
  frontmatterBomRule,
  frontmatterInvalidRule,
  frontmatterMissingRule,
  nameDirMismatchRule,
  nameFormatRule,
  nameMissingRule,
  nameReservedWordRule,
  nonPortableFieldRule,
  shellPreprocessingRule,
  yamlPortabilityRule,
];
