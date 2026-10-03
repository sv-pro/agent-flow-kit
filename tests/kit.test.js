import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  Kit, KitError, validateKey, validateClaims, checkSections, parseFrontMatter,
  renderTemplate, parseArgs, isPersonEvent, formatStatus,
} from '../kit.js';
import { tempKit, tempRoot, fillOutput, advanceTo } from './helpers.js';

const newBug = (kit, key = 'demo-bug', extra = {}) => kit.createTask({ key, type: 'bug', title: 'Demo bug', ...extra });

test('keys: tickets and lowercase slugs are accepted, others are not', () => {
  assert.equal(validateKey('PROJ-123'), 'PROJ-123');
  assert.equal(validateKey('demo-bug'), 'demo-bug');
  for (const bad of ['', 'proj_1', 'Proj-1', '../x', 'a b', 'PROJ-']) assert.throws(() => validateKey(bad), KitError);
});

test('helpers: template, front matter, args', () => {
  assert.equal(renderTemplate('{{key}} {{title}} {{other}}', { key: 'K', title: 'T' }), 'K T {{other}}');
  assert.deepEqual(parseFrontMatter('---\na: 1\n---\nbody').data, { a: 1 });
  assert.equal(parseFrontMatter('no front matter').data, null);
  const { pos, flags } = parseArgs(['new', 'K', '--type', 'bug', '--note=x y', '-v', '--flag']);
  assert.deepEqual(pos, ['new', 'K']);
  assert.deepEqual(flags, { type: 'bug', note: 'x y', v: true, flag: true });
});

