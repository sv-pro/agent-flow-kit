import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Kit } from '../kit.js';
import { tempRoot, fillOutput, REAL_ROOT } from './helpers.js';

// Characterization of an OPEN authorization gap, not proof of a secure gate.
// When an independent trust anchor exists, replace these success expectations
// with denial + unchanged-state/history assertions. See SECURITY.md.
const KEY = 'gate-probe';
const LABEL = 'unverified-test-reviewer';

function fixture(t) {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of ['kit.js', 'package.json']) {
    fs.copyFileSync(path.join(REAL_ROOT, file), path.join(root, file));
  }
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.cpSync(path.join(REAL_ROOT, 'node_modules/yaml'), path.join(root, 'node_modules/yaml'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude'));
  fs.copyFileSync(path.join(REAL_ROOT, '.claude/settings.json'), path.join(root, '.claude/settings.json'));
  const kit = new Kit({ root });
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [path.join(root, 'kit.js'), 'task', ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], // no terminal, stdin or human interaction
      timeout: 10_000,
      env: {
        ...process.env,
        // Git reads this process-supplied label; no user's Git config is changed.
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'user.name',
        GIT_CONFIG_VALUE_0: LABEL,
      },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  };
  const ok = (...args) => {
    const result = cli(...args);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result;
  };
  ok('new', KEY, '--type', 'bug', '--title', 'Isolated authorization probe');
  const requestReview = () => {
    for (const stage of ['intake', 'reproduce', 'root-cause']) {
      assert.equal(kit.loadTask(KEY).stage, stage);
      fillOutput(kit, KEY);
      ok('next', KEY);
    }
    assert.equal(kit.loadTask(KEY).state, 'awaiting-review');
  };
  return { kit, cli, ok, requestReview };
}

const cases = [
  { command: ['review', KEY, 'approve'], event: 'approved', stage: 'fix', state: 'in-progress', extra: {} },
  { command: ['review', KEY, 'reject', '--note', 'Automated probe'], event: 'rejected', stage: 'root-cause', state: 'in-progress', extra: { note: 'Automated probe' } },
  { command: ['skip', KEY, '--reason', 'Automated probe'], event: 'skipped', stage: 'fix', state: 'in-progress', extra: { note: 'Automated probe' } },
  { command: ['wait', KEY, '--on', 'Automated probe'], event: 'waiting', stage: 'root-cause', state: 'waiting', extra: { on: 'Automated probe' } },
];

for (const { command, event, stage, state, extra } of cases) {
  test(`OPEN human-gate gap: unattended CLI records ${event} with an unverified Git label`, (t) => {
    const { kit, ok, requestReview } = fixture(t);
    requestReview();
    const before = kit.loadTask(KEY);
    assert.equal(before.stage, 'root-cause');
    assert.equal(before.history.at(-1).event, 'review-requested');

    ok(...command);

    // Reload persisted YAML, rather than trusting stdout or an in-memory return.
    const after = kit.loadTask(KEY);
    assert.equal(after.stage, stage);
    assert.equal(after.state, state);
    assert.deepEqual(after.history.slice(0, before.history.length), before.history);
    assert.equal(after.history.length, before.history.length + 1);
    const appended = after.history.at(-1);
    assert.match(appended.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.deepEqual(appended, {
      at: appended.at, by: LABEL, via: 'cli', event, stage: 'root-cause', ...extra,
    });
    t.diagnostic(JSON.stringify({
      command: ['node', 'kit.js', 'task', ...command],
      before: { stage: before.stage, state: before.state },
      after: { stage: after.stage, state: after.state },
      appended,
    }));
  });
}

test('CLI workflow guards remain enforced: state, decision and next review stop', (t) => {
  const { kit, cli, ok, requestReview } = fixture(t);
  const bytes = () => fs.readFileSync(kit.taskFile(KEY), 'utf8');
  let before = bytes();
  let result = cli('review', KEY, 'approve');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not awaiting review/);
  assert.equal(bytes(), before);

  requestReview();
  before = bytes();
  ok('next', KEY);
  assert.equal(bytes(), before, 'next cannot advance a pending review');
  result = cli('review', KEY, 'maybe');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /approve or reject/);
  assert.equal(bytes(), before, 'invalid decisions must not change state or history');
});
