// main.ts is mend, the CLI SPEC.md specifies (version 1). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`. It reads a patch in one of four formats (unified diff, SEARCH/REPLACE
// blocks, V4A, JSON edits), finds the lines each edit names at the first of three matching tiers, and
// writes every change or none, printing what it changed or why it failed.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---- files: lines, line break, final break (SPEC section 3) ----

interface SplitFile {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): SplitFile {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

// ---- matching at three tiers (SPEC section 5) ----

const rstrip = (s: string): string => s.replace(/[ \t]+$/, '');
const strip = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leading = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstrip(a) === rstrip(b);
  return strip(a) === strip(b);
}

function occurrences(lines: string[], o: string[], tier: number, from: number, endOnly: boolean): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = from; i + o.length <= lines.length; i += 1) {
    if (endOnly && i + o.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!tierEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  positions: number[];
}

/** First tier (0..maxTier) at which O occurs at least once at/after `from`. */
function findTier(lines: string[], o: string[], maxTier: number, from: number, endOnly = false): Found | null {
  for (let tier = 0; tier <= maxTier; tier += 1) {
    const positions = occurrences(lines, o, tier, from, endOnly);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One body item: a context line, a deleted line, or an added line. `noNL` is set by a `\` line after it. */
interface Item {
  k: 'ctx' | 'del' | 'add';
  t: string;
  noNL?: boolean;
}

function oLines(items: Item[]): string[] {
  return items.filter((it) => it.k !== 'add').map((it) => it.t);
}
function nLines(items: Item[]): string[] {
  return items.filter((it) => it.k !== 'del').map((it) => it.t);
}

/** Re-indent one added line at tier 2 (SPEC section 5); other tiers and other lines pass through. */
function reindent(text: string, p: string, f: string, tier: number): string {
  if (tier !== 2) return text;
  if (text === '' || text.trim() === '') return text;
  if (!text.startsWith(p)) return text;
  return f + text.slice(p.length);
}

/**
 * Build the replacement segment for a matched O. Context lines are written as the file's own matched
 * lines; added lines are re-indented at tier 2 against O's first line and the file's first matched line.
 */
function buildSegment(items: Item[], fileLines: string[], pos: number, tier: number): string[] {
  const o = oLines(items);
  const p = o.length > 0 ? leading(o[0]!) : '';
  const f = fileLines.length > pos ? leading(fileLines[pos]!) : '';
  const seg: string[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.k === 'ctx') {
      seg.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (it.k === 'del') {
      oi += 1;
    } else {
      seg.push(reindent(it.t, p, f, tier));
    }
  }
  return seg;
}

/** Last context-or-added item of a hunk/chunk, if any (for the `\` no-newline rule). */
function lastCtxOrAdd(items: Item[]): Item | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]!.k !== 'del') return items[i]!;
  }
  return null;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- applying unified hunks to one file's lines (SPEC section 6) ----

interface Hunk {
  a: number;
  items: Item[];
}

/**
 * Apply hunks in order to a file's text. `path` is only used for the failure line.
 * Returns the new text; throws Fail('no-match', path) when a hunk's old lines are not found.
 */
function applyHunks(text: string, hunks: Hunk[], maxTier: number, path: string): string {
  const f = splitFile(text);
  const lines = [...f.lines];
  let final = f.final;
  let d = 0;
  for (const hunk of hunks) {
    const items = hunk.items;
    const o = oLines(items);
    if (o.length === 0) {
      const adds = items.filter((it) => it.k === 'add');
      const seg = adds.map((it) => it.t);
      const pos = Math.max(0, Math.min(hunk.a + d, lines.length));
      const atEnd = pos === lines.length;
      lines.splice(pos, 0, ...seg);
      if (seg.length > 0 && atEnd) {
        const last = adds[adds.length - 1]!;
        final = !last.noNL;
      }
      d += seg.length;
      continue;
    }
    const found = findTier(lines, o, maxTier, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let pos = found.positions[0]!;
    let best = Math.abs(pos - target);
    for (const p of found.positions) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        best = dist;
        pos = p;
      }
    }
    const seg = buildSegment(items, lines, pos, found.tier);
    const toEnd = pos + o.length === lines.length;
    const last = lastCtxOrAdd(items);
    lines.splice(pos, o.length, ...seg);
    if (toEnd) {
      if (seg.length > 0) final = !(last !== null && last.noNL === true);
      else final = true;
    }
    d += seg.length - o.length;
  }
  return joinFile(lines, f.br, final);
}

// ---- unified diffs (SPEC section 6) ----

interface USection {
  slashOld: string | null | undefined;
  slashNew: string | null | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  createFlag: boolean;
  deleteFlag: boolean;
  hunks: Hunk[];
}

function parseDiffGit(line: string, n: number): [string, string] {
  const m = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${n}`);
  return [m[1]!, m[2]!];
}

/** Path after `--- `/`+++ `: text after the four characters, up to the first tab, spaces removed. */
function slashPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  return raw === '/dev/null' ? null : raw;
}

