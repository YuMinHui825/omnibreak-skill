/** MiResult — GDB/MI command response */
export interface MiResult {
  token: number;
  class: 'done' | 'error' | 'running' | 'connected';
  data: string;
}

/** MiAsyncRecord — GDB/MI async event */
export interface MiAsyncRecord {
  token: number;
  type: 'exec' | 'notify' | 'status' | 'console' | 'target' | 'log';
  class: string;
  data: string;
}

/** CLI JSON output — every command returns this shape */
export interface CliOutput {
  ok: boolean;
  error?: string;
  code?: 'CONNECTION' | 'AUTH' | 'TIMEOUT' | 'BINARY' | 'SESSION' | 'PTRACE';
  hint?: string;
  status?: 'stopped' | 'running' | 'exited';
  reason?: 'breakpoint-hit' | 'end-stepping-range' | 'signal-received' | 'entry' | 'exited' | 'exited-normally' | 'exited-signalled';
  file?: string;
  line?: number;
  pid?: number;
  threadId?: number;
  threads?: ThreadInfo[];
  frames?: FrameInfo[];
  vars?: VarInfo[];
  result?: string;
  breakpoints?: BreakpointInfo[];
  watchpoints?: WatchpointInfo[];
  context?: SourceLine[];
}

/** Structured parse of a GDB/MI `*stopped` async record. */
export interface StopRecord {
  /** Global thread id of the thread that directly caused the stop. */
  threadId?: number;
  reason?: string;
  /** Breakpoint number for `reason="breakpoint-hit"`. */
  bkptno?: string;
  exitCode?: string;
  /** Non-stop: the threads that stopped; all-stop: `["all"]`. */
  stoppedThreads?: string[];
  frame?: { func?: string; file?: string; fullname?: string; line?: number };
  /** The raw MI record string, preserved for debugging. */
  raw: string;
}

export interface ThreadInfo { id: number; name: string; state: string }
export interface FrameInfo { level: number; func: string; file: string; line: number }
export interface VarInfo { name: string; value: string }
export interface BreakpointInfo { id: number; file: string; line: number; verified: boolean }
export interface WatchpointInfo { id: number; expr: string; type: 'read' | 'write' | 'access'; verified: boolean }
export interface SourceLine { line: number; code: string; isTarget: boolean }

/** Session state stored in /tmp/omnibreak-session.json */
export interface SessionState {
  pid: number;
  targetHost: string;
  binaryPath: string;
  gdbserverPort: number;
  sshUser: string;
  attached: boolean;
  startedAt: string;
}

/** Stats result */
export interface StatsResult {
  pid: number;
  cpuPercent: number;
  rssMB: number;
  vszMB: number;
  threadCount: number;
  state: string;
}

/** Trace capture result */
export interface TraceCaptureResult {
  output: string;
  sizeBytes: number;
  remoteHost: string;
  durationSec: number;
  summary?: Record<string, any>;
  narrative?: string;
}

/** Stats snapshot for diff comparison */
export interface StatsSnapshot {
  timestamp: number;
  cpuPercent: number;
  rssMB: number;
  vszMB: number;
  threadCount: number;
  state: string;
}

/** Diff between two stats snapshots */
export interface DiffResult {
  elapsedMs: number;
  before: StatsSnapshot;
  after: StatsSnapshot;
  delta: { cpuPercent: number; rssMB: number; vszMB: number; threadCount: number };
}

/** Leak report */
export interface LeakResult {
  pid: number;
  heapKB: number;
  stackKB: number;
  dataKB: number;
  rssKB: number;
  vszKB: number;
  heapDeltaKB: number;
  risk: 'none' | 'low' | 'medium' | 'high';
  sampleCount: number;
}

/** Minimal logger — writes to stderr with timestamp */
export function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(`[omnibreak][${level}] ${msg}\n`);
}
