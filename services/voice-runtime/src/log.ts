/** One JSON line per event, so the compose/cluster log pipeline can parse it. */
type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = (): number => ORDER[(process.env.VOICE_RUNTIME_LOG_LEVEL as Level) || 'info'] ?? 20;

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold()) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, svc: 'voice-runtime', msg, ...fields });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => write('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => write('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => write('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => write('error', msg, f),
};
