import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, readlink, rm} from 'node:fs/promises';
import net from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {createServer, version} from 'wxt';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(import.meta.url);

// Keep the worker's stdin open even in CI. Vite treats stdin EOF as a request
// to exit, which would otherwise produce an apparent success before assertions.
async function launchWorker(mode) {
  const child = spawn(process.execPath, [script, '--worker', mode], {
    cwd: root, stdio: ['pipe', 'inherit', 'inherit', 'ipc'],
  });
  let verified = false;
  child.on('message', message => {
    if (message?.type === 'dev-runner-passed' && message.mode === mode) verified = true;
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 120_000);
  try {
    const {code, signal} = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({code, signal}));
    });
    assert(!timedOut, `Runner ${mode} exceeded its deadline`);
    assert.equal(code, 0, `Runner ${mode} failed (${signal || code})`);
    assert(verified, `Runner ${mode} exited before completing its assertions`);
  } finally {
    clearTimeout(timer);
    child.stdin.destroy();
  }
}

async function browserPid(profile) {
  // Chromium's own lock identifies the process for this exact test profile.
  // Windows uses another lock mechanism, so the server lifecycle still runs
  // there without claiming a PID-based process check.
  if (process.platform === 'win32') return undefined;
  const lock = await readlink(path.join(profile, 'SingletonLock'));
  const pid = Number(lock.match(/-(\d+)$/)?.[1]);
  assert(Number.isSafeInteger(pid) && pid > 0, 'Missing temporary Chromium PID');
  process.kill(pid, 0);
  return pid;
}

async function assertExited(pid) {
  if (pid === undefined) return;
  const deadline = Date.now() + 5_000;
  while (true) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    assert(Date.now() < deadline, `Temporary Chromium process ${pid} did not exit`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function assertServerClosed(port) {
  if (port === undefined) return;
  await new Promise((resolve, reject) => {
    const socket = net.connect({host: '127.0.0.1', port});
    socket.setTimeout(2_000);
    socket.once('connect', () => { socket.destroy(); reject(Error('Dev server is still listening')); });
    socket.once('timeout', () => { socket.destroy(); reject(Error('Dev server closure check timed out')); });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
  });
}

async function exerciseRunner(mode) {
  const directory = await mkdtemp(path.join(tmpdir(), 'archivebox-dev-runner-'));
  const profile = path.join(directory, 'chromium-profile');
  await mkdir(profile);
  const waits = new Set();
  const pids = new Set();
  let server, port, cleanupPromise;
  const evidence = {mode, node: process.version, wxt: version, initializations: 0};
  const injectedFailure = Error('Intentional failure after real browser startup');

  const nextBackground = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Startup can fail before this promise is awaited. Always handle rejection.
    promise.catch(() => {});
    const waiter = {
      finish() { clearTimeout(timer); waits.delete(waiter); resolve(); },
      cancel() { clearTimeout(timer); waits.delete(waiter); resolve(); },
    };
    const timer = setTimeout(() => {
      waits.delete(waiter);
      reject(Error('Actual extension background did not initialize'));
    }, 60_000);
    waits.add(waiter);
    return {promise, cancel: waiter.cancel};
  };

  const phase = async action => {
    const waiting = nextBackground();
    try { await action(); await waiting.promise; }
    finally { waiting.cancel(); }
  };

  const cleanup = () => cleanupPromise ??= (async () => {
    for (const waiter of [...waits]) waiter.cancel();
    assert.equal(waits.size, 0);
    await server?.stop();
    for (const pid of pids) await assertExited(pid);
    await assertServerClosed(port);
    await rm(directory, {recursive: true, force: true});
    evidence.cleanup = 'browser exited, localhost server closed, temporary files removed';
    process.stdin.pause();
  })();

  const onTerminate = () => {
    cleanup().then(() => process.exit(1), error => { console.error(error); process.exit(1); });
  };
  process.once('SIGTERM', onTerminate);
  let failure;
  try {
    server = await createServer({
      root,
      outDir: path.join(directory, 'output'),
      browser: 'chrome',
      dev: {server: {host: '127.0.0.1', origin: '127.0.0.1'}},
      webExt: {
        binaries: {chrome: chromium.executablePath()},
        chromiumArgs: ['--headless=new'], startUrls: ['about:blank'],
        chromiumProfile: profile, keepProfileChanges: true,
      },
      hooks: {'server:created'(wxt, created) {
        server = created;
        assert.equal(wxt.config.runner.canOpen?.(), true, 'Manual runner fallback is a failure');
      }},
    });
    port = server.port;
    server.ws.on('wxt:background-initialized', () => {
      evidence.initializations++;
      for (const waiter of [...waits]) waiter.finish();
    });
    await phase(() => server.start());
    const firstPid = await browserPid(profile);
    if (firstPid !== undefined) pids.add(firstPid);
    // Fail with a background waiter already armed, proving its timer is
    // cancelled when an action rejects before an initialization can arrive.
    if (mode === 'startup-failure') await phase(() => Promise.reject(injectedFailure));
    await phase(() => server.reloadExtension());
    await phase(() => server.restartBrowser());
    await assertExited(firstPid);
    const secondPid = await browserPid(profile);
    if (secondPid !== undefined) {
      assert.notEqual(secondPid, firstPid, 'Browser was not actually restarted');
      pids.add(secondPid);
    }
    assert(evidence.initializations >= 3);
    evidence.lifecycle = 'launch, extension reload, browser restart';
  } catch (error) {
    if (mode === 'startup-failure' && error === injectedFailure) evidence.expectedFailure = true;
    else failure = error;
  } finally {
    try { await cleanup(); }
    catch (error) { failure = failure ? new AggregateError([failure, error]) : error; }
    process.removeListener('SIGTERM', onTerminate);
  }
  if (failure) throw failure;
  if (mode === 'startup-failure') assert.equal(evidence.expectedFailure, true);
  evidence.browserProcessChecks = process.platform === 'win32' ? 'not available on Windows' : 'exact temporary-profile PIDs exited';
  console.log('Dev runner regression passed: ' + JSON.stringify(evidence));
  if (process.send) {
    await new Promise((resolve, reject) => process.send({type: 'dev-runner-passed', mode}, error => error ? reject(error) : resolve()));
    process.disconnect();
  }
}

if (process.argv[2] === '--worker') await exerciseRunner(process.argv[3]);
else {
  await launchWorker('lifecycle');
  await launchWorker('startup-failure');
}
