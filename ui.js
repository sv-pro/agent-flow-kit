// Local web UI over the same Kit actions as the CLI. No business logic here.
import http from 'node:http';
import fs from 'node:fs';
import { KitError, stripComments } from './kit.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(text) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]*|(?:\.{1,2}\/|\/(?!\/))[^:)\s]*)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
  return s;
}

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
}

// Minimal markdown renderer. Table rows whose Kind is "inferred" get class "inferred".
export function renderMarkdown(md) {
  const lines = stripComments(md).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (/^\s*```/.test(line)) {
      const buf = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i]);
      out.push(`<pre>${esc(buf.join('\n'))}</pre>`);
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    } else if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(line);
      const kindCol = head.findIndex((h) => h.toLowerCase() === 'kind');
      let html = `<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>`;
      i += 2;
      for (; i < lines.length && lines[i].trim().startsWith('|'); i++) {
        const row = cells(lines[i]);
        const kind = kindCol >= 0 ? (row[kindCol] ?? '').toLowerCase() : '';
        const cls = ['measured', 'inferred', 'decision'].includes(kind) ? ` class="${kind}"` : '';
        html += `<tr${cls}>${row.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`;
      }
      i--;
      out.push(`${html}</tbody></table>`);
    } else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const tag = /^\s*\d+\./.test(line) ? 'ol' : 'ul';
      const items = [];
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]); i++) items.push(`<li>${inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`);
      i--;
      out.push(`<${tag}>${items.join('')}</${tag}>`);
    } else if (line.trim()) {
      const buf = [line];
      while (i + 1 < lines.length && lines[i + 1].trim() && !/^(#{1,6}\s|\s*```|\s*\||\s*([-*]|\d+\.)\s)/.test(lines[i + 1])) buf.push(lines[++i]);
      out.push(`<p>${inline(buf.join(' '))}</p>`);
    }
  }
  return out.join('\n');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { req.pause(); reject(new KitError('body too large', 413)); } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new KitError('body must be JSON')); }
    });
    req.on('error', reject);
  });
}

export function createHandler(kit, htmlFile) {
  return async (req, res) => {
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    try {
      // Reject foreign Host headers (DNS rebinding) and cross-site POSTs.
      const host = req.headers.host ?? '';
      const port = req.socket.localPort;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new KitError('forbidden host', 403);
      const url = new URL(req.url, `http://${host}`);
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET') {
        if (!parts.length) return send(200, fs.readFileSync(htmlFile, 'utf8'), 'text/html; charset=utf-8');
        if (parts[0] === 'api' && parts[1] === 'tasks' && parts.length === 2) return send(200, kit.listTasks());
        if (parts[0] === 'api' && parts[1] === 'types' && parts.length === 2) return send(200, kit.listTypes());
        if (parts[0] === 'api' && parts[1] === 'repos' && parts.length === 2) return send(200, kit.reposWhere());
        if (parts[0] === 'api' && parts[1] === 'tasks' && parts.length === 3) {
          const outputs = kit.outputs(parts[2]).map((o) => ({ ...o, html: o.exists ? renderMarkdown(o.content) : '' }));
          return send(200, { ...kit.status(parts[2]), outputs });
        }
        throw new KitError('not found', 404);
      }
      if (req.method === 'POST') {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new KitError('content-type must be application/json', 415);
        if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new KitError('forbidden origin', 403);
        const body = await readBody(req);
        if (parts[0] === 'api' && parts[1] === 'tasks' && parts.length === 2) {
          const t = kit.createTask({ key: body.key, title: body.title, type: body.type, repos: Array.isArray(body.repos) ? body.repos : [], from: body.from || undefined });
          return send(201, kit.status(t.key));
        }
        if (parts[0] === 'api' && parts[1] === 'tasks' && parts.length === 4) {
          const [, , key, action] = parts;
          switch (action) {
            case 'next': return send(200, kit.next(key));
            case 'approve': return send(200, kit.review(key, 'approve', body.note));
            case 'reject': return send(200, kit.review(key, 'reject', body.note));
            case 'meet': return send(200, kit.meet(key, body.requirement, body.evidence));
            case 'wait': return send(200, kit.wait(key, body.on));
            case 'resume': return send(200, kit.resume(key));
            case 'skip': return send(200, kit.skip(key, body.reason));
            default: throw new KitError('unknown action', 404);
          }
        }
        throw new KitError('not found', 404);
      }
      throw new KitError('method not allowed', 405);
    } catch (e) {
      if (e instanceof KitError) return send(e.status, { error: e.message });
      return send(500, { error: 'internal error' });
    }
  };
}

export function startUi({ kit, port = 4173, htmlFile }) {
  const server = http.createServer(createHandler(kit, htmlFile));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({ server, port: actual, url: `http://127.0.0.1:${actual}` });
    });
  });
}
