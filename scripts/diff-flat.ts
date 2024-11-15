/* This file is a part of @mdn/browser-compat-data
 * See LICENSE file for more information. */

import chalk from 'chalk-template';
import { diffArrays, diffWords } from 'diff';
import esMain from 'es-main';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { getMergeBase, getFileContent, getGitDiffStatuses } from './lib/git.js';

interface Contents {
  base: string;
  head: string;
}

/**
 * Get contents from base and head commits
 * Note: This does not detect renamed files
 * @param baseCommit Base commit
 * @param basePath Base path
 * @param headCommit Head commit
 * @param headPath Head path
 * @returns The contents of both commits
 */
const getBaseAndHeadContents = (
  baseCommit: string,
  basePath: string,
  headCommit: string,
  headPath: string,
): Contents => {
  const base = JSON.parse(getFileContent(baseCommit, basePath));
  const head = JSON.parse(getFileContent(headCommit, headPath));
  return { base, head };
};

/**
 * Flattens an object.
 * @param obj the object to flatten.
 * @param parentKey the parent key path.
 * @param result the intermediate result.
 * @returns the flattened object.
 */
const flattenObject = (
  obj: any,
  parentKey = '',
  result = {},
): Record<string, any> => {
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const fullKey = parentKey ? `${parentKey}.${key}` : key;

      if (typeof obj[key] === 'object' && obj[key] !== null) {
        // Recursively flatten nested objects
        flattenObject(obj[key], fullKey, result);
      } else {
        // Assign value to the flattened key
        result[fullKey] = obj[key];
      }
    }
  }

  return result;
};

/**
 * Print diffs
 * @param base Base ref
 * @param head Head ref
 * @param options Options
 */
const printDiffs = (
  base: string,
  head = '',
  options: { html: boolean },
): void => {
  for (const status of getGitDiffStatuses(base, head)) {
    if (!status.headPath.endsWith('.json') || !status.headPath.includes('/')) {
      continue;
    }

    // Note that A means Added for git while it means Array for deep-diff
    if (status.value === 'A') {
      // TODO
    } else if (status.value === 'D') {
      // TODO
    } else {
      const contents = getBaseAndHeadContents(
        base,
        status.basePath,
        head,
        status.headPath,
      );
      const baseData = flattenObject(contents.base);
      const headData = flattenObject(contents.head);

      const keys = [
        ...new Set<string>([
          ...Object.keys(baseData),
          ...Object.keys(headData),
        ]).values(),
      ].sort();

      if (!keys.length) {
        continue;
      }

      const prefix = diffArrays(
        keys.at(0)?.split('.') ?? [],
        keys.at(-1)?.split('.') ?? [],
      )[0]?.value.join('.');
      console.log(options.html ? `<h3>${prefix}</h3>` : `${prefix}`);

      let lastKey = keys.at(0) ?? '';

      for (const key of keys) {
        const baseValue = JSON.stringify(baseData[key] ?? null);
        const headValue = JSON.stringify(headData[key] ?? null);
        if (baseValue === headValue) {
          continue;
        }
        const keyDiff = diffArrays(
          lastKey.slice(prefix.length).split('.'),
          key.slice(prefix.length).split('.'),
        )
          .filter((part) => !part.removed)
          .map((part) => {
            const key = part.value.join('.');

            if (part.added) {
              return options.html
                ? `<strong>${key}</strong>`
                : chalk`{bold ${key}}`;
            }

            return key;
          })
          .join('.');

        console.log(
          options.html
            ? `${keyDiff} = <del>${baseValue}</del> → <ins>${headValue}</ins><br />`
            : chalk`${keyDiff} = {red ${baseValue}} → {green ${headValue}}`,
        );
        lastKey = key;
      }

      console.log('');
    }
  }
};

if (esMain(import.meta)) {
  const { argv } = yargs(hideBin(process.argv)).command(
    '$0 [base] [head]',
    'Print a formatted diff for changes between base and head commits',
    (yargs) => {
      yargs
        .positional('base', {
          describe:
            'The base commit; may be commit hash or other git ref (e.g. "origin/main")',
          type: 'string',
          default: 'origin/main',
        })
        .positional('head', {
          describe:
            'The head commit that changes are applied to; may be commit hash or other git ref (e.g. "origin/main")',
          type: 'string',
          default: 'HEAD',
        })
        .option('html', {
          type: 'boolean',
          default: false,
        });
    },
  );

  const { base, head, html } = argv as any;
  printDiffs(getMergeBase(base, head), head, { html });
}
