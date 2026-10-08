import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kit } from '../kit.js';

export const REAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A temp kit root with a copy of playbooks/ and kb/ and an empty tasks/ folder.
export function tempRoot({ repos = 'repos: []\n' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-test-'));
  fs.cpSync(path.join(REAL_ROOT, 'playbooks'), path.join(root, 'playbooks'), { recursive: true });
  fs.cpSync(path.join(REAL_ROOT, 'kb'), path.join(root, 'kb'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tasks'));
  fs.writeFileSync(path.join(root, 'repos.yaml'), repos);
  return root;
}

export function tempKit(opts = {}) {
  const { repos, ...rest } = opts;
  const root = tempRoot({ repos });
  return new Kit({ root, user: 'tester', reposDir: path.join(root, 'repos'), ...rest });
}

const CLAIMS = '| Claim | Kind | Anchor |\n|---|---|---|\n| It fails | measured | npm test |\n| It is old | inferred | |\n';

// Fill every section of a stage output with text. Claims stages also get a valid table.
export function fillOutput(kit, key, extra = {}) {
  const st = kit.status(key);
  const file = path.join(kit.root, st.stage.output);
  let md = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, 'Filled in.');
  if (st.stage.claims) md = md.replace(/(\| Claim \| Kind \| Anchor \|\n\|[-| ]+\|\n)/, `$1${CLAIMS.split('\n').slice(2).join('\n')}`);
  fs.writeFileSync(file, md);
  return extra.after ? extra.after(file) : file;
}

// Drive a task until it reaches the given stage id (approving reviews).
export function advanceTo(kit, key, stageId) {
  for (let i = 0; i < 20 && kit.status(key).stage.id !== stageId; i++) {
    const s = kit.status(key);
    if (s.state === 'blocked') for (const r of s.unmet) kit.meet(key, r.id, 'evidence');
    fillOutput(kit, key);
    const r = kit.next(key);
    if (r.outcome === 'review-requested') kit.review(key, 'approve');
  }
}
