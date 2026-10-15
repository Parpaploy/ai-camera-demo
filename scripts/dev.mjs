import net from 'node:net';
import { spawn } from 'node:child_process';

const host = process.env.DATA_API_HOST ?? '127.0.0.1';
const port = Number(process.env.DATA_API_PORT ?? 8787);
const children = new Set();
let stopping = false;
let api;
let vite;

function launch(args, label) {
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
  children.add(child);
  child.once('error', error => {
    console.error(`Cannot start ${label}: ${error.message}`);
    if (!stopping) shutdown(1);
  });
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`${label} stopped${signal ? ` (${signal})` : ` with code ${code}`}`);
      shutdown(code || 1);
    }
  });
  return child;
}

function canConnect() {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(400);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

async function waitForApi(child) {
  for (let i = 0; i < 40; i++) {
    if (stopping || child.exitCode !== null) throw new Error('Data API exited before it was ready');
    if (await canConnect()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Data API did not listen on ${host}:${port}`);
}

async function supportsOllamaApi() {
  try {
    const response = await fetch(`http://${host}:${port}/api/ai/ollama/models`, {
      signal: AbortSignal.timeout(1500),
    });
    // The current API returns 200 when Ollama responds, or 503 when the
    // Ollama endpoint itself is unreachable. A 401/404 means this is an old
    // Data API process that does not know the Ollama routes.
    return response.status === 200 || response.status === 503;
  } catch {
    return false;
  }
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
  setTimeout(() => process.exit(code), 3000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown());

try {
  if (!(await canConnect())) {
    api = launch(['--env-file=.env.server', 'server/index.mjs'], 'Data API');
    await waitForApi(api);
  } else {
    if (!(await supportsOllamaApi())) {
      throw new Error(`Data API on ${host}:${port} does not expose the Ollama routes. Stop the old Data API process, then run npm run dev again.`);
    }
    console.log(`Using Data API already listening on ${host}:${port}`);
  }
  if (stopping) process.exit(0);
  vite = launch(['node_modules/vite/bin/vite.js', ...process.argv.slice(2)], 'Vite');
} catch (error) {
  console.error(`Cannot start dashboard: ${error.message}`);
  console.error('Check that .env.server exists, contains TiDB/admin/Ollama settings, and port 8787 is available.');
  shutdown(1);
}