function stripPrefix(p: string | null | undefined): string | null | undefined {
  if (p === undefined || p === null) return p;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseUnified(lines: string[], maxTier: number): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inBody = false;
  const finishHunk = (): void => {
    if (cur === null || cur.hunks.length === 0) return;
    const items = cur.hunks[cur.hunks.length - 1]!.items;
    while (items.length > 0 && items[items.length - 1]!.k === 'ctx' && items[items.length - 1]!.t === '' && items[items.length - 1]!.noNL !== true) items.pop();
  };
  const startDiffSection = (line: string, n: number): void => {
    const [o, n2] = parseDiffGit(line, n);
    cur = { slashOld: undefined, slashNew: undefined, renOld: undefined, renNew: undefined, diffOld: o, diffNew: n2, createFlag: false, deleteFlag: false, hunks: [] };
    sections.push(cur);
    inBody = false;
  };
  const startBareSection = (oldLine: string, newLine: string): void => {
    cur = { slashOld: slashPath(oldLine), slashNew: slashPath(newLine), renOld: undefined, renNew: undefined, diffOld: undefined, diffNew: undefined, createFlag: false, deleteFlag: false, hunks: [] };
    sections.push(cur);
    inBody = false;
  };
  const hunkHeader = (line: string, n: number): number => {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line);
    if (m === null) throw new Exit2(`error: parse ${n}`);
    return Number(m[1]);
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const next = lines[i + 1] ?? '';
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = hunkHeader(line, i + 1);
      finishHunk();
      cur.hunks.push({ a, items: [] });
      inBody = true;
      continue;
    }
    if (cur !== null && inBody) {
      if (line.startsWith('diff --git ')) {
        finishHunk();
        startDiffSection(line, i + 1);
        continue;
      }
      if (line.startsWith('--- ') && next.startsWith('+++ ')) {
        finishHunk();
        startBareSection(line, next);
        i += 1;
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        const hunk = cur.hunks[cur.hunks.length - 1]!;
        if (line[0] === '\\') {
          const last = hunk.items[hunk.items.length - 1];
          if (last !== undefined) last.noNL = true;
        } else if (line === '') {
          hunk.items.push({ k: 'ctx', t: '' });
        } else if (line[0] === ' ') {
          hunk.items.push({ k: 'ctx', t: line.slice(1) });
        } else if (line[0] === '-') {
          hunk.items.push({ k: 'del', t: line.slice(1) });
        } else {
          hunk.items.push({ k: 'add', t: line.slice(1) });
        }
        continue;
      }
      finishHunk();
      inBody = false;
      // fall through: this line is handled as header/outside below
    }
    if (cur !== null && !inBody) {
      if (line.startsWith('diff --git ')) {
        startDiffSection(line, i + 1);
        continue;
      }
      if (line.startsWith('--- ')) {
        if (!next.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        if (cur.slashOld !== undefined) {
          startBareSection(line, next);
          i += 1;
          continue;
        }
        cur.slashOld = slashPath(line);
        cur.slashNew = slashPath(next);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renOld = line.slice(12).trim();
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renNew = line.slice(10).trim();
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.createFlag = true;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deleteFlag = true;
        continue;
      }
      continue;
    }
    // outside any section
    if (line.startsWith('diff --git ')) {
      startDiffSection(line, i + 1);
      continue;
    }
    if (line.startsWith('--- ') && next.startsWith('+++ ')) {
      startBareSection(line, next);
      i += 1;
      continue;
    }
    // prose and anything else: ignored
  }
  finishHunk();
  return sections.map((sec) => {
    // A leading a/ or b/ is removed from ---/+++ paths only; rename and diff --git paths are used as written.
    const oldP = sec.slashOld !== undefined ? stripPrefix(sec.slashOld) : (sec.renOld ?? sec.diffOld);
    const newP = sec.slashNew !== undefined ? stripPrefix(sec.slashNew) : (sec.renNew ?? sec.diffNew);
    const hunks = sec.hunks;
    const isCreate = sec.createFlag || oldP === null;
    const isDelete = !isCreate && (sec.deleteFlag || newP === null);
    if (isCreate) {
      const path = newP ?? '';
      return (tree: Tree): void => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        const adds: Item[] = [];
        for (const h of hunks) for (const it of h.items) if (it.k === 'add') adds.push(it);
        const plus = adds.map((it) => it.t);
        let content = '';
        if (plus.length > 0) {
          const last = adds[adds.length - 1]!;
          content = plus.join('\n') + (last.noNL === true ? '' : '\n');
        }
        tree.now.set(path, content);
      };
    }
    if (isDelete) {
      const path = oldP ?? '';
      return (tree: Tree): void => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      };
    }
    if (oldP !== undefined && newP !== undefined && oldP !== null && newP !== null && oldP !== newP) {
      const oldPath = oldP;
      const newPath = newP;
      return (tree: Tree): void => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const out = applyHunks(before, hunks, maxTier, oldPath);
        tree.now.set(oldPath, null);
        tree.now.set(newPath, out);
        tree.moves.push([oldPath, newPath]);
      };
    }
    const path = (oldP ?? newP ?? '') as string;
    return (tree: Tree): void => {
      if (!safe(path)) throw new Fail('unsafe', path);
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const out = applyHunks(before, hunks, maxTier, path);
      tree.now.set(path, out);
    };
  });
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

