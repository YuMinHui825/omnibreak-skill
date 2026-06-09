import { parseThreadInfo, parseFrames, parseVariables, parseBreakpoint } from '../../src/gdbMiParser';

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
});
