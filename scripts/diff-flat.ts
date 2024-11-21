/* This file is a part of @mdn/browser-compat-data
 * See LICENSE file for more information. */

import chalk from 'chalk-template';
import { diffArrays } from 'diff';
import esMain from 'es-main';
import stripAnsi from 'strip-ansi';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { CompatData, SimpleSupportStatement } from '../types/types.js';
import { exec, execAsync, walk } from '../utils/index.js';

import { applyMirroring } from './build/index.js';
import { getMergeBase, getFileContent, getGitDiffStatuses } from './lib/git.js';

interface Contents<T = any> {
  base: T;
  head: T;
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
const getBaseAndHeadContents = <T>(
  baseCommit: string,
  basePath: string,
  headCommit: string,
  headPath: string,
): Contents<T> => {
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

// FIXME This is bad.
const allFlags: string[] = [];
const allNotes: string[] = [];

/**
 * Formats a flag reference.
 * @param index the flag index.
 * @returns formatted reference.
 */
const formatFlagIndex = (index: number): string => `[^f${index + 1}]`;

/**
 * Formats a flag reference.
 * @param index the flag index.
 * @returns formatted reference.
 */
const formatNoteIndex = (index: number): string => `[^n${index + 1}]`;

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
        // Merge values.
        if ('status' in obj[key]) {
          const { deprecated, standard_track, experimental } = obj[key].status;
          const statusFlags = [
            deprecated && 'deprecated',
            standard_track && 'standard_track',
            experimental && 'experimental',
          ].filter(Boolean);

          obj[key].status = statusFlags.join(',');
        }

        if ('tags' in obj[key]) {
          obj[key].tags = obj[key].tags.join(',');
        }

        if ('version_added' in obj[key]) {
          if ('flags' in obj[key]) {
            // Deduplicate flag.
            const flagsJson = JSON.stringify(obj[key].flags);
            if (!allFlags.includes(flagsJson)) {
              allFlags.push(flagsJson);
            }
            const flagIndex = allFlags.indexOf(flagsJson);
            obj[key].flags = formatFlagIndex(flagIndex);
          }

          if ('notes' in obj[key]) {
            const notes = toArray(obj[key].notes);
            obj[key].notes = notes
              .map((note) => {
                const notesJson = JSON.stringify(note);
                if (!allNotes.includes(notesJson)) {
                  allNotes.push(notesJson);
                }
                const noteIndex = allNotes.indexOf(notesJson);
                return noteIndex;
              })
              .sort()
              .map((index) => formatNoteIndex(index))
              .join(',');
          }

          const {
            version_added,
            version_removed,
            partial_implementation,
            alternative_name,
            prefix,
            flags,
            notes,
          } = obj[key] as SimpleSupportStatement;

          const parts = [
            version_added && version_added && `${version_added}+`,
            version_removed && `−${version_removed}`,
            partial_implementation && '(partial)',
            flags,
            prefix && `prefix=${prefix}`,
            alternative_name && `altname=${alternative_name}`,
            notes,
          ].filter(Boolean);

          obj[key].version = parts.join(' ');
          delete obj[key].version_added;
          delete obj[key].version_removed;
          delete obj[key].partial_implementation;
          delete obj[key].alternative_name;
          delete obj[key].prefix;
          delete obj[key].flags;
          delete obj[key].notes;
        }

        // Recursively flatten nested objects
        flattenObject(
          BROWSER_NAMES.includes(key) ? toArray(obj[key]).reverse() : obj[key],
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
 * Compares two strings ignoring ANSI escape codes.
 * @param a one value
 * @param b other value
 * @returns comparison result.
 */
const stripAnsiCompare = (a: string, b: string): number =>
  stripAnsi(a).localeCompare(stripAnsi(b));

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
  /**
   * Filters out irrelevant keys.
   * @param part the key part.
   * @returns true, if the part should be ignored, false otherwise
   */
  const keyFilter = (part) => part !== '__compat' && part !== 'support';
  return diffArrays(
    lastKey.split('.').filter(keyFilter),
    key.split('.').filter(keyFilter),
  )
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
 * @param options.mirror Whether to apply mirroring, rather than ignore "mirror" values
 */
const printDiffs = (
  base: string,
  head = '',
  options: { group: boolean; html: boolean; mirror: boolean },
): void => {
  if (options.html) {
    console.log('<pre style="font-family: monospace">');
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
      const contents = getBaseAndHeadContents<CompatData>(
        base,
        status.basePath,
        head,
        status.headPath,
      );
      if (options.mirror) {
        for (const feature of walk(undefined, contents.base)) {
          applyMirroring(feature);
        }
        for (const feature of walk(undefined, contents.head)) {
          applyMirroring(feature);
        }
      }

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

      let lastKey = '';

      for (const key of keys) {
        const baseValue = JSON.stringify(baseData[key] ?? null);
        const headValue = JSON.stringify(headData[key] ?? null);
        if (baseValue === headValue) {
          continue;
        }
        if (!lastKey) {
          lastKey = key;
        }
        const keyDiff = diffKeys(
          key.slice(prefix.length),
          lastKey.slice(prefix.length),
          options,
        );

        /**
         * Checks whether the value is a relevant value.
         * @param value the value.
         * @returns TRUE if the value is relevant, FALSE otherwise.
         */
        const hasValue = (value: any) =>
          typeof value === 'boolean' || (!!value && value !== 'mirror');

        const splitRegexp = /(?<=^")|(?<=[\],/ ])|(?=[[,/ ])|(?="$)/;
        const valueDiff = diffArrays(
          (hasValue(headData[key] ?? null) ? headValue : '').split(splitRegexp),
          (hasValue(baseData[key] ?? null) ? baseValue : '').split(splitRegexp),
        )
          .map((part) => {
            // Note: removed/added is deliberately inversed here, to have additions first.
            const value = part.value.join('');
            if (part.removed) {
              return options.html
                ? `<ins style="color: green">${value}</ins>`
                : chalk`{green ${value}}`;
            } else if (part.added) {
              return options.html
                ? `<del style="color: red">${value}</del>`
                : chalk`{red ${value}}`;
            }

            return value;
          })
          .join('');

        const value = valueDiff;

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
          const groupKey = `${!browser ? '' : options.html ? `<strong>${browser}</strong>.` : chalk`{cyan ${browser}}.`}${field} = ${value}`;
          const groupValue = key
            .split('.')
            .map((part) => (part !== browser && part !== field ? part : '{}'))
            .reverse()
            .filter((value, index) => index > 0 || value !== '{}')
            .reverse()
            .map((value) =>
              value !== '{}'
                ? value
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
            ? `${keyDiff} = ${value}`
            : chalk`${keyDiff} = ${value}`;
          const group = groups.get(commonName) ?? new Set();
          group.add(change);
          groups.set(commonName, group);
        }
        lastKey = key;
      }
    }
  }

  const originalEntries: [string, string[]][] = [...groups.entries()].map(
    ([key, set]) => [key, [...set.values()]],
  );

  const entryGroups = new Map<string, string[]>();
  for (const [key, values] of originalEntries) {
    const groupKey = JSON.stringify(values);
    const keys = entryGroups.get(groupKey) ?? [];
    keys.push(key);
    entryGroups.set(groupKey, keys);
  }

  const rawEntries = [...entryGroups.entries()];

  if (options.group) {
    rawEntries.sort(([, a], [, b]) =>
      stripAnsiCompare(a.at(0) as string, b.at(0) as string),
    );
  }

  const entries = rawEntries.map(([valuesJson, keys]) => [
    keys,
    JSON.parse(valuesJson),
  ]);

  const json = JSON.stringify(entries);
  for (const flagIndex of allFlags.keys()) {
    if (!json.includes(formatFlagIndex(flagIndex))) {
      allFlags[flagIndex] = '';
    }
  }
  for (const noteIndex of allNotes.keys()) {
    if (!json.includes(formatNoteIndex(noteIndex))) {
      allNotes[noteIndex] = '';
    }
  }

  /**
   * Prints references found in the inputs.
   * @param inputs the inputs to scan for references.
   */
  const printRefs = (...inputs: string[]): void => {
    const lines: string[] = [];
    for (const [index, content] of allFlags.entries()) {
      const ref = formatFlagIndex(index);
      if (inputs.some((input) => input.includes(ref))) {
        lines.push(`${ref}: ${content}`);
      }
    }
    for (const [index, content] of allNotes.entries()) {
      const ref = formatNoteIndex(index);
      if (inputs.some((input) => input.includes(ref))) {
        lines.push(`${ref}: ${content}`);
      }
    }
    if (lines.length > 0) {
      console.log();
      lines.forEach((line) =>
        console.log(
          options.html ? `<em>${line}</em>` : chalk`{italic ${line}}`,
        ),
      );
    }
  };

  for (const entry of entries) {
    let previousKey: string | null = null;
    if (options.group) {
      const [values, keys] = entry;
      if (keys.length == 1) {
        const key = keys.at(0) as string;
        const keyDiff = diffKeys(key, previousKey ?? key, options);
        values.forEach((value) => console.log(`${value}`));
        console.log(`  ${keyDiff}`);
        printRefs(...values);
        previousKey = key;
      } else {
        previousKey = null;
        console.log(values.join('\n'));
        const maxKeyLength = Math.max(...keys.map((key) => key.length));
        if (options.html) {
          process.stdout.write(
            `<details><summary>${keys.length} ${keys.length === 1 ? 'path' : 'paths'}</summary>`,
          );
        }
        for (const key of keys) {
          const keyDiff = diffKeys(key, previousKey ?? (keys.at(1) as string), {
            ...options,
            fill: maxKeyLength,
          });
          console.log(`  ${keyDiff}`);
          previousKey = key;
        }
        if (options.html) {
          process.stdout.write('</details>');
        }
        printRefs(...values);
        previousKey = null;
      }
    } else {
      const [keys, values] = entry;
      if (values.length == 1) {
        for (const key of keys) {
          const keyDiff = diffKeys(key, previousKey ?? key, options);
          console.log(`${keyDiff}`);
          previousKey = key;
        }
        values.forEach((value) => console.log(`  ${value}`));
      } else {
        for (const key of keys) {
          const keyDiff = diffKeys(key, previousKey ?? key, options);
          console.log(`${keyDiff}`);
          previousKey = key;
        }
        values.forEach((value) => console.log(`  ${value}`));
      }
      previousKey = null;
    }
    console.log('');
  }

  if (options.html) {
    console.log('</pre>');
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
        })
        .option('mirror', {
          type: 'boolean',
          default: false,
        });
    },
  );

  const options = argv as any;

  if (/^\d+$/.test(options.base)) {
    options.head = `pull/${options.base}/head`;
    options.base = 'origin/main';
  }

  if (
    options.head === 'HEAD' &&
    exec('git branch --show-current') === 'flat-diff'
  ) {
    // Workaround: Compare first positional parameter against origin/main.
    [options.base, options.head] = [options.head, 'origin/main'];
  }

  const fetchAndResolve = (ref: string) => {
    if (ref.startsWith('origin/')) {
      const remoteRef = ref.slice('origin/'.length);
      exec(`git fetch origin ${remoteRef}`);
      return exec(`git rev-parse ${ref}`);
    } else if (ref.startsWith('pull/')) {
      exec(`git fetch origin ${ref}`);
      return exec('git rev-parse FETCH_HEAD');
    }

    return exec(`git rev-parse ${ref}`);
  };

  options.base = fetchAndResolve(options.base);
  options.head = fetchAndResolve(options.head);

  const { base, head, group, html, mirror } = options;

  printDiffs(getMergeBase(base, head), head, { group, html, mirror });
}
