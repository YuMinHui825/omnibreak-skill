import { MiResult, MiAsyncRecord, StopRecord } from '../shared/types';

type RecordCallback = (record: MiAsyncRecord) => void;
type ResultCallback = (result: MiResult) => void;

export class GdbMiParser {
  private buffer = '';
  private resultCb: ResultCallback | null = null;
  private recordCb: RecordCallback | null = null;

  onResult(cb: ResultCallback): void { this.resultCb = cb; }
  onRecord(cb: RecordCallback): void { this.recordCb = cb; }

  feed(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.substring(0, idx).trim();
      this.buffer = this.buffer.substring(idx + 1);
      if (line.length === 0) continue;
      this.parseLine(line);
    }
  }

  private parseLine(line: string): void {
    const match = line.match(/^(\d*)(\^|\*|\+|~|@|&)(\S+)(.*)$/);
    if (!match) {
      if (line.startsWith('(gdb)')) return;
      return;
    }
    const [, token, cls, cmd] = match;
    const data = (cmd + (match[4] || '')).trim();
    const tokenNum = token ? parseInt(token, 10) : 0;

    switch (cls) {
      case '^':
        this.resultCb?.({
          token: tokenNum,
          class: data.startsWith('done') ? 'done' :
                 data.startsWith('error') ? 'error' :
                 data.startsWith('running') ? 'running' : 'connected',
          data: data,
        });
        break;
      case '*': case '+': case '=':
        this.recordCb?.({
          token: tokenNum,
          type: cls === '*' ? 'exec' : cls === '+' ? 'status' : 'notify',
          class: data.split(',')[0].split('=')[0] || data,
          data: data,
        });
        break;
      case '~': case '@': case '&':
        this.recordCb?.({
          token: tokenNum,
          type: cls === '~' ? 'console' : cls === '@' ? 'target' : 'log',
          class: 'stream',
          data: data,
        });
        break;
    }
  }

  reset(): void { this.buffer = ''; }
}

/** Unescape a GDB/MI c-string value (handles \" \\ \n \t \r escapes). */
export function unescapeMiString(v: string): string {
  const map: Record<string, string> = { '"': '"', '\\': '\\', 'n': '\n', 'r': '\r', 't': '\t' };
  return v.replace(/\\(.)/g, (_, c) => (c in map ? map[c] : c));
}

/** Extract the value of a `key="..."` MI field, honoring escaped quotes inside the string. */
export function extractMiString(data: string, key: string): string | undefined {
  const m = data.match(new RegExp(`${key}="((?:[^"\\\\]|\\\\.)*)"`));
  return m ? unescapeMiString(m[1]) : undefined;
}

/**
 * Parse a GDB/MI `*stopped` async record into a structured StopRecord. Accepts either the
 * raw record string (pre-Structured-event clients) or an already-structured StopRecord
 * (pass-through), so it works before and after the client event-payload change.
 */
export function parseStopRecord(data: string | StopRecord): StopRecord {
  if (typeof data !== 'string') return data;
  const tid = extractMiString(data, 'thread-id');          // exact key; won't match "stopped-threads"
  // Frame is typically the last field; greedy match lands on its closing `}`.
  const frameMatch = data.match(/frame=\{(.*)\}(?:,|$)/);
  const frame = frameMatch ? parseMiFields(frameMatch[1]) : {};
  const stoppedThreadsRaw = extractMiString(data, 'stopped-threads');
  return {
    threadId: tid !== undefined && /^\d+$/.test(tid) ? parseInt(tid, 10) : undefined,
    reason: extractMiString(data, 'reason'),
    bkptno: extractMiString(data, 'bkptno'),
    exitCode: extractMiString(data, 'exit-code'),
    stoppedThreads: stoppedThreadsRaw
      ? (stoppedThreadsRaw === 'all' ? ['all'] : stoppedThreadsRaw.match(/"(\d+)"/g)?.map(x => x.replace(/"/g, '')))
      : undefined,
    frame: frame['line'] !== undefined ? {
      func: frame['func'], file: frame['file'], fullname: frame['fullname'],
      line: parseInt(frame['line'], 10),
    } : undefined,
    raw: data,
  };
}

/**
 * Split MI tuple fields at the top level (`key=value,key=value,...`), respecting quoted
 * strings (with `\"` escapes) and nested `{...}` / `[...]`. The old `str.split(',')`
 * truncated values containing commas (e.g. C++ template funcs, conditions, list values).
 */
function splitMiFields(s: string): string[] {
  const fields: string[] = [];
  let cur = '', depth = 0, inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      cur += c;
      if (c === '\\') { if (i + 1 < s.length) cur += s[++i]; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; cur += c; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    if (c === ',' && depth === 0) { fields.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) fields.push(cur);
  return fields;
}

/** Parse the body of an MI tuple (`{...}`) into key → unquoted value. */
function parseMiFields(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of splitMiFields(body)) {
    const eq = field.indexOf('=');
    if (eq <= 0) continue;
    const key = field.substring(0, eq).trim();
    const raw = field.substring(eq + 1).trim();
    const qm = raw.match(/^"(.*)"$/);
    result[key] = qm ? unescapeMiString(qm[1]) : raw;
  }
  return result;
}

export function parseBreakpoint(data: string): Record<string, string> {
  const m = data.match(/^done,bkpt=\{(.*)\}$/);
  return m ? parseMiFields(m[1]) : {};
}

/** Parse a `-break-watch` reply, which uses `wpt={...}` rather than `bkpt={...}`. */
export function parseWatchpoint(data: string): Record<string, string> {
  const m = data.match(/^done,wpt=\{(.*)\}$/);
  return m ? parseMiFields(m[1]) : {};
}

/** Parse `-thread-info` into a thread list plus the `current-thread-id` (all-stop: the stopped thread). */
export function parseThreadInfoWithCurrent(data: string): {
  threads: Array<{ id: string; name: string; state: string }>;
  currentThreadId?: number;
} {
  const threads: Array<{ id: string; name: string; state: string }> = [];
  let currentThreadId: number | undefined;
  // Thread tuples never contain `]`, so non-greedy to the first `]` is safe; current-thread-id is optional.
  const match = data.match(/^done,threads=\[(.*?)\](?:,current-thread-id="(\d+)")?/);
  if (match) {
    if (match[2]) currentThreadId = parseInt(match[2], 10);
    for (const part of splitMiFields(match[1])) {
      const props = parseMiFields(part.trim().replace(/^\{|\}$/g, ''));
      if (props['id']) {
        threads.push({ id: props['id'], name: props['name'] || '', state: props['state'] || 'unknown' });
      }
    }
  }
  return { threads, currentThreadId };
}

export function parseThreadInfo(data: string): Array<{ id: string; name: string; state: string }> {
  return parseThreadInfoWithCurrent(data).threads;
}

export function parseFrames(data: string): Array<Record<string, string>> {
  const frames: Array<Record<string, string>> = [];
  const match = data.match(/^done,stack=\[(.*)\]$/);
  if (match) {
    for (const part of splitMiFields(match[1])) {
      const m = part.trim().match(/^frame=\{(.*)\}$/);
      if (m) frames.push(parseMiFields(m[1]));
    }
  }
  return frames;
}

export function parseVariables(data: string): Array<Record<string, string>> {
  const vars: Array<Record<string, string>> = [];
  const match = data.match(/^done,variables=\[(.*)\]$/);
  if (match) {
    for (const part of splitMiFields(match[1])) {
      vars.push(parseMiFields(part.trim().replace(/^\{|\}$/g, '')));
    }
  }
  return vars;
}
