import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { Kit } from '../kit.js';
import { startUi, renderMarkdown } from '../ui.js';
import { tempRoot, fillOutput, advanceTo, REAL_ROOT } from './helpers.js';

let server;
let base;
let kit;

before(async () => {
  const root = tempRoot();
  kit = new Kit({ root, user: 'tester', via: 'ui', reposDir: path.join(root, 'repos') });
  ({ server, url: base } = await startUi({ kit, port: 0, htmlFile: path.join(REAL_ROOT, 'ui.html') }));
});
after(() => server.close());

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const post = async (p, body = {}, headers = {}) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

test('serves the page and lists types and tasks', async () => {
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>agent-flow-kit<\/title>/);
  assert.deepEqual((await get('/api/types')).body, ['bug', 'support']);
  assert.deepEqual((await get('/api/tasks')).body, []);
});

test('create, status, next, reject, approve through the API record via: ui', async () => {
  let r = await post('/api/tasks', { key: 'ui-bug', title: 'From the UI', type: 'bug' });
  assert.equal(r.status, 201);
  assert.equal(r.body.stage.id, 'intake');

  r = await post('/api/tasks/ui-bug/next');
  assert.equal(r.body.outcome, 'refused');

  advanceTo(kit, 'ui-bug', 'root-cause');
  fillOutput(kit, 'ui-bug');
  r = await post('/api/tasks/ui-bug/next');
  assert.equal(r.body.outcome, 'review-requested');

  r = await post('/api/tasks/ui-bug/reject', { note: 'no anchor' });
  assert.equal(r.body.rejection, 'no anchor');
  r = await post('/api/tasks/ui-bug/next');
  r = await post('/api/tasks/ui-bug/approve', {});
  assert.equal(r.body.stage.id, 'fix');

  r = await get('/api/tasks/ui-bug');
  assert.equal(r.status, 200);
  assert.ok(r.body.outputs.find((o) => o.stage === 'root-cause').html.includes('<tr class="inferred">'));
  const hist = kit.loadTask('ui-bug').history;
  assert.ok(hist.every((e) => e.via === 'ui'));
  assert.ok(hist.some((e) => e.event === 'rejected'));
});

test('wait, resume, skip, meet and errors', async () => {
  await post('/api/tasks', { key: 'ui-two', title: 'Two', type: 'bug' });
  assert.equal((await post('/api/tasks/ui-two/wait', { on: 'logs' })).body.state, 'waiting');
  assert.equal((await post('/api/tasks/ui-two/resume')).body.state, 'in-progress');
  assert.equal((await post('/api/tasks/ui-two/skip', { reason: 'ok' })).body.stage.id, 'reproduce');
  assert.equal((await post('/api/tasks/ui-two/meet', { requirement: 'pr-opened', evidence: 'PR 1' })).status, 200);

  assert.equal((await post('/api/tasks/ui-two/skip', {})).status, 400);
  assert.equal((await get('/api/tasks/ghost-1')).status, 404);
  assert.equal((await post('/api/tasks/ui-two/explode')).status, 404);
  assert.equal((await post('/api/tasks', { key: 'bad key', title: 't', type: 'bug' })).status, 400);
});

test('rejects foreign hosts, foreign origins and non-JSON posts', async () => {
  const port = new URL(base).port;
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/tasks', headers: { Host: 'evil.example:80' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(status, 403);
  assert.equal((await post('/api/tasks/ui-two/wait', { on: 'x' }, { Origin: 'http://evil.example' })).status, 403);
  const form = await fetch(base + '/api/tasks/ui-two/wait', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"on":"x"}' });
  assert.equal(form.status, 415);
});

test('renderMarkdown escapes HTML, drops comments and highlights inferred claims', () => {
  const html = renderMarkdown('# T <b>\n\n<!-- hidden -->\n\ntext **bold** `c`\n\n| Claim | Kind | Anchor |\n|---|---|---|\n| a | inferred | |\n| b | measured | x |\n\n- one\n- two\n');
  assert.ok(html.includes('&lt;b&gt;'));
  assert.ok(!html.includes('hidden'));
  assert.ok(html.includes('<strong>bold</strong>') && html.includes('<code>c</code>'));
  assert.ok(html.includes('<tr class="inferred">') && html.includes('<tr class="measured">'));
  assert.ok(html.includes('<ul><li>one</li><li>two</li></ul>'));
});
