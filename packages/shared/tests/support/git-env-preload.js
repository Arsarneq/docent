/**
 * git-env-preload.js — the runner-level route to a clean git environment.
 * Named by `--import` on a `node --test` line, it is loaded by each test
 * file's process ahead of the file (the runner forwards the flag to every
 * process it spawns, never loading the preload itself) and drops every
 * `GIT_*` name from that process's environment before the file loads, so a
 * caller's exported git variable reaches no suite that line runs. It calls the
 * `dropGitEnv` of ./child-env.js, where the per-case helpers stay; which
 * runner lines carry this file, and the harness locks that hold them, are
 * stated in docs/test/unit.md.
 */

import { dropGitEnv } from './child-env.js';

dropGitEnv();
