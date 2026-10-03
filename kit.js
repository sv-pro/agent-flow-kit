#!/usr/bin/env node
// agent-flow-kit CLI: playbooks, task state, KB checks. Files and git only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

let YAML = null;
try {
  const mod = await import('yaml');
  YAML = mod.default ?? mod;
} catch {
  // doctor reports the missing dependency
}

const KIT_ROOT = path.dirname(fileURLToPath(import.meta.url));

export const STATES = ['in-progress', 'awaiting-review', 'blocked', 'waiting', 'done'];
export const EVENTS = [
  'created', 'advanced', 'review-requested', 'approved', 'rejected',
  'blocked', 'met', 'waiting', 'resumed', 'skipped', 'done',
];
export const VIAS = ['cli', 'ui'];
export const KINDS = ['measured', 'inferred', 'decision'];
export const GATES = ['none', 'review'];
const PERSON_EVENTS = new Set(['approved', 'rejected', 'skipped', 'waiting', 'resumed']);
const KB_STATUSES = ['draft', 'reviewed'];
const ASSISTANT_FILES = [
  'AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md',
  '.github/prompts/task.prompt.md', '.claude/skills/task/SKILL.md', '.claude/settings.json',
];

export class KitError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'KitError';
    this.status = status;
  }
}

// ---------- pure helpers ----------

export const KEY_RE = /^([A-Z][A-Z0-9]*-\d+|[a-z0-9]+(-[a-z0-9]+)*)$/;

export function validateKey(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    throw new KitError(`invalid task key "${key ?? ''}": use a ticket key like PROJ-123 or a lowercase slug like demo-bug`);
  }
  return key;
}

export function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function renderTemplate(template, vars) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export function stripComments(md) {
  let out = '';
  let i = 0;
  for (;;) {
    const open = md.indexOf('<!--', i);
    if (open < 0) return out + md.slice(i);
    out += md.slice(i, open);
    const close = md.indexOf('-->', open + 4);
    if (close < 0) return out;
    i = close + 3;
  }
}

export function parseSections(md) {
  const sections = [];
  let cur = null;
  let fenced = false;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const m = !fenced && line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) {
      cur = { level: m[1].length, title: m[2], lines: [] };
      sections.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  return sections.map((s) => ({ level: s.level, title: s.title, body: s.lines.join('\n') }));
}

const PLACEHOLDER_RE = /\{\{[^}]*\}\}/g;
const norm = (s) => s.trim().toLowerCase();

// Problems with the headings of an output: missing, empty, comment-only or placeholder-only.
export function checkSections(md, required = []) {
  const sections = parseSections(stripComments(md));
  const problems = [];
  const isEmpty = (s) => s.body.replace(PLACEHOLDER_RE, '').trim() === '';
  for (const title of required) {
    const found = sections.filter((s) => norm(s.title) === norm(title));
    if (!found.length) problems.push(`missing section: ${title}`);
    else if (found.every(isEmpty)) problems.push(`section is empty (only the template comment or a {{placeholder}}): ${title}`);
  }
  const requiredSet = new Set(required.map(norm));
  for (const s of sections) {
    if (s.level >= 2 && !requiredSet.has(norm(s.title)) && isEmpty(s)) {
      problems.push(`section is empty (only the template comment or a {{placeholder}}): ${s.title}`);
    }
  }
  return problems;
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
}

export function parseTables(md) {
  const lines = stripComments(md).split('\n');
  const tables = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith('|')) continue;
    if (!/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) continue;
    const header = splitRow(lines[i]);
    const rows = [];
    let j = i + 2;
    while (j < lines.length && lines[j].trim().startsWith('|')) rows.push(splitRow(lines[j++]));
    tables.push({ header, rows });
    i = j - 1;
  }
  return tables;
}

const EMPTY_ANCHOR = /^(|-|--|n\/a|none|tbd|todo|\{\{.*\}\})$/i;

export function validateClaims(md) {
  const table = parseTables(md).find((t) => t.header.some((h) => norm(h) === 'kind'));
  if (!table) return ['claims table missing: add a table with the columns Claim | Kind | Anchor'];
  const col = (name) => table.header.findIndex((h) => norm(h) === name);
  const [ci, ki, ai] = [col('claim'), col('kind'), col('anchor')];
  if (ci < 0 || ai < 0) return ['claims table needs the columns Claim | Kind | Anchor'];
  if (!table.rows.length) return ['claims table has no rows'];
  const problems = [];
  table.rows.forEach((row, n) => {
    const at = `claim ${n + 1}`;
    const kind = norm(row[ki] ?? '');
    if (!(row[ci] ?? '').trim()) problems.push(`${at}: claim text is empty`);
    if (!KINDS.includes(kind)) problems.push(`${at}: kind "${row[ki] ?? ''}" must be one of ${KINDS.join(', ')}`);
    else if (kind === 'measured' && EMPTY_ANCHOR.test((row[ai] ?? '').trim())) {
      problems.push(`${at}: measured claim needs an anchor someone else can re-run (a command, test, query or file)`);
    }
  });
  return problems;
}

export function parseFrontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: null, body: text };
  try {
    return { data: YAML.parse(m[1]) ?? {}, body: m[2] };
  } catch (e) {
    return { data: null, body: m[2], error: e.message.split('\n')[0] };
  }
}

