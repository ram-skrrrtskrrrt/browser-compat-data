/* This file is a part of @mdn/browser-compat-data
 * See LICENSE file for more information. */

import chalk from 'chalk-template';
import { diffArrays } from 'diff';
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

const BROWSER_NAMES = [
  'chrome',
  'chrome_android',
  'edge',
  'firefox',
  'firefox_android',
  'safari',
  'safari_ios',
  'webview_android',
];

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

      if (key == 'flags') {
        result[fullKey] = toArray(obj[key]).map((value) =>
          JSON.stringify(value),
        );
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        // Recursively flatten nested objects
        flattenObject(
          BROWSER_NAMES.includes(key)
            ? toArray(obj[key]).reverse()
            : key === 'notes'
              ? toArray(obj[key])
              : obj[key],
          fullKey,
          result,
        );
      } else {
        // Assign value to the flattened key
        result[fullKey] = obj[key];
      }
    }
  }

  return result;
};

/**
 * Converts value to array unless it isn't.
 * @param value array or any value.
 * @returns the array, or an array with the value as a single item.
 */
const toArray = (value: any): any[] => {
  if (!Array.isArray(value)) {
    value = [value];
  }

  return value;
};

/**
 * Formats a key diff'ed with the previous key.
 * @param key the current key
 * @param lastKey the previous key
 * @param options Options
 * @param options.fill The number of characters to fill up to
 * @param options.html Whether to return HTML, otherwise plaintext
 * @returns diffed key
 */
const diffKeys = (
  key: string,
  lastKey: string,
  options: { fill?: number; html: boolean },
): string => {
  const len = key.length;
  let fill = options.fill ?? 0;
  return diffArrays(lastKey.split('.'), key.split('.'))
    .filter((part) => !part.removed)
    .map((part) => {
      const key = part.value.join('.');

      if (part.added) {
        const space = fill && len < fill ? ' '.repeat(fill - len) : '';
        fill = 0;
        return (
          (options.html ? `<strong>${key}</strong>` : chalk`{blue ${key}}`) +
          space
        );
      }

      return key;
    })
    .join('.');
};

/**
 * Print diffs
 * @param base Base ref
 * @param head Head ref
 * @param options Options
 * @param options.group Whether to group by value, rather than the common feature
 * @param options.html Whether to output HTML, rather than plain-text
 */
const printDiffs = (
  base: string,
  head = '',
  options: { group: boolean; html: boolean },
): void => {
  if (options.html) {
    console.log('<div style="font-family: monospace">');
  }

  const groups = new Map<string, Set<string>>();

  for (const status of getGitDiffStatuses(base, head)) {
    if (!status.headPath.endsWith('.json') || !status.headPath.includes('/')) {
      continue;
    }

    // Note that A means Added for git while it means Array for deep-diff
    if (status.value === 'A') {
      console.warn("diff:flat doesn't support file additions yet!");
    } else if (status.value === 'D') {
      console.warn("diff:flat doesn't support file deletions yet!");
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

      const commonName = options.html ? `<h3>${prefix}</h3>` : `${prefix}`;

      let lastKey = keys.at(0) ?? '';

      for (const key of keys) {
        const baseValue = JSON.stringify(baseData[key] ?? null);
        const headValue = JSON.stringify(headData[key] ?? null);
        if (baseValue === headValue) {
          continue;
        }
        const keyDiff = diffKeys(
          lastKey.slice(prefix.length),
          key.slice(prefix.length),
          options,
        );

        /**
         * Checks whether the value is a relevant value.
         * @param value the value.
         * @returns TRUE if the value is relevant, FALSE otherwise.
         */
        const hasValue = (value: any) =>
          typeof value === 'boolean' || (!!value && value !== 'mirror');

        const oldValue =
          hasValue(baseData[key] ?? null) &&
          (options.html
            ? `<del style="color: red">${baseValue}</del>`
            : chalk`{red ${baseValue}}`);
        const newValue =
          (hasValue(headData[key] ?? null) &&
            (options.html
              ? `<ins style="color: green">${headValue}</ins>`
              : chalk`{green ${headValue}}`)) ||
          '';

        const value = [oldValue, newValue].filter(Boolean).join(' → ');

        if (!value.length) {
          // e.g. null => "mirror"
          continue;
        }

        if (options.group) {
          const reverseKeyParts = key.split('.').reverse();
          const browser = reverseKeyParts.find((part) =>
            BROWSER_NAMES.includes(part),
          );
          const field = reverseKeyParts.find((part) => !/^\d+$/.test(part));
          const groupKey = `${!browser ? '' : options.html ? `<strong>${browser}<strong> → ` : chalk`{cyan ${browser}} → `}${field} = ${value}`;
          const groupValue = key
            .split('.')
            .map((part) =>
              part !== browser && part !== field
                ? part
                : options.html
                  ? '<small>{}</small>'
                  : chalk`{dim \{\}}`,
            )
            .join('.');
          const group = groups.get(groupKey) ?? new Set();
          group.add(groupValue);
          groups.set(groupKey, group);
        } else {
          const change = options.html
            ? `${keyDiff} = ${value}<br />`
            : chalk`${keyDiff} = ${value}`;
          const group = groups.get(commonName) ?? new Set();
          group.add(change);
          groups.set(commonName, group);
        }
        lastKey = key;
      }
    }
  }

  const entries: [string, string[]][] = [...groups.entries()].map(
    ([key, set]) => [key, [...set.values()]],
  );

  if (options.group) {
    entries.sort(([, a], [, b]) => b.length - a.length);
    /**
     * Reverses a key (e.g. "a.b.c" => "c.b.a").
     * @param key the key to reverse.
     * @returns the reversed key.
     */
    const reverseKey = (key: string): string =>
      key.split('.').reverse().join('.');
    entries.forEach((entry) => {
      entry[1] = entry[1].map(reverseKey).sort().map(reverseKey);
    });
  }

  let previousKey: string | null = null;
  for (const entry of entries) {
    if (options.group) {
      const [value, keys] = entry;
      if (keys.length == 1) {
        const key = keys.at(0) as string;
        const keyDiff = diffKeys(key, previousKey ?? key, options);
        console.log(`${keyDiff}:\n  ${value}`);
        previousKey = key;
      } else {
        previousKey = null;
        const maxKeyLength = Math.max(...keys.map((key) => key.length));
        for (const key of keys) {
          const keyDiff = diffKeys(key, previousKey ?? (keys.at(1) as string), {
            ...options,
            fill: maxKeyLength,
          });
          console.log(keyDiff);
          previousKey = key;
        }
        console.log(`  ${value}`);
        previousKey = null;
      }
    } else {
      const [key, values] = entry;
      if (values.length == 1) {
        const keyDiff = diffKeys(key, previousKey ?? key, options);
        console.log(`${keyDiff}:\n  ${values.at(0)}`);
        previousKey = key;
      } else {
        console.log(key);
        values.forEach((value) => console.log(`  ${value}`));
      }
    }
    console.log();
  }

  if (options.html) {
    console.log('</div>');
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
        })
        .option('group', {
          type: 'boolean',
          default: false,
        });
    },
  );

  const { base, head, html, group } = argv as any;
  printDiffs(getMergeBase(base, head), head, { group, html });
}
