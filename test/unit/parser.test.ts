import { parseThreadInfo, parseThreadInfoWithCurrent, parseFrames, parseVariables, parseBreakpoint, parseWatchpoint, parseStopRecord, extractMiString, unescapeMiString } from '../../src/debug/parser';

describe('gdbMiParser', () => {
  describe('parseThreadInfo', () => {
    it('parses single thread', () => {
      const input = 'done,threads=[{id="1",name="myapp",state="stopped"}],current-thread-id="1"';
      const result = parseThreadInfo(input);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ id: '1', name: 'myapp', state: 'stopped' });
    });

    it('parses multiple threads', () => {
      const input = 'done,threads=[{id="1",name="main"},{id="2",name="worker"},{id="3",name="w2"}],current-thread-id="1"';
      const result = parseThreadInfo(input);
      expect(result).toHaveLength(3);
      expect(result[1].id).toBe('2');
      expect(result[1].name).toBe('worker');
    });

    it('handles empty thread list', () => {
      const input = 'done,threads=[],current-thread-id="0"';
      const result = parseThreadInfo(input);
      expect(result).toHaveLength(0);
    });

    it('handles unknown state', () => {
      const input = 'done,threads=[{id="5"}],current-thread-id="5"';
      const result = parseThreadInfo(input);
      expect(result).toHaveLength(1);
      expect(result[0].state).toBe('unknown');
    });
  });

  describe('parseFrames', () => {
    it('parses single frame', () => {
      const input = 'done,stack=[frame={level="0",func="main",file="foo.c",line="42"}]';
      const result = parseFrames(input);
      expect(result).toHaveLength(1);
      expect(result[0].func).toBe('main');
      expect(result[0].line).toBe('42');
    });

    it('parses multiple frames', () => {
      const input = 'done,stack=[frame={level="0",func="main"},frame={level="1",func="start"}]';
      const result = parseFrames(input);
      expect(result).toHaveLength(2);
      expect(result[0].func).toBe('main');
      expect(result[1].func).toBe('start');
    });
  });

  describe('parseVariables', () => {
    it('parses variables', () => {
      const input = 'done,variables=[{name="x",value="10"},{name="ptr",value="0x1234"}]';
      const result = parseVariables(input);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ name: 'x', value: '10' });
      expect(result[1]).toEqual({ name: 'ptr', value: '0x1234' });
    });
  });

  describe('parseBreakpoint', () => {
    it('parses breakpoint info', () => {
      const input = 'done,bkpt={number="1",type="breakpoint",addr="0x0000",file="foo.c",line="42"}';
      const result = parseBreakpoint(input);
      expect(result.number).toBe('1');
      expect(result.file).toBe('foo.c');
      expect(result.line).toBe('42');
    });
  });

  describe('parseWatchpoint', () => {
    it('parses watchpoint info from wpt={...}', () => {
      const input = 'done,wpt={number="2",exp="counter",type="-break-watch",disp="keep",enabled="y",times="0",original-location="counter"}';
      const result = parseWatchpoint(input);
      expect(result.number).toBe('2');
      expect(result.exp).toBe('counter');
      expect(result.type).toBe('-break-watch');
    });

    it('does not match bkpt tuples (returns empty)', () => {
      const result = parseWatchpoint('done,bkpt={number="1",type="breakpoint"}');
      expect(Object.keys(result)).toHaveLength(0);
    });
  });

  describe('extractMiString / unescapeMiString', () => {
    it('extracts a value containing escaped quotes (no truncation)', () => {
      // MI value with \" escapes inside the string
      const data = 'done,value="0x7fff \\"hello world\\" 123"';
      expect(extractMiString(data, 'value')).toBe('0x7fff "hello world" 123');
    });

    it('returns undefined when the key is absent', () => {
      expect(extractMiString('done,foo="bar"', 'value')).toBeUndefined();
    });

    it('unescapes common GDB/MI escapes', () => {
      expect(unescapeMiString('a\\"b\\\\c\\nd\\te')).toBe('a"b\\c\nd\te');
    });
  });

  describe('quote-aware MI parsing (commas/escapes in values)', () => {
    it('parseFrames keeps C++ template func with commas intact', () => {
      const input = 'done,stack=[frame={level="0",func="std::map<int, std::string>::operator[]",file="x.cpp",line="5"}]';
      const frames = parseFrames(input);
      expect(frames).toHaveLength(1);
      expect(frames[0].func).toBe('std::map<int, std::string>::operator[]');
      expect(frames[0].line).toBe('5');
    });

    it('parseVariables keeps a value with a comma inside a string', () => {
      const input = 'done,variables=[{name="s",value="\\"a, b\\""}]';
      const vars = parseVariables(input);
      expect(vars[0].value).toBe('"a, b"');
    });

    it('parseBreakpoint keeps a condition with a comma', () => {
      const input = 'done,bkpt={number="1",cond="i > 1, j < 2",file="foo.c",line="42"}';
      const bp = parseBreakpoint(input);
      expect(bp.cond).toBe('i > 1, j < 2');
      expect(bp.number).toBe('1');
    });

    it('parseThreadInfo handles multiple threads with quoted names', () => {
      const input = 'done,threads=[{id="1",name="main thread"}, {id="2",name="worker"}],current-thread-id="1"';
      const threads = parseThreadInfo(input);
      expect(threads).toHaveLength(2);
      expect(threads[0].name).toBe('main thread');
    });
  });

  describe('parseStopRecord', () => {
    it('parses breakpoint-hit with thread-id and frame', () => {
      const input = '*stopped,reason="breakpoint-hit",thread-id="2",bkptno="1",frame={func="worker",file="multithread.c",fullname="/tmp/example/src/multithread.c",line="17"}';
      const r = parseStopRecord(input);
      expect(r.threadId).toBe(2);
      expect(r.reason).toBe('breakpoint-hit');
      expect(r.bkptno).toBe('1');
      expect(r.frame?.func).toBe('worker');
      expect(r.frame?.line).toBe(17);
      expect(r.raw).toBe(input);
    });

    it('parses exit record with exit-code but no thread/frame', () => {
      const r = parseStopRecord('*stopped,reason="exited",exit-code="0"');
      expect(r.reason).toBe('exited');
      expect(r.exitCode).toBe('0');
      expect(r.threadId).toBeUndefined();
      expect(r.frame).toBeUndefined();
    });

    it('does not read `stopped-threads` as the thread-id', () => {
      const r = parseStopRecord('*stopped,reason="breakpoint-hit",stopped-threads="all",thread-id="1"');
      expect(r.threadId).toBe(1);
      expect(r.stoppedThreads).toEqual(['all']);
    });

    it('parses frame with nested args (greedy to the closing brace)', () => {
      const input = '*stopped,reason="breakpoint-hit",thread-id="2",frame={level="0",func="worker",args=[{name="arg",value="0x1"}],line="18"}';
      const r = parseStopRecord(input);
      expect(r.threadId).toBe(2);
      expect(r.frame?.line).toBe(18);
      expect(r.frame?.func).toBe('worker');
    });

    it('passes through an already-structured StopRecord', () => {
      const structured = { threadId: 3, reason: 'breakpoint-hit', raw: '*stopped,...' };
      expect(parseStopRecord(structured)).toBe(structured);
    });
  });

  describe('parseThreadInfoWithCurrent', () => {
    it('returns current-thread-id', () => {
      const { threads, currentThreadId } = parseThreadInfoWithCurrent('done,threads=[{id="1"},{id="2"}],current-thread-id="2"');
      expect(threads).toHaveLength(2);
      expect(currentThreadId).toBe(2);
    });

    it('handles a missing current-thread-id', () => {
      const { threads, currentThreadId } = parseThreadInfoWithCurrent('done,threads=[{id="1"}]');
      expect(threads).toHaveLength(1);
      expect(currentThreadId).toBeUndefined();
    });
  });
});
