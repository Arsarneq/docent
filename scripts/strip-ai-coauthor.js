#!/usr/bin/env node
/**
 * strip-ai-coauthor.js — commit-msg hook: never let an AI assistant stand as a
 * commit co-author.
 *
 * Run by lefthook's `commit-msg` hook with the path to the pending commit
 * message file. It deletes any `Co-authored-by:` trailer that names Claude /
 * Anthropic (or the `noreply@anthropic.com` address), then collapses the blank
 * gap a removed trailer leaves behind.
 *
 * Rationale: assistant-added `Co-Authored-By: Claude …` trailers register a
 * phantom contributor with an unlinked email, which trips the CLA gate (it can
 * never sign) — see PR #166. The rule is enforced here, at commit time, so it
 * holds no matter which tool wrote the message.
 *
 * Scope is deliberately narrow: only AI-assistant co-authors are stripped.
 * Human and bot co-authors (e.g. dependabot) pass through untouched.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('strip-ai-coauthor: no commit-message file path given');
  process.exit(0); // never block a commit on a hook wiring slip
}

const AI_COAUTHOR = /^\s*co-authored-by:.*(claude|anthropic|noreply@anthropic\.com)/i;

const original = readFileSync(file, 'utf8');
const lines = original.split('\n');
const kept = lines.filter((line) => !AI_COAUTHOR.test(line));

if (kept.length !== lines.length) {
  // Collapse a run of >1 blank line (left where the trailer used to be) to one.
  const collapsed = kept.join('\n').replace(/\n{3,}/g, '\n\n');
  writeFileSync(file, collapsed);
  console.log('strip-ai-coauthor: removed AI-assistant co-author trailer');
}
