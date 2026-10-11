/**
 * child-env.js — the one home for the environment a shared unit suite runs its
 * git-reading work under (see docs/test/unit.md).
 *
 * A suite that reads the tracked tree answers to git's environment as well as
 * to its own: a `GIT_*` variable a git hook exports (`GIT_INDEX_FILE`, say)
 * points every `git ls-files` at another index, so the tree reads come back
 * empty or wrong and the cases standing on them red or vanish. The work runs
 * clear of that environment by one of two routes, both kept here:
 *
 * - a child process takes `childEnv(pins)` — the ambient environment with every
 *   `GIT_*` name dropped, then the case's own pins on top;
 * - in-process work takes `withoutGitEnv(fn)` — `fn` runs with this process's
 *   `GIT_*` names removed, each put back however `fn` ends.
 *
 * `withEnv(pins, fn)` is the reverse tool: a case that has to POISON the
 * environment (a regression case, a harness lock) pins names for the body's
 * duration and has them restored, absence included.
 *
 * The harness locks in ../unit/check-cli-smoke.test.js hold these helpers'
 * behaviour for every suite that imports them.
 */

/**
 * The environment for a child process: the ambient environment with every
 * `GIT_*` variable dropped, then the case's own pins on top — so a case that
 * deliberately sets a `GIT_*` name still wins.
 * @param {Record<string, string>} [pins] the case's own environment
 * @returns {Record<string, string>} the child's environment
 */
export function childEnv(pins = {}) {
  const ambient = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
  return { ...ambient, ...pins };
}

/**
 * Run `fn` with `pins` set on THIS process's environment, restoring every
 * pinned name to the value it had — including its absence — however `fn` ends.
 * The one home for a lock that has to poison the ambient environment the child
 * inherits from, so no case leaves a variable behind for the cases after it.
 * Synchronous work only — the environment is restored when `fn` returns.
 * @template T
 * @param {Record<string, string>} pins the names to pin, and their values
 * @param {() => T} fn the body to run under them
 * @returns {T} what `fn` returns
 */
export function withEnv(pins, fn) {
  const restore = Object.keys(pins).map((name) => [name, process.env[name]]);
  Object.assign(process.env, pins);
  try {
    return fn();
  } finally {
    for (const [name, value] of restore) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/**
 * Run `fn` in this process with every `GIT_*` variable removed from its
 * environment — the in-process counterpart of `childEnv` — and put each one
 * back with its value however `fn` ends.
 * Synchronous work only — the environment is restored when `fn` returns.
 * @template T
 * @param {() => T} fn the in-process work to run clear of git's environment
 * @returns {T} what `fn` returns
 */
export function withoutGitEnv(fn) {
  const saved = Object.entries(process.env).filter(([name]) => name.startsWith('GIT_'));
  for (const [name] of saved) delete process.env[name];
  try {
    return fn();
  } finally {
    for (const [name, value] of saved) process.env[name] = value;
  }
}