export function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-v') flags.v = true;
    else if (a.startsWith('--')) {
      const m = a.slice(2).match(/^([^=]+)=([\s\S]*)$/);
      if (m) flags[m[1]] = m[2];
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

export function isPersonEvent(ev) {
  return PERSON_EVENTS.has(ev.event) || ev.via === 'ui';
}

// Personal absolute paths. Built from pieces so this file does not match itself.
const PERSONAL_PATH_RE = new RegExp(['[A-Za-z]:\\\\Users\\\\', '/ho' + 'me/', '/Us' + 'ers/'].join('|'));

// ---------- Kit ----------

export class Kit {
  constructor(opts = {}) {
    if (!YAML) throw new KitError('the "yaml" dependency is missing: run npm ci');
    this.root = path.resolve(opts.root ?? KIT_ROOT);
    this.playbooksDir = path.join(this.root, 'playbooks');
    this.kbDir = path.join(this.root, 'kb');
    this.tasksDir = path.join(this.root, 'tasks');
    this.reposFile = path.join(this.root, 'repos.yaml');
    this.reposDir = path.resolve(opts.reposDir ?? process.env.KIT_REPOS_DIR ?? path.join(this.root, 'repos'));
    this.via = opts.via ?? 'cli';
    this.user = opts.user;
  }

  // ----- identity -----
  gitUser() {
    if (this.user) return this.user;
    try {
      const out = execFileSync('git', ['config', 'user.name'], { cwd: this.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (out) return out;
    } catch { /* fall through */ }
    return process.env.USER || process.env.USERNAME || 'unknown';
  }

  // ----- playbooks -----
  listTypes() {
    if (!fs.existsSync(this.playbooksDir)) return [];
    return fs.readdirSync(this.playbooksDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_') && fs.existsSync(path.join(this.playbooksDir, d.name, 'playbook.yaml')))
      .map((d) => d.name).sort();
  }

  loadShared() {
    const file = path.join(this.playbooksDir, '_shared', 'stages.yaml');
    if (!fs.existsSync(file)) return new Map();
    const doc = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
    return new Map((doc.stages ?? []).map((s) => [s.id, s]));
  }

  loadPlaybook(type) {
    const dir = path.join(this.playbooksDir, String(type));
    const file = path.join(dir, 'playbook.yaml');
    if (!/^[\w-]+$/.test(String(type)) || !fs.existsSync(file)) {
      throw new KitError(`unknown type "${type}" (known: ${this.listTypes().join(', ') || 'none'})`);
    }
    const doc = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
    const shared = this.loadShared();
    const sharedDir = path.join(this.playbooksDir, '_shared', 'templates');
    const stages = (doc.stages ?? []).map((raw, i) => {
      let stage;
      let templateDir = path.join(dir, 'templates');
      if (raw.use) {
        const base = shared.get(raw.use);
        if (!base) throw new KitError(`playbook ${type}: stage ${i + 1} uses unknown shared stage "${raw.use}"`);
        const { use, ...over } = raw;
        stage = { ...base, ...over };
        if (!over.template) templateDir = sharedDir;
      } else {
        stage = { ...raw };
      }
      return {
        gate: 'none', requires: [], claims: false, exit_criteria: [], instructions: '',
        ...stage, index: i, templateDir, output: `${String(i + 1).padStart(2, '0')}-${stage.id}.md`,
      };
    });
    return { id: doc.id, title: doc.title, summary: doc.summary, stages, dir };
  }

  templatePath(stage) {
    return path.join(stage.templateDir, stage.template ?? '');
  }

  requiredSections(stage) {
    if (Array.isArray(stage.required_sections)) return stage.required_sections;
    const tpl = this.templatePath(stage);
    if (!fs.existsSync(tpl)) return [];
    return parseSections(stripComments(fs.readFileSync(tpl, 'utf8'))).filter((s) => s.level >= 2).map((s) => s.title);
  }

  // ----- task files -----
  taskDir(key) { return path.join(this.tasksDir, validateKey(key)); }
  taskFile(key) { return path.join(this.taskDir(key), 'task.yaml'); }
  outputRel(key, stage) { return `tasks/${key}/${stage.output}`; }

  loadTask(key) {
    const file = this.taskFile(key);
    if (!fs.existsSync(file)) throw new KitError(`no task "${key}"`, 404);
    return YAML.parse(fs.readFileSync(file, 'utf8'));
  }

  saveTask(t) {
    fs.mkdirSync(this.taskDir(t.key), { recursive: true });
    fs.writeFileSync(this.taskFile(t.key), YAML.stringify(t, { lineWidth: 0 }));
  }

  record(t, event, extra = {}) {
    const ev = { at: utcNow(), by: this.gitUser(), via: this.via, event, stage: t.stage };
    for (const k of ['note', 'requirement', 'on']) if (extra[k]) ev[k] = extra[k];
    t.history.push(ev);
  }

  unmet(t, stage) {
    return stage.requires.filter((r) => !t.met?.[r.id]);
  }

  enterStage(t, pb, index) {
    const stage = pb.stages[index];
    t.stage = stage.id;
    const out = path.join(this.taskDir(t.key), stage.output);
    if (!fs.existsSync(out) && stage.template && fs.existsSync(this.templatePath(stage))) {
      const tpl = fs.readFileSync(this.templatePath(stage), 'utf8');
      fs.mkdirSync(this.taskDir(t.key), { recursive: true });
      fs.writeFileSync(out, renderTemplate(tpl, { key: t.key, title: t.title, type: t.type, created: t.created }));
    }
    const unmet = this.unmet(t, stage);
    if (unmet.length) {
      t.state = 'blocked';
      for (const r of unmet) this.record(t, 'blocked', { requirement: r.id, note: r.text });
    } else {
      t.state = 'in-progress';
    }
  }

  advance(t, pb) {
    const idx = pb.stages.findIndex((s) => s.id === t.stage);
    if (idx === pb.stages.length - 1) {
      t.state = 'done';
      this.record(t, 'done');
    } else {
      this.enterStage(t, pb, idx + 1);
    }
  }

  current(t) {
    const pb = this.loadPlaybook(t.type);
    const stage = pb.stages.find((s) => s.id === t.stage);
    if (!stage) throw new KitError(`task ${t.key}: stage "${t.stage}" is not in playbook ${t.type}`);
    return { pb, stage };
  }

  // ----- task lifecycle -----
  listTasks() {
    if (!fs.existsSync(this.tasksDir)) return [];
    return fs.readdirSync(this.tasksDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(this.tasksDir, d.name, 'task.yaml')))
      .map((d) => YAML.parse(fs.readFileSync(path.join(this.tasksDir, d.name, 'task.yaml'), 'utf8')))
      .map((t) => ({ key: t.key, title: t.title, type: t.type, stage: t.stage, state: t.state, from: t.from }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  createTask({ key, title, type, repos = [], from } = {}) {
    validateKey(key);
    if (!title || title === true) throw new KitError('--title is required');
    if (!type || type === true) throw new KitError(`--type is required (known: ${this.listTypes().join(', ')})`);
    if (fs.existsSync(this.taskFile(key))) throw new KitError(`task "${key}" already exists`);
    const pb = this.loadPlaybook(type);
    if (!pb.stages.length) throw new KitError(`playbook ${type} has no stages`);
    const known = this.loadRepos().map((r) => r.name);
    for (const r of repos) if (!known.includes(r)) throw new KitError(`unknown repo "${r}" (see repos.yaml; known: ${known.join(', ') || 'none'})`);
    if (from) {
      validateKey(from);
      if (!fs.existsSync(this.taskFile(from))) throw new KitError(`--from: no task "${from}"`);
    }
    const t = { key, title, type, created: utcNow(), stage: pb.stages[0].id, state: 'in-progress', repos };
    if (from) t.from = from;
    t.met = {};
    t.history = [];
    this.record(t, 'created');
    this.enterStage(t, pb, 0);
    this.saveTask(t);
    return t;
  }

  lastRejection(t) {
    for (let i = t.history.length - 1; i >= 0; i--) {
      const ev = t.history[i];
      if (ev.stage !== t.stage || ev.event === 'review-requested') return null;
      if (ev.event === 'rejected') return ev.note ?? '(no note)';
    }
    return null;
  }

  status(key) {
    const t = this.loadTask(key);
    const { pb, stage } = this.current(t);
    const waitEv = [...t.history].reverse().find((e) => e.event === 'waiting');
    return {
      key: t.key, title: t.title, type: t.type, state: t.state, from: t.from ?? null,
      stage: {
        id: stage.id, title: stage.title, position: stage.index + 1, total: pb.stages.length,
        gate: stage.gate, claims: stage.claims, instructions: String(stage.instructions).trim(),
        exit_criteria: stage.exit_criteria, output: this.outputRel(t.key, stage),
      },
      unmet: this.unmet(t, stage),
      met: t.met ?? {},
      rejection: this.lastRejection(t),
      waitingOn: t.state === 'waiting' ? waitEv?.on ?? null : null,
      repos: t.repos.map((name) => this.repoInfo(name)),
    };
  }

  outputs(key) {
    const t = this.loadTask(key);
    const { pb } = this.current(t);
    return pb.stages.map((s) => {
      const file = path.join(this.taskDir(key), s.output);
      const exists = fs.existsSync(file);
      return { stage: s.id, title: s.title, file: this.outputRel(key, s), current: s.id === t.stage, exists, content: exists ? fs.readFileSync(file, 'utf8') : '' };
    });
  }

  validateOutput(t, stage) {
    const file = path.join(this.taskDir(t.key), stage.output);
    if (!fs.existsSync(file)) return [`output file is missing: ${this.outputRel(t.key, stage)}`];
    const md = fs.readFileSync(file, 'utf8');
    const problems = checkSections(md, this.requiredSections(stage));
    if (stage.claims) problems.push(...validateClaims(md));
    return problems;
  }

  next(key) {
    const t = this.loadTask(key);
    const { pb, stage } = this.current(t);
    if (t.state === 'done') return { outcome: 'done' };
    if (t.state === 'awaiting-review') return { outcome: 'awaiting-review' };
    if (t.state === 'waiting') return { outcome: 'waiting', on: this.status(key).waitingOn };
    if (t.state === 'blocked') {
      const unmet = this.unmet(t, stage);
      if (unmet.length) return { outcome: 'blocked', unmet };
      t.state = 'in-progress';
      this.record(t, 'resumed', { note: 'requirements met' });
    }
    const problems = this.validateOutput(t, stage);
    if (problems.length) {
      this.saveTask(t);
      return { outcome: 'refused', problems, output: this.outputRel(t.key, stage) };
    }
    if (stage.gate === 'review') {
      t.state = 'awaiting-review';
      this.record(t, 'review-requested');
      this.saveTask(t);
      return { outcome: 'review-requested', stage: stage.id };
    }
    this.record(t, 'advanced');
    this.advance(t, pb);
    this.saveTask(t);
    return { outcome: t.state === 'done' ? 'done' : 'advanced', stage: t.stage, state: t.state };
  }

  review(key, decision, note) {
    if (!['approve', 'reject'].includes(decision)) throw new KitError('review decision must be approve or reject');
    const t = this.loadTask(key);
    const { pb } = this.current(t);
    if (t.state !== 'awaiting-review') throw new KitError(`task ${key} is not awaiting review (state: ${t.state})`);
    if (decision === 'reject') {
      if (!note || note === true || !String(note).trim()) throw new KitError('a rejection needs a note: say what is wrong (--note)');
      t.state = 'in-progress';
      this.record(t, 'rejected', { note: note === true ? '' : note });
    } else {
      this.record(t, 'approved', { note: note === true ? '' : note });
      this.advance(t, pb);
    }
    this.saveTask(t);
    return this.status(key);
  }

  meet(key, requirement, evidence) {
    const t = this.loadTask(key);
    const { pb, stage } = this.current(t);
    if (t.state === 'done') throw new KitError(`task ${key} is done`);
    const ids = pb.stages.flatMap((s) => s.requires.map((r) => r.id));
    if (!ids.includes(requirement)) throw new KitError(`unknown requirement "${requirement}" (known for ${t.type}: ${[...new Set(ids)].join(', ') || 'none'})`);
    if (!evidence || evidence === true || !String(evidence).trim()) throw new KitError('--evidence is required: give a link, id or command output that shows it is met');
    t.met = { ...(t.met ?? {}), [requirement]: String(evidence) };
    this.record(t, 'met', { requirement, note: String(evidence) });
    if (t.state === 'blocked' && !this.unmet(t, stage).length) t.state = 'in-progress';
    this.saveTask(t);
    return this.status(key);
  }

  wait(key, on) {
    const t = this.loadTask(key);
    if (t.state === 'done') throw new KitError(`task ${key} is done`);
    if (!on || on === true) throw new KitError('--on is required: say what the task waits on');
    t.state = 'waiting';
    this.record(t, 'waiting', { on });
    this.saveTask(t);
    return this.status(key);
  }

  resume(key) {
    const t = this.loadTask(key);
    const { stage } = this.current(t);
    if (t.state !== 'waiting') throw new KitError(`task ${key} is not waiting (state: ${t.state})`);
    t.state = this.unmet(t, stage).length ? 'blocked' : 'in-progress';
    this.record(t, 'resumed');
    this.saveTask(t);
    return this.status(key);
  }

  skip(key, reason) {
    const t = this.loadTask(key);
    const { pb } = this.current(t);
    if (t.state === 'done') throw new KitError(`task ${key} is done`);
    if (!reason || reason === true) throw new KitError('--reason is required');
    this.record(t, 'skipped', { note: reason });
    this.advance(t, pb);
    this.saveTask(t);
    return this.status(key);
  }

  // ----- watch -----
  snapshot(key) {
    const keys = key ? [validateKey(key)] : this.listTasks().map((t) => t.key);
    const snap = new Map();
    for (const k of keys) snap.set(k, this.loadTask(k).history.length);
    return snap;
  }

  newPersonEvent(snap, key) {
    const keys = key ? [key] : this.listTasks().map((t) => t.key);
    for (const k of keys) {
      const hist = this.loadTask(k).history;
      for (let i = snap.get(k) ?? 0; i < hist.length; i++) {
        if (isPersonEvent(hist[i])) return { key: k, event: hist[i], next: `node kit.js task status ${k}` };
      }
    }
    return null;
  }

  async watch({ key, timeout = 1800, interval = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    if (key) this.loadTask(key);
    const snap = this.snapshot(key);
    const started = Date.now();
    for (;;) {
      const found = this.newPersonEvent(snap, key);
      if (found) return { outcome: 'event', ...found };
      if (timeout && Date.now() - started >= timeout * 1000) return { outcome: 'timeout' };
      await sleep(interval);
    }
  }

  // ----- repos -----
  loadRepos() {
    if (!fs.existsSync(this.reposFile)) return [];
    const doc = YAML.parse(fs.readFileSync(this.reposFile, 'utf8')) ?? {};
    return Array.isArray(doc.repos) ? doc.repos : [];
  }

  repoPath(name) { return path.join(this.reposDir, name); }

  git(dir, args) {
    try {
      return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { return null; }
  }

  repoInfo(name) {
    const r = this.loadRepos().find((x) => x.name === name) ?? { name };
    const dir = this.repoPath(name);
    const cloned = fs.existsSync(path.join(dir, '.git'));
    return {
      name, owner: r.owner ?? null, purpose: r.purpose ?? null, productionBranch: r.branch ?? null,
      path: dir, cloned, branch: cloned ? this.git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']) : null,
    };
  }

  reposWhere(name) {
    const all = this.loadRepos().map((r) => this.repoInfo(r.name));
    if (!name) return all;
    const one = all.find((r) => r.name === name);
    if (!one) throw new KitError(`unknown repo "${name}" (known: ${all.map((r) => r.name).join(', ') || 'none'})`);
    return [one];
  }

  reposClone() {
    fs.mkdirSync(this.reposDir, { recursive: true });
    return this.loadRepos().map((r) => {
      const info = this.repoInfo(r.name);
      if (info.cloned) return { name: r.name, result: 'already cloned' };
      const args = ['clone', ...(r.branch ? ['--branch', r.branch] : []), r.url, info.path];
      const res = spawnSync('git', args, { stdio: 'inherit' });
      return { name: r.name, result: res.status === 0 ? 'cloned' : 'failed' };
    });
  }

  reposStatus() {
    return this.reposWhere().map((r) => ({
      ...r, dirty: r.cloned ? (this.git(r.path, ['status', '--porcelain']) ?? '') !== '' : null,
    }));
  }

  reposPull() {
    return this.reposWhere().map((r) => {
      if (!r.cloned) return { name: r.name, result: 'not cloned' };
      const res = spawnSync('git', ['-C', r.path, 'pull', '--ff-only'], { stdio: 'inherit' });
      return { name: r.name, branch: r.branch, result: res.status === 0 ? 'pulled' : 'failed' };
    });
  }

  workspace() {
    const folders = [{ name: 'kit', path: this.root }, ...this.reposWhere().filter((r) => r.cloned).map((r) => ({ name: r.name, path: r.path }))];
    fs.mkdirSync(this.reposDir, { recursive: true });
    const file = path.join(this.reposDir, 'agent-flow-kit.code-workspace');
    fs.writeFileSync(file, JSON.stringify({ folders }, null, 2) + '\n');
    return { file, folders };
  }

  // ----- check -----
  walkFiles(dir = this.root, top = true) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules' || (top && e.name === 'repos')) continue;
        out.push(...this.walkFiles(path.join(dir, e.name), false));
      } else if (e.isFile() && e.name !== '.env' && e.name !== 'settings.local.json') {
        out.push(path.join(dir, e.name));
      }
    }
    return out;
  }

  check() {
    const errors = [];
    const ok = [];
    const stats = { anchorsChecked: 0, anchorsNotChecked: 0 };
    const rel = (f) => path.relative(this.root, f).split(path.sep).join('/');
    const err = (file, msg) => errors.push(`${file}: ${msg}`);
    const readYaml = (file) => {
      try { return YAML.parse(fs.readFileSync(file, 'utf8')); } catch (e) { err(rel(file), `invalid YAML: ${e.message.split('\n')[0]}`); return undefined; }
    };

    // repos.yaml
    const repos = this.loadRepos();
    const repoNames = new Set();
    for (const r of repos) {
      for (const f of ['name', 'url', 'owner', 'purpose', 'branch']) if (!r[f]) err('repos.yaml', `repo "${r.name ?? '?'}" is missing "${f}"`);
      if (repoNames.has(r.name)) err('repos.yaml', `duplicate repo "${r.name}"`);
      repoNames.add(r.name);
    }

    // playbooks
    const shared = this.loadShared();
    const checkStage = (where, s, dir, requireTemplate = true) => {
      for (const f of ['id', 'title']) if (!s[f]) err(where, `stage is missing "${f}"`);
      if (s.gate !== undefined && !GATES.includes(s.gate)) err(where, `stage ${s.id}: gate must be ${GATES.join(' or ')}`);
      if (s.claims !== undefined && typeof s.claims !== 'boolean') err(where, `stage ${s.id}: claims must be true or false`);
      if (s.requires !== undefined) {
        if (!Array.isArray(s.requires)) err(where, `stage ${s.id}: requires must be a list`);
        else for (const r of s.requires) if (!r?.id || !r?.text) err(where, `stage ${s.id}: each requirement needs id and text`);
      }
      for (const f of ['required_sections', 'exit_criteria']) {
        if (s[f] !== undefined && !(Array.isArray(s[f]) && s[f].every((x) => typeof x === 'string'))) err(where, `stage ${s.id}: ${f} must be a list of strings`);
      }
      if (requireTemplate) {
        if (!s.template) err(where, `stage ${s.id}: missing "template"`);
        else if (!fs.existsSync(path.join(dir, s.template))) err(where, `stage ${s.id}: template not found: ${rel(path.join(dir, s.template))}`);
      }
    };
    const sharedFile = path.join(this.playbooksDir, '_shared', 'stages.yaml');
    if (fs.existsSync(sharedFile)) {
      const doc = readYaml(sharedFile);
      if (doc) {
        if (!Array.isArray(doc.stages)) err(rel(sharedFile), 'needs a "stages" list');
        else for (const s of doc.stages) checkStage(rel(sharedFile), s, path.join(this.playbooksDir, '_shared', 'templates'));
      }
    }
    for (const type of this.listTypes()) {
      const file = path.join(this.playbooksDir, type, 'playbook.yaml');
      const where = rel(file);
      const doc = readYaml(file);
      if (!doc) continue;
      if (doc.id !== type) err(where, `id "${doc.id}" must equal the folder name "${type}"`);
      for (const f of ['title', 'summary']) if (!doc[f]) err(where, `missing "${f}"`);
      if (!Array.isArray(doc.stages) || !doc.stages.length) { err(where, 'needs a non-empty "stages" list'); continue; }
      const ids = new Set();
      const reqIds = new Set();
      for (const raw of doc.stages) {
        let stage = raw;
        let dir = path.join(this.playbooksDir, type, 'templates');
        if (raw.use) {
          const base = shared.get(raw.use);
          if (!base) { err(where, `uses unknown shared stage "${raw.use}"`); continue; }
          const { use, ...over } = raw;
          stage = { ...base, ...over };
          if (!over.template) dir = path.join(this.playbooksDir, '_shared', 'templates');
          for (const f of Object.keys(over)) if (!['id', 'title', 'template', 'gate', 'requires', 'claims', 'required_sections', 'instructions', 'exit_criteria'].includes(f)) err(where, `stage ${raw.use}: unknown override "${f}"`);
        } else {
          checkStage(where, raw, dir);
        }
        if (raw.use) checkStage(where, stage, dir);
        if (ids.has(stage.id)) err(where, `duplicate stage id "${stage.id}"`);
        ids.add(stage.id);
        for (const r of stage.requires ?? []) {
          if (reqIds.has(r.id)) err(where, `duplicate requirement id "${r.id}"`);
          reqIds.add(r.id);
        }
        if (stage.template && fs.existsSync(path.join(dir, stage.template)) && Array.isArray(stage.required_sections)) {
          const titles = parseSections(stripComments(fs.readFileSync(path.join(dir, stage.template), 'utf8'))).map((s) => norm(s.title));
          for (const sec of stage.required_sections) if (!titles.includes(norm(sec))) err(where, `stage ${stage.id}: required section "${sec}" is not in the template`);
        }
        if (stage.claims && stage.template && fs.existsSync(path.join(dir, stage.template))) {
          if (!parseTables(fs.readFileSync(path.join(dir, stage.template), 'utf8')).some((t) => t.header.some((h) => norm(h) === 'kind'))) err(where, `stage ${stage.id}: claims stage template has no claims table`);
        }
      }
      ok.push(`playbook ${type}: ${doc.stages.length} stages`);
    }

    // tasks
    const known = new Set(this.listTypes());
    if (fs.existsSync(this.tasksDir)) {
      for (const d of fs.readdirSync(this.tasksDir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const file = path.join(this.tasksDir, d.name, 'task.yaml');
        const where = rel(file);
        if (!fs.existsSync(file)) { err(rel(path.join(this.tasksDir, d.name)), 'task folder has no task.yaml'); continue; }
        const t = readYaml(file);
        if (!t) continue;
        if (t.key !== d.name) err(where, `key "${t.key}" must equal the folder name "${d.name}"`);
        if (!KEY_RE.test(String(t.key))) err(where, `invalid key "${t.key}"`);
        for (const f of ['title', 'type', 'created', 'stage', 'state']) if (!t[f]) err(where, `missing "${f}"`);
        if (!STATES.includes(t.state)) err(where, `state "${t.state}" must be one of ${STATES.join(', ')}`);
        if (!Array.isArray(t.repos)) err(where, '"repos" must be a list');
        else for (const r of t.repos) if (!repoNames.has(r)) err(where, `unknown repo "${r}"`);
        if (t.from !== undefined && !fs.existsSync(this.taskFile(String(t.from)))) err(where, `"from" task "${t.from}" does not exist`);
        let reqIds = [];
        let stageIds = [];
        if (!known.has(t.type)) err(where, `unknown type "${t.type}"`);
        else {
          try {
            const pb = this.loadPlaybook(t.type);
            stageIds = pb.stages.map((s) => s.id);
            reqIds = pb.stages.flatMap((s) => s.requires.map((r) => r.id));
            if (!stageIds.includes(t.stage)) err(where, `stage "${t.stage}" is not in playbook ${t.type}`);
          } catch (e) { err(where, e.message); }
        }
        for (const k of Object.keys(t.met ?? {})) if (reqIds.length && !reqIds.includes(k)) err(where, `met: unknown requirement "${k}"`);
        if (!Array.isArray(t.history)) err(where, '"history" must be a list');
        else t.history.forEach((ev, i) => {
          const at = `history[${i}]`;
          for (const f of ['at', 'by', 'via', 'event', 'stage']) if (!ev?.[f]) err(where, `${at} is missing "${f}"`);
          if (ev?.event && !EVENTS.includes(ev.event)) err(where, `${at}: unknown event "${ev.event}"`);
          if (ev?.via && !VIAS.includes(ev.via)) err(where, `${at}: via must be ${VIAS.join(' or ')}`);
          if (ev?.stage && stageIds.length && !stageIds.includes(ev.stage)) err(where, `${at}: stage "${ev.stage}" is not in playbook ${t.type}`);
        });
        ok.push(`task ${d.name}`);
      }
    }

    // KB
    const kbIndex = path.join(this.kbDir, 'README.md');
    const linked = new Set();
    if (!fs.existsSync(kbIndex)) err('kb/README.md', 'KB index is missing');
    else {
      for (const target of this.linkTargets(kbIndex)) linked.add(target);
    }
    const kbPages = fs.existsSync(this.kbDir) ? this.walkFiles(this.kbDir, false).filter((f) => f.endsWith('.md') && f !== kbIndex) : [];
    const kbIds = new Set();
    for (const page of kbPages) {
      const where = rel(page);
      if (!linked.has(page)) err(where, 'KB page is not linked from kb/README.md');
      const { data, error } = parseFrontMatter(fs.readFileSync(page, 'utf8'));
      if (!data) { err(where, error ? `front matter is invalid YAML: ${error}` : 'front matter is missing'); continue; }
      for (const f of ['kb_id', 'title', 'status', 'last_reviewed']) if (!data[f]) err(where, `front matter is missing "${f}"`);
      if (data.kb_id) {
        if (kbIds.has(data.kb_id)) err(where, `duplicate kb_id "${data.kb_id}"`);
        kbIds.add(data.kb_id);
      }
      if (data.status && !KB_STATUSES.includes(data.status)) err(where, `status "${data.status}" must be ${KB_STATUSES.join(' or ')}`);
      if (data.last_reviewed && !/^\d{4}-\d{2}-\d{2}$/.test(String(data.last_reviewed))) err(where, `last_reviewed "${data.last_reviewed}" must be YYYY-MM-DD`);
      if (!Array.isArray(data.source_anchors)) err(where, '"source_anchors" must be a list (it may be empty)');
      else for (const a of data.source_anchors) {
        const m = typeof a === 'string' && a.match(/^([^:\s]+):(\S+)$/);
        if (!m) { err(where, `source anchor "${a}" must look like <repo>:<path>`); continue; }
        if (!repoNames.has(m[1])) { err(where, `source anchor "${a}": unknown repo "${m[1]}"`); continue; }
        const info = this.repoInfo(m[1]);
        if (!info.cloned) stats.anchorsNotChecked++;
        else if (!fs.existsSync(path.join(info.path, m[2]))) err(where, `source anchor "${a}": path does not exist in ${m[1]}`);
        else stats.anchorsChecked++;
      }
    }
    ok.push(`kb: ${kbPages.length} pages`);

    // links and personal paths
    const files = this.walkFiles();
    for (const file of files) {
      const buf = fs.readFileSync(file);
      if (buf.subarray(0, 1024).includes(0)) continue;
      const text = buf.toString('utf8');
      const where = rel(file);
      const m = text.match(PERSONAL_PATH_RE);
      if (m) err(where, `personal absolute path found ("${m[0]}"): use a relative path or an environment variable`);
      if (file.endsWith('.md')) {
        for (const { raw, resolved } of this.links(file, text)) {
          if (!fs.existsSync(resolved)) err(where, `broken link: ${raw}`);
        }
      }
    }
    ok.push(`scanned ${files.length} files for links and personal paths`);
    return { errors, ok, stats };
  }

  links(file, text) {
    const clean = stripComments(text).replace(/(```|~~~)[\s\S]*?\1/g, '').replace(/`[^`\n]*`/g, '');
    const found = [];
    for (const m of clean.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      const raw = m[1];
      if (/^([a-z][a-z0-9+.-]*:|#|\{\{)/i.test(raw)) continue;
      let target = raw.split('#')[0].split('?')[0];
      if (!target) continue;
      try { target = decodeURI(target); } catch { /* keep raw */ }
      found.push({ raw, resolved: path.resolve(path.dirname(file), target) });
    }
    return found;
  }

  linkTargets(file) {
    return this.links(file, fs.readFileSync(file, 'utf8')).map((l) => l.resolved);
  }

  // ----- doctor -----
  doctor() {
    const checks = [];
    const add = (name, ok, detail, fix) => checks.push({ name, ok, detail, fix });
    const major = Number(process.versions.node.split('.')[0]);
    add('node', major >= 20, `v${process.versions.node}`, 'install Node 20 or newer (https://nodejs.org)');
    add('yaml dependency', Boolean(YAML), YAML ? 'installed' : 'missing', 'run: npm ci');
    let user = '';
    try { user = execFileSync('git', ['config', 'user.name'], { cwd: this.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* none */ }
    add('git user', Boolean(user), user || 'not set', 'run: git config --global user.name "Your Name"');
    for (const r of this.loadRepos()) {
      const info = this.repoInfo(r.name);
      add(`repo ${r.name}`, info.cloned, info.cloned ? `${info.path} on ${info.branch}` : 'not cloned', 'run: node kit.js repos clone');
    }
    for (const f of ASSISTANT_FILES) add(`assistant file ${f}`, fs.existsSync(path.join(this.root, f)), 'present', `restore ${f} from git: git checkout -- ${f}`);
    for (const c of checks) if (!c.ok && c.detail === 'present') c.detail = 'missing';
    return checks;
  }
}

// ---------- CLI ----------

const HELP = `kit.js: playbook-driven task kit

task list
task new <KEY> --type <type> --title <text> [--repos a,b] [--from KEY]
task status <KEY>            what to do now
task next <KEY>              validate the output, then advance or ask for review
task review <KEY> approve|reject [--note <text>]    (human; reject needs a note)
task meet <KEY> <requirement> --evidence <text>
task wait <KEY> --on <text>  (human)
task resume <KEY>
task skip <KEY> --reason <text>                     (human)
repos where [name] | clone | status | pull | workspace
check [-v] | doctor | ui [--port N] | watch [KEY] [--timeout seconds]
`;

const HINTS = {
  'in-progress': (k) => `Do this stage's work, then run: node kit.js task next ${k}`,
  'awaiting-review': () => 'Stop. A human reviews this output: approve or reject (task review).',
  blocked: (k) => `Blocked. Meet the requirement with real evidence: node kit.js task meet ${k} <requirement> --evidence "..." (or ask the human for the link).`,
  waiting: () => 'Waiting. A human resumes the task (task resume).',
  done: () => 'Done. Nothing more to do.',
};

export function formatStatus(s) {
  const out = [];
  out.push(`${s.key}  ${s.type}  "${s.title}"${s.from ? `  (from ${s.from})` : ''}`);
  out.push(`stage ${s.stage.position}/${s.stage.total}: ${s.stage.id} (${s.stage.title})   state: ${s.state}   gate: ${s.stage.gate}${s.stage.claims ? '   claims: required' : ''}`);
  out.push(`output: ${s.stage.output}`);
  if (s.waitingOn) out.push(`waiting on: ${s.waitingOn}`);
  if (s.unmet.length) {
    out.push('', 'unmet requirements:');
    for (const r of s.unmet) out.push(`- ${r.id}: ${r.text}`);
  }
  if (s.rejection) out.push('', `REJECTED by the reviewer. Handle this first: ${s.rejection}`);
  if (s.stage.instructions) out.push('', 'instructions:', s.stage.instructions);
  if (s.stage.exit_criteria.length) {
    out.push('', 'exit criteria:');
    for (const c of s.stage.exit_criteria) out.push(`- ${c}`);
  }
  if (s.repos.length) {
    out.push('', 'repos:');
    for (const r of s.repos) out.push(r.cloned ? `- ${r.name} (${r.owner ?? '?'}): ${r.path}  branch: ${r.branch}` : `- ${r.name} (${r.owner ?? '?'}): not cloned, run: node kit.js repos clone  (expected at ${r.path})`);
  }
  out.push('', `next: ${HINTS[s.state](s.key)}`);
  return out.join('\n');
}

function formatNext(key, r) {
  switch (r.outcome) {
    case 'refused': return { code: 1, text: `Not ready. Fix these in ${r.output}:\n${r.problems.map((p) => `- ${p}`).join('\n')}` };
    case 'review-requested': return { code: 0, text: `Stage ${r.stage} is ready for review. Stop here: a human approves or rejects (task review ${key}).` };
    case 'advanced': return { code: 0, text: `Advanced to stage ${r.stage} (state: ${r.state}). Run: node kit.js task status ${key}` };
    case 'done': return { code: 0, text: `Task ${key} is done.` };
    case 'awaiting-review': return { code: 0, text: 'Awaiting review. A human decides; do not approve it yourself.' };
    case 'waiting': return { code: 0, text: `Waiting${r.on ? ` on: ${r.on}` : ''}. A human resumes the task.` };
    case 'blocked': return { code: 0, text: `Blocked. Unmet requirements:\n${r.unmet.map((u) => `- ${u.id}: ${u.text}`).join('\n')}\nMeet one with: node kit.js task meet ${key} <requirement> --evidence "..."` };
    default: return { code: 0, text: JSON.stringify(r) };
  }
}

const need = (v, msg) => { if (!v || v === true) throw new KitError(msg); return v; };

async function runTask(kit, sub, pos, flags) {
  const key = pos[0];
  switch (sub) {
    case 'list': {
      const rows = kit.listTasks();
      if (!rows.length) return console.log('no tasks yet: node kit.js task new <KEY> --type <type> --title <text>');
      for (const t of rows) console.log(`${t.key.padEnd(14)} ${t.type.padEnd(9)} ${t.stage.padEnd(12)} ${t.state.padEnd(16)} ${t.title}`);
      return undefined;
    }
    case 'new': {
      const t = kit.createTask({ key, title: flags.title, type: flags.type, repos: typeof flags.repos === 'string' ? flags.repos.split(',').map((s) => s.trim()).filter(Boolean) : [], from: typeof flags.from === 'string' ? flags.from : undefined });
      console.log(`created ${t.key} (${t.type}). Next: node kit.js task status ${t.key}`);
      return undefined;
    }
    case 'status': console.log(formatStatus(kit.status(need(key, 'usage: task status <KEY>')))); return undefined;
    case 'next': {
      const { code, text } = formatNext(key, kit.next(need(key, 'usage: task next <KEY>')));
      console.log(text);
      return code;
    }
    case 'review': {
      need(key, 'usage: task review <KEY> approve|reject [--note]');
      const s = kit.review(key, pos[1], flags.note);
      console.log(pos[1] === 'approve' ? `approved. Now: stage ${s.stage.id}, state ${s.state}` : `rejected. Stage ${s.stage.id} stays open; see: node kit.js task status ${key}`);
      return undefined;
    }
    case 'meet': {
      const s = kit.meet(need(key, 'usage: task meet <KEY> <requirement> --evidence <text>'), need(pos[1], 'requirement id is required'), flags.evidence);
      console.log(`met ${pos[1]}. State: ${s.state}`);
      return undefined;
    }
    case 'wait': kit.wait(need(key, 'usage: task wait <KEY> --on <text>'), flags.on); console.log('waiting'); return undefined;
    case 'resume': { const s = kit.resume(need(key, 'usage: task resume <KEY>')); console.log(`resumed. State: ${s.state}`); return undefined; }
    case 'skip': { const s = kit.skip(need(key, 'usage: task skip <KEY> --reason <text>'), flags.reason); console.log(`skipped. Now: stage ${s.stage.id}, state ${s.state}`); return undefined; }
    default: throw new KitError(`unknown task command "${sub ?? ''}"\n${HELP}`);
  }
}

async function runRepos(kit, sub, pos) {
  if (!kit.loadRepos().length && sub !== 'workspace') console.log('repos.yaml lists no repos yet.');
  switch (sub) {
    case 'where':
      for (const r of kit.reposWhere(pos[0])) console.log(r.cloned ? `${r.name}: cloned  ${r.path}  branch: ${r.branch}  (production branch: ${r.productionBranch})` : `${r.name}: not cloned  (would be ${r.path})  run: node kit.js repos clone`);
      return;
    case 'clone': for (const r of kit.reposClone()) console.log(`${r.name}: ${r.result}`); return;
    case 'status': for (const r of kit.reposStatus()) console.log(r.cloned ? `${r.name}: ${r.branch}${r.dirty ? ' (uncommitted changes)' : ' (clean)'}` : `${r.name}: not cloned`); return;
    case 'pull': for (const r of kit.reposPull()) console.log(`${r.name}: ${r.result}`); return;
    case 'workspace': { const w = kit.workspace(); console.log(`wrote ${w.file} (${w.folders.length} folders)`); return; }
    default: throw new KitError(`unknown repos command "${sub ?? ''}"\n${HELP}`);
  }
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(HELP); return 0; }
  if (!YAML && cmd !== 'doctor') throw new KitError('the "yaml" dependency is missing: run npm ci');
  if (cmd === 'doctor' && !YAML) {
    console.log('FAIL yaml dependency: missing\n     fix: run npm ci');
    return 1;
  }
  const { pos, flags } = parseArgs(rest);
  const kit = new Kit({ via: cmd === 'ui' ? 'ui' : 'cli' });
  switch (cmd) {
    case 'task': return (await runTask(kit, pos[0], pos.slice(1), flags)) ?? 0;
    case 'repos': await runRepos(kit, pos[0], pos.slice(1)); return 0;
    case 'check': {
      const { errors, ok, stats } = kit.check();
      if (flags.v) for (const line of ok) console.log(`ok   ${line}`);
      for (const e of errors) console.log(`ERROR ${e}`);
      console.log(`KB anchors: ${stats.anchorsChecked} checked, ${stats.anchorsNotChecked} not checked (repo not cloned)`);
      console.log(errors.length ? `check failed: ${errors.length} error(s)` : 'check passed');
      return errors.length ? 1 : 0;
    }
    case 'doctor': {
      const checks = kit.doctor();
      for (const c of checks) {
        console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
        if (!c.ok) console.log(`     fix: ${c.fix}`);
      }
      return checks.every((c) => c.ok) ? 0 : 1;
    }
    case 'watch': {
      const timeout = flags.timeout === undefined ? 1800 : Number(flags.timeout);
      if (!Number.isFinite(timeout) || timeout < 0) throw new KitError('--timeout must be a number of seconds');
      const r = await kit.watch({ key: pos[0], timeout });
      if (r.outcome === 'timeout') { console.log(`no review or decision within ${timeout}s`); return 3; }
      const e = r.event;
      console.log(`${e.at} ${e.by} (${e.via}): ${e.event} on ${r.key}/${e.stage}${e.note ? ` - ${e.note}` : ''}${e.on ? ` - on: ${e.on}` : ''}`);
      console.log(`next: ${r.next}`);
      return 0;
    }
    case 'ui': {
      const { startUi } = await import('./ui.js');
      const port = flags.port === undefined ? 4173 : Number(flags.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new KitError('--port must be a number from 0 to 65535');
      const { url } = await startUi({ kit, port, htmlFile: path.join(KIT_ROOT, 'ui.html') });
      console.log(`kit UI on ${url} (Ctrl+C to stop)`);
      return null;
    }
    default: throw new KitError(`unknown command "${cmd}"\n${HELP}`);
  }
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then((code) => { if (code !== null) process.exit(code); }, (e) => {
    console.error(e instanceof KitError ? `error: ${e.message}` : e);
    process.exit(2);
  });
}
