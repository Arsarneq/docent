/**
 * check-doc-reachability.test.js — Unit tests for the documentation reachability
 * lint (scripts/check-doc-reachability.js) that gates CI. It enforces "the index is
 * the schema": every tracked .md must be reachable from README.md by following
 * links, or be on the non-doctrine allowlist. These tests prove the check has teeth
 * (an unlinked doc fails) and that the AST walk ignores links inside code fences —
 * a regex walk would follow those and silently mask a real orphan.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findOrphans,
  extractMdLinks,
  resolveTarget,
} from '../../../../scripts/check-doc-reachability.js';

/** Run findOrphans over an in-memory { path: markdown } graph. */
function walk(graph, { start = 'README.md', allowlist = [] } = {}) {
  return findOrphans({
    files: Object.keys(graph),
    readFile: (f) => (f in graph ? graph[f] : null),
    start,
    allowlist,
  });
}

describe('findOrphans — documentation reachability', () => {
  it('reports no orphans when every file is reachable from README', () => {
    const { orphans } = walk({
      'README.md': 'see [docs](docs/README.md)',
      'docs/README.md': 'the [format](technical/session-format.md)',
      'docs/technical/session-format.md': 'no links',
    });
    assert.deepEqual(orphans, []);
  });

  it('flags an unlinked doctrine file — the lint has teeth', () => {
    const { orphans } = walk({
      'README.md': '[docs](docs/README.md)',
      'docs/README.md': 'no link to the orphan',
      'docs/orphan-doctrine.md': 'important doctrine nobody linked',
    });
    assert.deepEqual(orphans, ['docs/orphan-doctrine.md']);
  });

  it('does not flag an allowlisted non-doctrine orphan', () => {
    const { orphans } = walk(
      {
        'README.md': 'no links',
        'packages/shared/assets/reading-guidance.md': 'consumer asset',
      },
      { allowlist: ['packages/shared/assets/reading-guidance.md'] },
    );
    assert.deepEqual(orphans, []);
  });

  it('flags a stale allowlist entry (untracked, or now reachable)', () => {
    // Untracked: the entry is not in the file universe.
    const untracked = walk({ 'README.md': 'no links' }, { allowlist: ['gone/removed.md'] });
    assert.deepEqual(untracked.staleAllowlist, ['gone/removed.md']);

    // Now reachable: the entry IS linked from README, so it must not be allowlisted.
    const reachable = walk(
      { 'README.md': '[x](docs/x.md)', 'docs/x.md': '' },
      { allowlist: ['docs/x.md'] },
    );
    assert.deepEqual(reachable.staleAllowlist, ['docs/x.md']);
    assert.deepEqual(reachable.orphans, []); // reachable ⇒ not an orphan either
  });

  it('terminates on a cycle and reaches both files', () => {
    const { orphans } = walk({
      'README.md': '[a](a.md)',
      'a.md': '[b](b.md)',
      'b.md': '[a](a.md)', // back-edge into the cycle
    });
    assert.deepEqual(orphans, []);
  });

  it('does NOT follow a link inside a fenced code block (AST correctness)', () => {
    const { orphans } = walk({
      'README.md': 'intro\n\n```\n[example](docs/only-in-a-fence.md)\n```\n',
      'docs/only-in-a-fence.md': 'shown as an example, never actually linked',
    });
    assert.deepEqual(orphans, ['docs/only-in-a-fence.md']);
  });

  it('follows a reference-style link', () => {
    const { orphans } = walk({
      'README.md': 'see [the docs][d]\n\n[d]: docs/README.md',
      'docs/README.md': '',
    });
    assert.deepEqual(orphans, []);
  });

  it('does not throw when START is absent from the universe', () => {
    const { orphans, reachable } = walk({ 'other.md': 'x' }, { start: 'README.md' });
    assert.equal(reachable.has('README.md'), false);
    assert.deepEqual(orphans, ['other.md']);
  });
});

describe('extractMdLinks — link extraction', () => {
  it('resolves relative targets against the linking file directory', () => {
    assert.deepEqual(
      extractMdLinks('[a](../requirements/replay-sufficiency.md)', 'docs/technical/x.md'),
      ['docs/requirements/replay-sufficiency.md'],
    );
  });

  it('ignores external, anchor-only, and non-.md links', () => {
    const md =
      '[ext](https://example.com/x.md) [anchor](#section) [code](../scripts/build.js) [img](logo.png)';
    assert.deepEqual(extractMdLinks(md, 'docs/x.md'), []);
  });

  it('strips #anchor and ?query from a .md target', () => {
    assert.deepEqual(
      extractMdLinks('[v](technical/session-format.md#versioning)', 'docs/README.md'),
      ['docs/technical/session-format.md'],
    );
  });
});

describe('resolveTarget', () => {
  it('returns null for external schemes and anchors', () => {
    assert.equal(resolveTarget('README.md', 'https://x.com'), null);
    assert.equal(resolveTarget('README.md', 'mailto:a@b.c'), null);
    assert.equal(resolveTarget('README.md', '#top'), null);
  });

  it('returns null for non-.md targets', () => {
    assert.equal(resolveTarget('README.md', 'scripts/build.js'), null);
    assert.equal(resolveTarget('docs/README.md', '../packages/'), null);
  });

  it('resolves a nested relative .md to a repo-relative posix path', () => {
    assert.equal(
      resolveTarget(
        'docs/api/sync-protocol.md',
        '../../reference-implementations/sync-server/README.md',
      ),
      'reference-implementations/sync-server/README.md',
    );
  });
});
