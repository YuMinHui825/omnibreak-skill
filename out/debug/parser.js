"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GdbMiParser = void 0;
exports.parseBreakpoint = parseBreakpoint;
exports.parseThreadInfo = parseThreadInfo;
exports.parseFrames = parseFrames;
exports.parseVariables = parseVariables;
class GdbMiParser {
    buffer = '';
    resultCb = null;
    recordCb = null;
    onResult(cb) { this.resultCb = cb; }
    onRecord(cb) { this.recordCb = cb; }
    feed(chunk) {
        this.buffer += chunk;
        let idx;
        while ((idx = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.substring(0, idx).trim();
            this.buffer = this.buffer.substring(idx + 1);
            if (line.length === 0)
                continue;
            this.parseLine(line);
        }
    }
    parseLine(line) {
        const match = line.match(/^(\d*)(\^|\*|\+|~|@|&)(\S+)(.*)$/);
        if (!match) {
            if (line.startsWith('(gdb)'))
                return;
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
            case '*':
            case '+':
            case '=':
                this.recordCb?.({
                    token: tokenNum,
                    type: cls === '*' ? 'exec' : cls === '+' ? 'status' : 'notify',
                    class: data.split(',')[0].split('=')[0] || data,
                    data: data,
                });
                break;
            case '~':
            case '@':
            case '&':
                this.recordCb?.({
                    token: tokenNum,
                    type: cls === '~' ? 'console' : cls === '@' ? 'target' : 'log',
                    class: 'stream',
                    data: data,
                });
                break;
        }
    }
    reset() { this.buffer = ''; }
}
exports.GdbMiParser = GdbMiParser;
function parseBreakpoint(data) {
    const result = {};
    const clean = data.replace(/^\^?\w+,/, '');
    const match = clean.match(/^bkpt=\{(.+)\}$/);
    if (match) {
        for (const pair of match[1].split(',')) {
            const eqIdx = pair.indexOf('=');
            if (eqIdx < 0)
                continue;
            const key = pair.substring(0, eqIdx).trim();
            const value = pair.substring(eqIdx + 1).replace(/^"(.*)"$/, '$1').trim();
            result[key] = value;
        }
    }
    return result;
}
function parseThreadInfo(data) {
    const threads = [];
    const match = data.match(/^done,threads=\[([\s\S]+)\],current-thread-id=/);
    if (match) {
        for (const part of match[1].split(/\},\{/)) {
            const clean = part.replace(/^\{|\}$/g, '');
            const props = extractKeyValues(clean);
            if (props['id']) {
                threads.push({ id: props['id'], name: props['name'] || '', state: props['state'] || 'unknown' });
            }
        }
    }
    return threads;
}
function parseFrames(data) {
    const frames = [];
    const match = data.match(/^done,stack=\[([^\]]*)\]/);
    if (match) {
        for (const part of match[1].split(/frame=\{/).filter(Boolean)) {
            frames.push(extractKeyValues(part.replace(/\}$/, '')));
        }
    }
    return frames;
}
function parseVariables(data) {
    const vars = [];
    const match = data.match(/^done,variables=\[([^\]]*)\]/);
    if (match) {
        for (const part of match[1].split(/\},\{/)) {
            vars.push(extractKeyValues(part.replace(/^\{|\}$/g, '')));
        }
    }
    return vars;
}
function extractKeyValues(str) {
    const result = {};
    let i = 0;
    while (i < str.length) {
        const eqIdx = str.indexOf('=', i);
        if (eqIdx < 0)
            break;
        const key = str.substring(i, eqIdx);
        i = eqIdx + 1;
        if (str[i] === '"') {
            const endQuote = str.indexOf('"', i + 1);
            if (endQuote >= 0) {
                result[key] = str.substring(i + 1, endQuote);
                i = endQuote + 1;
                if (str[i] === ',')
                    i++;
            }
            else {
                result[key] = str.substring(i);
                break;
            }
        }
        else {
            const nextComma = str.indexOf(',', i);
            if (nextComma >= 0) {
                result[key] = str.substring(i, nextComma);
                i = nextComma + 1;
            }
            else {
                result[key] = str.substring(i);
                break;
            }
        }
    }
    return result;
}
