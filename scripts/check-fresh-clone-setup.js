/**
 * check-fresh-clone-setup.js — the Chrome Extension block of the contributing
 * guide's §Development Setup, run on a fresh clone of this checkout.
 *
 * The block is read from the working tree's document. Its comment and blank
 * lines are dropped and the public clone line is replaced by a quiet clone of
 * this checkout's committed HEAD. One bash script runs in a fresh temporary
 * directory: an EXIT trap removing that directory, each line as its own group
 * exiting, on failure, with the status the check assigns to that line (10 plus
 * its index), then a test for the synced schema copy and
 * a last `exit 3` the check reads as green.
 * Each line is one command or an `&&`, `||` or pipe list, its status its own;
 * any other shape, or a line whose leading text, or whose text after `&&`,
 * `||` or `|`, is `exit` or `exec` as a word, is refused, a quoted `;` or `<<` included, the test being lexical; a subshell
 * or a substitution is part of its command.
 *
 * Exit 1 (drift): the Chrome Extension block of CONTRIBUTING, run on a fresh
 * clone of the checkout, fails a line or leaves no synced schema copy.
 * Exit 2 (machinery): an unreadable document, a `--doc` without a path, a
 * missing Chrome Extension heading, other than one bash block in it, no public
 * clone line, a line shape the check refuses, the clone failing, the check's
 * own setup failing, or the script ending with a status or signal no line owns.
 *
 * Usage:
 *   node scripts/check-fresh-clone-setup.js [--dry-run] [--doc <path>]
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';
import { extractHeadingSection } from './check-test-inventory.js';

const ROOT = resolve(import.meta.dirname, '..');
export const DOC_PATH = '.github/CONTRIBUTING.md';
export const SECTION = 'Chrome Extension';
export const CLONE_LINE = 'git clone https://github.com/Arsarneq/docent.git';
export const SYNCED_SCHEMA = 'packages/extension/shared/session.schema.json';
export const REFUSED =
  /(?:^|&&|\|\||\|)\s*(?:exit|exec)(?![\w=-])|;|<<|(?<![&>|])&(?![&>])|[&|\\]$/;
export const GREEN = 3;
export const LINE_BASE = 10;

export class InputError extends Error {}

/**
 * The commands of the Chrome Extension section's one bash block.
 * @param {string} markdown the contributing guide's text
 * @returns {string[]} the block's lines, comment and blank lines dropped
 * @throws {InputError} on a missing section, other than one bash block, a
 *   refused line shape, or no public clone line
 */
export function extractCommands(markdown) {
  const section = extractHeadingSection(
    markdown,
    new RegExp(`^###\\s+${SECTION}\\s*$`),
    /^#{1,6}\s/,
  );
  if (section === null) throw new InputError(`no "### ${SECTION}" heading in the document`);
  const blocks = [];
  visit(unified().use(remarkParse).parse(section), 'code', (node) => {
    if (node.lang === 'bash') blocks.push(node.value);
  });
  if (blocks.length !== 1)
    throw new InputError(
      `the "### ${SECTION}" section carries ${blocks.length} bash blocks; it must carry exactly one`,
    );
  const commands = blocks[0]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  const refused = commands.find((c) => REFUSED.test(c));
  if (refused !== undefined)
    throw new InputError(`the line "${refused}" is a line shape the check refuses`);
  if (!commands.includes(CLONE_LINE))
    throw new InputError(`the bash block carries no "${CLONE_LINE}" line`);
  return commands;
}

const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
/**
 * The bash script that runs the commands in `work`, one group and status per line.
 * @param {string[]} commands the extracted commands
 * @param {string} source the checkout the clone line is pointed at
 * @param {string} work the temporary directory the script runs in and removes
 * @returns {string}
 */
export function buildScript(commands, source, work) {
  return [
    `trap ${q(`rm -rf ${q(work)}`)} EXIT`,
    ...commands.map((c, i) => {
      const line = c === CLONE_LINE ? `git clone -q ${q(source)} docent` : c;
      return `{ ${line}\n} || exit ${LINE_BASE + i}`;
    }),
    `test -f ${q(join(work, 'docent', SYNCED_SCHEMA))} || exit ${LINE_BASE + commands.length}`,
    `exit ${GREEN}`,
  ].join('\n');
}

const noGit = () =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

/**
 * The check: read the document, run its block on a fresh clone, and report.
 * @param {string[]} argv the command-line arguments
 * @param {object} [seams]
 * @param {string} [seams.source] the checkout to clone
 * @param {string} [seams.tmp] the directory the temporary directory is made in
 * @param {(line: string) => void} [seams.error] the red and machinery lines' sink
 * @param {(line: string) => void} [seams.log] the green and dry-run lines' sink
 * @returns {0 | 1 | 2} the exit code
 */
export function run(
  argv,
  { source = ROOT, tmp = tmpdir(), error: report = console.error, log: print = console.log } = {},
) {
  const docIdx = argv.indexOf('--doc');
  if (docIdx !== -1 && argv[docIdx + 1] === undefined) {
    report('✗ `--doc` needs a path (exit 2).');
    return 2;
  }
  const docPath = docIdx === -1 ? join(ROOT, DOC_PATH) : resolve(argv[docIdx + 1]);
  const shown = relative(process.cwd(), docPath) + (docIdx === -1 ? ' (working tree)' : '');
  let commands;
  try {
    commands = extractCommands(readFileSync(docPath, 'utf8'));
  } catch (e) {
    report(`✗ ${shown}: ${e.message} (exit 2).`);
    return 2;
  }
  if (argv.includes('--dry-run')) {
    print(commands.join('\n'));
    return 0;
  }
  const env = noGit();
  let work;
  try {
    const lookup = spawnSync('git', ['-C', source, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      env,
    });
    if (lookup.error) throw lookup.error;
    if (lookup.status !== 0) throw new Error(`git rev-parse in ${source}: ${lookup.stderr.trim()}`);
    const rev = lookup.stdout.trim();
    const from = `the documented extension setup, read from ${shown}`;
    work = mkdtempSync(join(tmp, 'fresh-clone-setup-'));
    const spawned = spawnSync('bash', ['-c', buildScript(commands, source, work)], {
      cwd: work,
      stdio: 'inherit',
      env,
    });
    if (spawned.error) throw new Error(`the script could not start: ${spawned.error.message}`);
    const { status, signal } = spawned;
    if (status === GREEN) {
      print(`✓ ${from}, ran on a fresh clone of ${rev} and left ${SYNCED_SCHEMA}.`);
      return 0;
    }
    if (status === LINE_BASE + commands.length) {
      report(`✗ ${from} and run on a fresh clone of ${rev}, left no ${SYNCED_SCHEMA}.`);
      return 1;
    }
    const line = commands[status - LINE_BASE];
    if (line === undefined) {
      report(
        `✗ the setup script ended with ${signal ?? `status ${status}`}, which no line owns (exit 2).`,
      );
      return 2;
    }
    if (line === CLONE_LINE) {
      report(`✗ the clone of ${source} failed (exit 2).`);
      return 2;
    }
    report(`✗ ${from} and run on a fresh clone of ${rev}, failed at: ${line}.`);
    return 1;
  } catch (e) {
    report(`✗ the check's own setup failed: ${e.message} (exit 2).`);
    return 2;
  } finally {
    if (work) rmSync(work, { recursive: true, force: true });
  }
}

/* c8 ignore next */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(run(process.argv.slice(2)));
