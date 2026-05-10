import { execSync } from 'child_process';

export interface SshConfig {
  host: string;
  user: string;
  port: number;
  password?: string;
}

/** Build SSH prefix for execSync commands */
function prefix(c: SshConfig): string {
  if (c.password) {
    return `sshpass -p '${c.password}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ControlMaster=auto -o ControlPersist=60s -p ${c.port} ${c.user}@${c.host}`;
  }
  return `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ControlMaster=auto -o ControlPersist=60s -p ${c.port} ${c.user}@${c.host}`;
}

/** Run a command on the remote target */
export function sshExec(c: SshConfig, cmd: string): string {
  return execSync(`${prefix(c)} ${cmd}`, { timeout: 15000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
}

/** SCP a file to the remote target */
export function scpDeploy(source: string, c: SshConfig, dest: string): void {
  const sc = c.password
    ? `sshpass -p '${c.password}' scp -o StrictHostKeyChecking=no -P ${c.port} ${source} ${c.user}@${c.host}:${dest}`
    : `scp -o StrictHostKeyChecking=no -P ${c.port} ${source} ${c.user}@${c.host}:${dest}`;
  execSync(sc, { timeout: 60000, encoding: 'utf8' });
}
