import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));

export interface LaunchedServer {
  proc: ChildProcess;
  url: string;
}

/**
 * Spawns the real backend (tests/server-fixture.ts) against a throwaway
 * database with a bootstrapped admin, mirroring a fresh production install.
 * The backend also serves ../frontend/dist, so this one process covers both
 * the UI under test and the API. Requires the frontend to be built first.
 *
 * Set E2E_RUNTIME=dist to exercise the compiled production artifact
 * (node dist/server/index.js, requires `npm run build` first) instead of
 * the tsx source runner.
 */
export async function launchServer(): Promise<LaunchedServer> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'relay-e2e-'));
  const dbName = `relay_e2e_${Date.now().toString(36)}`;
  const useDist = process.env.E2E_RUNTIME === 'dist';
  const port = useDist ? await freePort() : 0;
  const proc = spawn(
    process.execPath,
    useDist
      ? [path.join(project, 'dist/server/index.js')]
      : ['--import', import.meta.resolve('tsx'), path.join(project, 'tests/server-fixture.ts')],
    {
      cwd: project,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        ADMIN_TOKEN: '',
        SEED_DEMO: 'false',
        CODEBUDDY_LIVE: 'false',
        RESEND_API_KEY: '',
        BOOTSTRAP_ADMIN_EMAIL: 'e2e-owner@relay.test',
        BOOTSTRAP_ADMIN_PASSWORD: 'e2e-owner-pass-123',
        BOOTSTRAP_ADMIN_NAME: 'E2E Owner',
        MONGODB_DB: dbName,
        ...(useDist ? { PORT: String(port) } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (useDist) {
    const url = await waitForHealth(port, proc);
    return { proc, url };
  }
  const url = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`E2E server startup timed out: ${output}`));
    }, 30000);
    proc.stdout!.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/READY:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    proc.stderr!.on('data', (chunk) => {
      output += chunk;
    });
    proc.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`E2E server exited ${code}: ${output}`));
    });
  });
  return { proc, url };
}

export async function stopServer(proc: ChildProcess): Promise<void> {
  if (proc.exitCode === null && proc.signalCode === null) {
    const done = once(proc, 'exit');
    proc.kill();
    await done;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Waits for the compiled server's health endpoint (it prints no READY line). */
async function waitForHealth(port: number, proc: ChildProcess): Promise<string> {
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error(`E2E dist server exited ${proc.exitCode} before becoming healthy`);
    }
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return url;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error('E2E dist server did not become healthy within 30s');
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}