test('task new: creates task.yaml, first output, and a created event', () => {
  const kit = tempKit();
  const t = newBug(kit);
  assert.equal(t.stage, 'intake');
  assert.equal(t.state, 'in-progress');
  assert.equal(t.history[0].event, 'created');
  assert.equal(t.history[0].by, 'tester');
  assert.equal(t.history[0].via, 'cli');
  assert.match(t.history[0].at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.ok(fs.existsSync(path.join(kit.root, 'tasks/demo-bug/01-intake.md')));
  assert.match(fs.readFileSync(path.join(kit.root, 'tasks/demo-bug/01-intake.md'), 'utf8'), /# Intake: Demo bug \(demo-bug\)/);
  assert.throws(() => newBug(kit), /already exists/);
  assert.throws(() => kit.createTask({ key: 'x1', type: 'nope', title: 't' }), /unknown type/);
  assert.throws(() => kit.createTask({ key: 'x2', type: 'bug' }), /--title/);
  assert.throws(() => kit.createTask({ key: 'x3', type: 'bug', title: 't', repos: ['ghost'] }), /unknown repo/);
});

test('task status: stage, instructions, exit criteria, output, repos', () => {
  const kit = tempKit({ repos: 'repos:\n  - {name: svc, url: "u", owner: ours, purpose: p, branch: main}\n' });
  newBug(kit, 'demo-bug', { repos: ['svc'] });
  const s = kit.status('demo-bug');
  assert.equal(s.stage.id, 'intake');
  assert.equal(s.stage.output, 'tasks/demo-bug/01-intake.md');
  assert.ok(s.stage.exit_criteria.length > 0);
  assert.equal(s.repos[0].cloned, false);
  const text = formatStatus(s);
  assert.match(text, /instructions:/);
  assert.match(text, /not cloned/);
  assert.match(text, /task next demo-bug/);
});

test('task next refuses an empty stage and lists every missing section', () => {
  const kit = tempKit();
  newBug(kit);
  const r = kit.next('demo-bug');
  assert.equal(r.outcome, 'refused');
  for (const s of ['Ask', 'Report', 'Earlier answers', 'Scope', 'Comparison offered']) {
    assert.ok(r.problems.some((p) => p.includes(s)), `mentions ${s}`);
  }
  assert.equal(kit.status('demo-bug').stage.id, 'intake');
});

test('task next: missing heading and leftover placeholder are reported', () => {
  const kit = tempKit();
  newBug(kit);
  const file = path.join(kit.root, 'tasks/demo-bug/01-intake.md');
  fs.writeFileSync(file, '# Intake\n\n## Ask\nSomething.\n\n## Report\n{{placeholder}}\n');
  const r = kit.next('demo-bug');
  assert.ok(r.problems.some((p) => /missing section: Scope/.test(p)));
  assert.ok(r.problems.some((p) => /empty.*Report/.test(p)));
});

test('task next advances a gate-less stage', () => {
  const kit = tempKit();
  newBug(kit);
  fillOutput(kit, 'demo-bug');
  const r = kit.next('demo-bug');
  assert.equal(r.outcome, 'advanced');
  const s = kit.status('demo-bug');
  assert.equal(s.stage.id, 'reproduce');
  assert.ok(fs.existsSync(path.join(kit.root, 'tasks/demo-bug/02-reproduce.md')));
  assert.equal(kit.loadTask('demo-bug').history.at(-1).event, 'advanced');
});

test('review: root-cause asks for review, reject keeps the stage and stores the note, approve advances', () => {
  const kit = tempKit();
  newBug(kit);
  advanceTo(kit, 'demo-bug', 'root-cause');
  fillOutput(kit, 'demo-bug');
  assert.equal(kit.next('demo-bug').outcome, 'review-requested');
  assert.equal(kit.status('demo-bug').state, 'awaiting-review');
  assert.equal(kit.next('demo-bug').outcome, 'awaiting-review');
  assert.throws(() => kit.review('demo-bug', 'maybe'), /approve or reject/);

  assert.throws(() => kit.review('demo-bug', 'reject', ''), /needs a note/);
  kit.review('demo-bug', 'reject', 'Where is the anchor for claim 1?');
  let s = kit.status('demo-bug');
  assert.equal(s.stage.id, 'root-cause');
  assert.equal(s.state, 'in-progress');
  assert.equal(s.rejection, 'Where is the anchor for claim 1?');
  assert.match(formatStatus(s), /REJECTED.*anchor for claim 1/);
  assert.throws(() => kit.review('demo-bug', 'approve'), /not awaiting review/);

  assert.equal(kit.next('demo-bug').outcome, 'review-requested');
  assert.equal(kit.status('demo-bug').rejection, null);
  kit.review('demo-bug', 'approve');
  s = kit.status('demo-bug');
  assert.equal(s.stage.id, 'fix');
  const events = kit.loadTask('demo-bug').history.map((e) => e.event);
  assert.ok(events.includes('rejected') && events.includes('approved'));
});

test('requirements block a stage before it starts and can be met early', () => {
  const kit = tempKit();
  newBug(kit);
  assert.throws(() => kit.meet('demo-bug', 'nope', 'x'), /unknown requirement/);
  assert.throws(() => kit.meet('demo-bug', 'pr-opened', ''), /--evidence/);
  kit.meet('demo-bug', 'pr-opened', 'https://example.com/pr/1');
  assert.equal(kit.status('demo-bug').state, 'in-progress');
  advanceTo(kit, 'demo-bug', 'verify');
  assert.equal(kit.status('demo-bug').state, 'in-progress');
  assert.deepEqual(kit.status('demo-bug').unmet, []);

  const k2 = tempKit();
  newBug(k2, 'late-bug');
  advanceTo(k2, 'late-bug', 'code-review');
  fillOutput(k2, 'late-bug');
  k2.next('late-bug');
  k2.review('late-bug', 'approve');
  let s = k2.status('late-bug');
  assert.equal(s.stage.id, 'verify');
  assert.equal(s.state, 'blocked');
  assert.equal(s.unmet[0].id, 'pr-opened');
  const n = k2.next('late-bug');
  assert.equal(n.outcome, 'blocked');
  assert.equal(k2.loadTask('late-bug').history.some((e) => e.event === 'blocked' && e.requirement === 'pr-opened'), true);
  s = k2.meet('late-bug', 'pr-opened', 'PR #12');
  assert.equal(s.state, 'in-progress');
  assert.equal(k2.loadTask('late-bug').met['pr-opened'], 'PR #12');
});

test('support: investigate requires data-access, learn requires reply-posted', () => {
  const kit = tempKit();
  kit.createTask({ key: 'SUP-1', type: 'support', title: 'Why no mail' });
  advanceTo(kit, 'SUP-1', 'investigate');
  assert.equal(kit.status('SUP-1').state, 'blocked');
  assert.equal(kit.status('SUP-1').unmet[0].id, 'data-access');
  kit.meet('SUP-1', 'data-access', 'VPN up, read-only credential tested');
  advanceTo(kit, 'SUP-1', 'learn');
  assert.equal(kit.status('SUP-1').state, 'blocked');
  assert.equal(kit.status('SUP-1').unmet[0].id, 'reply-posted');
  kit.meet('SUP-1', 'reply-posted', 'posted 2026-01-01T10:00Z');
  fillOutput(kit, 'SUP-1');
  assert.equal(kit.next('SUP-1').outcome, 'done');
  assert.equal(kit.status('SUP-1').state, 'done');
});

test('wait and resume', () => {
  const kit = tempKit();
  newBug(kit);
  assert.throws(() => kit.wait('demo-bug', ''), /--on/);
  assert.throws(() => kit.resume('demo-bug'), /not waiting/);
  kit.wait('demo-bug', 'reporter to send logs');
  let s = kit.status('demo-bug');
  assert.equal(s.state, 'waiting');
  assert.equal(s.waitingOn, 'reporter to send logs');
  assert.equal(kit.next('demo-bug').outcome, 'waiting');
  s = kit.resume('demo-bug');
  assert.equal(s.state, 'in-progress');
  const last = kit.loadTask('demo-bug').history.slice(-2);
  assert.deepEqual(last.map((e) => e.event), ['waiting', 'resumed']);
  assert.equal(last[0].on, 'reporter to send logs');
});

test('skip moves on and records the reason', () => {
  const kit = tempKit();
  newBug(kit);
  assert.throws(() => kit.skip('demo-bug', ''), /--reason/);
  const s = kit.skip('demo-bug', 'reporter gave full details');
  assert.equal(s.stage.id, 'reproduce');
  const ev = kit.loadTask('demo-bug').history.find((e) => e.event === 'skipped');
  assert.equal(ev.stage, 'intake');
  assert.equal(ev.note, 'reporter gave full details');
});

test('--from links a parent task and must exist', () => {
  const kit = tempKit();
  newBug(kit, 'PROJ-1');
  const child = kit.createTask({ key: 'PROJ-2', type: 'bug', title: 'Child', from: 'PROJ-1' });
  assert.equal(child.from, 'PROJ-1');
  assert.equal(kit.listTasks().find((t) => t.key === 'PROJ-2').from, 'PROJ-1');
  assert.match(formatStatus(kit.status('PROJ-2')), /from PROJ-1/);
  assert.throws(() => kit.createTask({ key: 'PROJ-3', type: 'bug', title: 'x', from: 'PROJ-99' }), /no task/);
});

test('via ui is recorded in history', () => {
  const root = tempRoot();
  const kit = new Kit({ root, user: 'tester', via: 'ui' });
  newBug(kit);
  assert.equal(kit.loadTask('demo-bug').history[0].via, 'ui');
});

test('a task completes through the whole bug playbook', () => {
  const kit = tempKit();
  newBug(kit);
  kit.meet('demo-bug', 'pr-opened', 'PR #1');
  advanceTo(kit, 'demo-bug', 'learn');
  fillOutput(kit, 'demo-bug');
  assert.equal(kit.next('demo-bug').outcome, 'done');
  assert.equal(kit.next('demo-bug').outcome, 'done');
  assert.equal(kit.loadTask('demo-bug').history.at(-1).event, 'done');
  assert.equal(kit.check().errors.length, 0);
});

// ----- claims -----

const table = (rows) => `## Claims\n\n| Claim | Kind | Anchor |\n|---|---|---|\n${rows}\n`;

test('claims: a measured row without an anchor fails', () => {
  assert.deepEqual(validateClaims(table('| A | measured | npm test |\n| B | inferred | |\n| C | decision | |')), []);
  const p = validateClaims(table('| A | measured | |'));
  assert.equal(p.length, 1);
  assert.match(p[0], /claim 1: measured claim needs an anchor/);
  assert.match(validateClaims(table('| A | measured | n/a |'))[0], /anchor/);
});

test('claims: unknown kind, missing table, empty table', () => {
  assert.match(validateClaims(table('| A | guess | x |'))[0], /kind "guess"/);
  assert.match(validateClaims('## Claims\nnone')[0], /table missing/);
  assert.match(validateClaims(table(''))[0], /no rows/);
  assert.equal(validateClaims(table('| A | measured | |\n| B | wild | |')).length, 2);
});

test('claims: a stage with claims refuses a bad table through next', () => {
  const kit = tempKit();
  newBug(kit);
  advanceTo(kit, 'demo-bug', 'root-cause');
  const file = fillOutput(kit, 'demo-bug');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('| npm test', '|'));
  const r = kit.next('demo-bug');
  assert.equal(r.outcome, 'refused');
  assert.ok(r.problems.some((p) => /measured claim needs an anchor/.test(p)));
});

test('sections: comment-only and placeholder-only sections are empty', () => {
  const md = '# T\n\n## A\n<!-- c -->\n\n## B\n{{x}}\n\n## C\ntext\n';
  const p = checkSections(md, ['A', 'B', 'C', 'D']);
  assert.equal(p.length, 3);
  assert.ok(p.some((x) => /missing section: D/.test(x)));
});

// ----- check and doctor -----

test('check passes on the shipped kit', () => {
  const kit = new Kit({ user: 'tester' });
  assert.deepEqual(kit.check().errors.filter((e) => !e.startsWith('tasks/')), []);
});

test('check: unlinked KB page', () => {
  const kit = tempKit();
  fs.writeFileSync(path.join(kit.root, 'kb/runbooks/x.md'), '---\nkb_id: x\ntitle: X\nstatus: draft\nlast_reviewed: 2026-01-01\nsource_anchors: []\n---\n# X\n');
  const { errors } = kit.check();
  assert.ok(errors.some((e) => /kb\/runbooks\/x\.md: KB page is not linked/.test(e)), errors.join('\n'));
});

test('check: bad KB front matter', () => {
  const kit = tempKit();
  fs.appendFileSync(path.join(kit.root, 'kb/README.md'), '\n- [Bad](runbooks/bad.md)\n- [Plain](runbooks/plain.md)\n');
  fs.writeFileSync(path.join(kit.root, 'kb/runbooks/bad.md'), '---\nkb_id: bad\ntitle: Bad\nstatus: maybe\nlast_reviewed: yesterday\nsource_anchors: [nocolon]\n---\n# Bad\n');
  fs.writeFileSync(path.join(kit.root, 'kb/runbooks/plain.md'), '# No front matter\n');
  const { errors } = kit.check();
  assert.ok(errors.some((e) => /bad\.md: status "maybe"/.test(e)));
  assert.ok(errors.some((e) => /bad\.md: last_reviewed/.test(e)));
  assert.ok(errors.some((e) => /bad\.md: source anchor "nocolon"/.test(e)));
  assert.ok(errors.some((e) => /plain\.md: front matter is missing/.test(e)));
});

test('check: anchors are verified when the repo is cloned, else counted as not checked', () => {
  const kit = tempKit({ repos: 'repos:\n  - {name: svc, url: "u", owner: ours, purpose: p, branch: main}\n' });
  fs.appendFileSync(path.join(kit.root, 'kb/README.md'), '\n- [A](code/a.md)\n');
  fs.mkdirSync(path.join(kit.root, 'kb/code'), { recursive: true });
  fs.writeFileSync(path.join(kit.root, 'kb/code/a.md'), '---\nkb_id: a\ntitle: A\nstatus: draft\nlast_reviewed: 2026-01-01\nsource_anchors: ["svc:src/a.js", "ghost:x.js"]\n---\n# A\n');
  let r = kit.check();
  assert.equal(r.stats.anchorsNotChecked, 1);
  assert.ok(r.errors.some((e) => /unknown repo "ghost"/.test(e)));
  fs.mkdirSync(path.join(kit.reposDir, 'svc/.git'), { recursive: true });
  r = kit.check();
  assert.ok(r.errors.some((e) => /path does not exist in svc/.test(e)));
  fs.mkdirSync(path.join(kit.reposDir, 'svc/src'), { recursive: true });
  fs.writeFileSync(path.join(kit.reposDir, 'svc/src/a.js'), '');
  r = kit.check();
  assert.equal(r.stats.anchorsChecked, 1);
});

test('check: personal absolute paths and broken links', () => {
  const kit = tempKit();
  fs.writeFileSync(path.join(kit.root, 'NOTES.md'), `See ${'C:' + '\\Users\\bob'}\\x and [gone](missing.md) and [ok](kb/README.md) and \`[code](nope.md)\`.\n`);
  fs.writeFileSync(path.join(kit.root, 'run.txt'), `cd ${'/ho' + 'me/bob'}/repo\n`);
  const { errors } = kit.check();
  assert.ok(errors.some((e) => /NOTES\.md: personal absolute path/.test(e)));
  assert.ok(errors.some((e) => /run\.txt: personal absolute path/.test(e)));
  assert.ok(errors.some((e) => /NOTES\.md: broken link: missing\.md/.test(e)));
  assert.ok(!errors.some((e) => /nope\.md|kb\/README/.test(e)));
});

test('check: bad playbook shape and bad task.yaml', () => {
  const kit = tempKit();
  fs.writeFileSync(path.join(kit.root, 'playbooks/bug/playbook.yaml'), `id: wrong
title: T
summary: S
stages:
  - use: nope
  - use: intake
  - use: intake
  - id: x
    title: X
    template: missing.md
    gate: maybe
    requires: [{id: r}]
`);
  let { errors } = kit.check();
  assert.ok(errors.some((e) => /must equal the folder name/.test(e)));
  assert.ok(errors.some((e) => /unknown shared stage "nope"/.test(e)));
  assert.ok(errors.some((e) => /duplicate stage id "intake"/.test(e)));
  assert.ok(errors.some((e) => /gate must be/.test(e)));
  assert.ok(errors.some((e) => /template not found/.test(e)));
  assert.ok(errors.some((e) => /needs id and text/.test(e)));

  const k2 = tempKit();
  fs.mkdirSync(path.join(k2.root, 'tasks/PROJ-1'));
  fs.writeFileSync(path.join(k2.root, 'tasks/PROJ-1/task.yaml'), `key: PROJ-2
title: T
type: bug
created: x
stage: nowhere
state: sleeping
repos: [ghost]
from: PROJ-9
met: {bogus: x}
history:
  - {at: x, by: u, via: web, event: exploded, stage: intake}
`);
  ({ errors } = k2.check());
  for (const re of [/must equal the folder name/, /state "sleeping"/, /unknown repo "ghost"/, /"from" task "PROJ-9"/, /stage "nowhere"/, /unknown requirement "bogus"/, /via must be/, /unknown event "exploded"/]) {
    assert.ok(errors.some((e) => re.test(e)), `expected ${re}`);
  }
});

test('doctor reports each check with a fix for failures', () => {
  const kit = tempKit({ repos: 'repos:\n  - {name: svc, url: "u", owner: ours, purpose: p, branch: main}\n' });
  const checks = kit.doctor();
  const by = (n) => checks.find((c) => c.name === n);
  assert.equal(by('node').ok, true);
  assert.equal(by('yaml dependency').ok, true);
  assert.equal(by('repo svc').ok, false);
  assert.match(by('repo svc').fix, /repos clone/);
  assert.equal(by('assistant file AGENTS.md').ok, false);
  assert.match(by('assistant file AGENTS.md').fix, /AGENTS\.md/);
  const real = new Kit({ user: 'tester' }).doctor();
  assert.ok(real.filter((c) => c.name.startsWith('assistant file')).every((c) => c.ok));
});

test('repos where / workspace on an empty and a cloned repo list', () => {
  const kit = tempKit({ repos: 'repos:\n  - {name: svc, url: "u", owner: ours, purpose: p, branch: main}\n' });
  assert.equal(kit.reposWhere('svc')[0].cloned, false);
  assert.throws(() => kit.reposWhere('ghost'), /unknown repo/);
  fs.mkdirSync(path.join(kit.reposDir, 'svc/.git'), { recursive: true });
  assert.equal(kit.reposWhere('svc')[0].cloned, true);
  const w = kit.workspace();
  assert.equal(JSON.parse(fs.readFileSync(w.file, 'utf8')).folders.length, 2);
});

// ----- watch -----

test('isPersonEvent: reviews and human steps wake the watcher, agent steps do not', () => {
  for (const event of ['approved', 'rejected', 'skipped', 'waiting', 'resumed']) assert.ok(isPersonEvent({ event, via: 'cli' }));
  assert.ok(isPersonEvent({ event: 'advanced', via: 'ui' }));
  for (const event of ['created', 'advanced', 'review-requested', 'blocked', 'met', 'done']) assert.equal(isPersonEvent({ event, via: 'cli' }), false);
});

test('watch: fires on a review, ignores the agent’s own steps, filters by key', async () => {
  const kit = tempKit();
  newBug(kit, 'one-a');
  newBug(kit, 'two-b');
  advanceTo(kit, 'one-a', 'root-cause');
  advanceTo(kit, 'two-b', 'root-cause');
  fillOutput(kit, 'one-a');
  fillOutput(kit, 'two-b');
  kit.next('two-b');

  let step = 0;
  const sleep = async () => {
    step++;
    if (step === 1) kit.next('one-a');            // agent step: must not wake
    if (step === 2) kit.review('two-b', 'approve'); // person on another key
    if (step === 3) kit.review('one-a', 'reject', 'needs an anchor');
  };
  const r = await kit.watch({ key: 'one-a', timeout: 60, interval: 0, sleep });
  assert.equal(r.outcome, 'event');
  assert.equal(r.key, 'one-a');
  assert.equal(r.event.event, 'rejected');
  assert.equal(r.event.note, 'needs an anchor');
  assert.equal(r.next, 'node kit.js task status one-a');
  assert.equal(step, 3);
});

test('watch without a key sees any task; ui events wake it; timeout returns', async () => {
  const kit = tempKit();
  newBug(kit, 'one-a');
  const ui = new Kit({ root: kit.root, user: 'tester', via: 'ui', reposDir: kit.reposDir });
  let n = 0;
  const r = await kit.watch({ timeout: 60, interval: 0, sleep: async () => { if (++n === 1) ui.wait('one-a', 'logs'); } });
  assert.equal(r.key, 'one-a');
  assert.equal(r.event.via, 'ui');

  const t = await kit.watch({ key: 'one-a', timeout: 0.01, interval: 5 });
  assert.equal(t.outcome, 'timeout');
  await assert.rejects(() => kit.watch({ key: 'ghost-1', timeout: 1 }), /no task/);
});