function parseSearchReplace(lines: string[], maxTier: number): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!;
      if (blank(t)) continue;
      const tr = t.trim();
      if (tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let end = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (eq < 0 || end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, end);
    const p = path;
    edits.push((tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const found = findTier(f.lines, oldLines, maxTier, 0);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const pp = leading(oldLines[0]!);
      const ff = leading(f.lines[pos]!);
      const seg = newLines.map((t) => reindent(t, pp, ff, found.tier));
      const out = [...f.lines];
      out.splice(pos, oldLines.length, ...seg);
      tree.now.set(p, joinFile(out, f.br, f.final));
    });
    prevPath = p;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC section 8) ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: Item[];
}

function findAnchor(lines: string[], anchor: string, cursor: number, maxTier: number): number | null {
  for (let tier = 0; tier <= maxTier; tier += 1) {
    for (let i = cursor; i < lines.length; i += 1) {
      if (tierEq(lines[i]!, anchor, tier)) return i;
    }
  }
  return null;
}

function parseV4a(lines: string[], maxTier: number): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sectionStart = (line: string): 'add' | 'delete' | 'update' | null => {
    if (line.startsWith('*** Add File: ')) return 'add';
    if (line.startsWith('*** Delete File: ')) return 'delete';
    if (line.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const kind = sectionStart(lines[i]!);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const secLine = i;
    const path = lines[i]!.slice(lines[i]!.indexOf(': ') + 2).trim();
    // Collect the section body: up to the next section start or *** End Patch.
    const body: { line: string; n: number }[] = [];
    let j = i + 1;
    while (j < last && sectionStart(lines[j]!) === null) {
      body.push({ line: lines[j]!, n: j + 1 });
      j += 1;
    }
    // Blank lines at the end of a section are not part of it (a blank line is empty or only whitespace).
    while (body.length > 0 && blank(body[body.length - 1]!.line)) body.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const b of body) {
        if (b.line.startsWith('+')) fileLines.push(b.line.slice(1));
        else if (blank(b.line)) fileLines.push('');
        else throw new Exit2(`error: parse ${b.n}`);
      }
      const p = path;
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
      });
    } else if (kind === 'delete') {
      for (const b of body) {
        if (!blank(b.line)) throw new Exit2(`error: parse ${b.n}`);
      }
      const p = path;
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let moveTo: string | undefined;
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (const b of body) {
        const line = b.line;
        if (line.startsWith('*** Move to: ')) {
          if (moveTo !== undefined || chunks.length > 0) throw new Exit2(`error: parse ${b.n}`);
          moveTo = line.slice(13).trim();
        } else if (line.startsWith('@@')) {
          cur = { anchor: line.slice(2).trim() === '' ? null : line.slice(2).trim(), eof: false, items: [] };
          chunks.push(cur);
        } else if (line === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${b.n}`);
          cur.eof = true;
          cur = null;
        } else if (line === '') {
          if (cur !== null) cur.items.push({ k: 'ctx', t: '' });
        } else if (line[0] === ' ' || line[0] === '-' || line[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${b.n}`);
            cur = { anchor: null, eof: false, items: [] };
            chunks.push(cur);
          }
          if (line[0] === ' ') cur.items.push({ k: 'ctx', t: line.slice(1) });
          else if (line[0] === '-') cur.items.push({ k: 'del', t: line.slice(1) });
          else cur.items.push({ k: 'add', t: line.slice(1) });
        } else {
          throw new Exit2(`error: parse ${b.n}`);
        }
      }
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${secLine + 1}`);
      const p = path;
      const mv = moveTo;
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mv !== undefined && !safe(mv)) throw new Fail('unsafe', mv);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (mv !== undefined && tree.get(mv) !== null) throw new Fail('exists', mv);
        const f = splitFile(before);
        const out = [...f.lines];
        let cursor = 0;
        for (const chunk of chunks) {
          if (chunk.anchor !== null) {
            const ai = findAnchor(out, chunk.anchor, cursor, maxTier);
            if (ai === null) throw new Fail('no-match', p);
            cursor = ai + 1;
          }
          const o = oLines(chunk.items);
          if (o.length === 0) {
            const pos = chunk.eof ? out.length : cursor;
            const seg = chunk.items.filter((it) => it.k === 'add').map((it) => it.t);
            out.splice(pos, 0, ...seg);
            cursor = pos + seg.length;
          } else {
            const found = findTier(out, o, maxTier, cursor, chunk.eof);
            if (found === null) throw new Fail('no-match', p);
            const pos = found.positions[0]!;
            const seg = buildSegment(chunk.items, out, pos, found.tier);
            out.splice(pos, o.length, ...seg);
            cursor = pos + seg.length;
          }
        }
        const text = joinFile(out, f.br, f.final);
        if (mv !== undefined) {
          tree.now.set(p, null);
          tree.now.set(mv, text);
          tree.moves.push([p, mv]);
        } else {
          tree.now.set(p, text);
        }
      });
    }
    i = j;
  }
  return edits;
}

// ---- JSON edits (SPEC section 9) ----

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- invocation, output and atomicity (SPEC sections 1, 2, 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const maxTier = strict ? 0 : 2;
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, maxTier);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, maxTier);
    else edits = parseV4a(lines, maxTier);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      for (const m of movesBefore) tree.moves.push(m);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: A/D/M per changed path, R replacing a move's D+A pair when the old path existed
  // before the patch and is gone after it and the new path did not exist before and does after it.
  // Rows sort in byte order of the paths (R sorts by its new path).
  const suppressD = new Set<string>();
  const suppressA = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      suppressD.add(oldP);
      suppressA.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null && suppressA.has(p)) continue;
    if (now === null && suppressD.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
