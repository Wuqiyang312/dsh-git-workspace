/**
 * `cloneRepository` against repositories created inside `os.tmpdir()`.
 *
 * Nothing here touches the network or the user's repositories: the source is a
 * throwaway repository made with `git init` and one commit, and the clone
 * target is a sibling temporary directory. Both are removed afterwards.
 *
 * `cloneRepository` is driven directly (not through the HTTP routes), and the
 * timeout path uses an injected child-process factory so it never has to wait
 * ten real minutes.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  STAGING_PREFIX,
  buildCloneArgs,
  cloneRepository,
  killProcessTree,
  planClone,
  positiveInteger,
  readTail,
  timeoutMessage,
} from '../src/clone.js';

/**
 * Run one git command in argv form, with its output redirected to files rather
 * than pipes.
 *
 * Pipes are the convenient spelling, but a piped child process is a named-pipe
 * pair on Windows, and some sandboxes forbid that outright (`spawn EPERM`).
 * Files work in both cases, and they are also what `clone.js` itself uses.
 */
async function git(cwd, args) {
  const token = `${process.pid}-${Math.random().toString(16).slice(2)}`;
  const outPath = path.join(os.tmpdir(), `dsh-gw-git-${token}.out`);
  const errPath = path.join(os.tmpdir(), `dsh-gw-git-${token}.err`);
  const outFd = fsSync.openSync(outPath, 'w');
  const errFd = fsSync.openSync(errPath, 'w');
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(
        'git',
        [
          '-c',
          'user.name=git-workspace test',
          '-c',
          'user.email=git-workspace@example.invalid',
          '-c',
          'commit.gpgsign=false',
          '-c',
          'init.defaultBranch=main',
          ...args,
        ],
        {
          cwd,
          windowsHide: true,
          shell: false,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          stdio: ['ignore', outFd, errFd],
        },
      );
      child.on('error', reject);
      child.on('close', (exitCode) => resolve(exitCode));
    });
    if (code !== 0) {
      throw new Error(`git ${args.join(' ')} failed (${code}): ${fsSync.readFileSync(errPath, 'utf8')}`);
    }
  } finally {
    fsSync.closeSync(outFd);
    fsSync.closeSync(errFd);
    await fs.rm(outPath, { force: true });
    await fs.rm(errPath, { force: true });
  }
}

/** A fresh directory under the OS temp directory, named for this test. */
function makeRoot(label) {
  return fs.mkdtemp(path.join(os.tmpdir(), `dsh-gw-${label}-`));
}

/** A repository with exactly one commit on `main`. */
async function makeSourceRepo(root) {
  const source = path.join(root, 'source');
  await fs.mkdir(source, { recursive: true });
  await git(source, ['init', '-q']);
  await fs.writeFile(path.join(source, 'README.md'), '# fixture\n', 'utf8');
  await git(source, ['add', 'README.md']);
  await git(source, ['commit', '-q', '-m', 'fixture commit']);
  return source;
}

/** Every staging directory left anywhere under `parent`. */
async function stagingLeftovers(parent) {
  const entries = await fs.readdir(parent, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(STAGING_PREFIX)).map((entry) => entry.name);
}

/* --------------------------------------------------------------- pure planning */

test('planClone rejects a folder name that is not one segment', () => {
  const base = { url: 'https://github.com/o/r', parentDirectory: path.resolve(os.tmpdir()) };
  for (const folderName of ['..', '.', 'a/b', 'a\\b', '../escape']) {
    assert.throws(() => planClone({ ...base, folderName }), /folder name/i, `expected ${folderName} to be rejected`);
  }
});

test('planClone rejects a relative parent directory', () => {
  assert.throws(() => planClone({ url: 'https://github.com/o/r', parentDirectory: 'relative/dir' }), /absolute path/i);
});

test('planClone builds an argv vector with no shell metacharacters', () => {
  const plan = planClone({
    url: 'https://github.com/o/r.git',
    parentDirectory: path.resolve(os.tmpdir()),
    folderName: 'r',
    branch: 'demo-branch',
    depth: 1,
  });
  const argv = buildCloneArgs({
    cloneUrl: plan.parsed.cloneUrl,
    branch: 'demo-branch',
    depth: 1,
    targetPath: plan.stagingPath,
  });
  assert.equal(argv[0], 'clone');
  assert.ok(argv.includes('--branch') && argv.includes('demo-branch'));
  assert.ok(argv.includes('--depth=1'));
  assert.equal(argv[argv.length - 2], 'https://github.com/o/r.git');
  assert.equal(argv[argv.length - 1], plan.stagingPath);
  /* The URL is its own argv element, never concatenated into a command line. */
  assert.ok(!argv.some((part) => /[;&|`$]/.test(part)));
});

test('planClone refuses a branch git would read as an option', () => {
  assert.throws(
    () => planClone({ url: 'https://github.com/o/r', parentDirectory: path.resolve(os.tmpdir()), branch: '--upload-pack=calc' }),
    /branch/i,
  );
});

test('readTail keeps only the tail of a large file', async (t) => {
  const root = await makeRoot('tail');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'log.txt');
  await fs.writeFile(file, `${'a'.repeat(100_000)}END`, 'utf8');
  const tail = await readTail(file, 64);
  assert.equal(tail.truncated, true);
  assert.equal(tail.text, `${'a'.repeat(61)}END`);
  /* Smaller than the requested cap, not the 100 KiB on disk. */
  assert.ok(Buffer.byteLength(tail.text, 'utf8') <= 64);
  assert.deepEqual(await readTail(path.join(root, 'missing.txt'), 64), { text: '', truncated: false });
});

test('positiveInteger keeps usable config values only', () => {
  assert.equal(positiveInteger(600000, 1, 3_600_000), 600000);
  assert.equal(positiveInteger('600', 1, 3_600_000), 600);
  assert.equal(positiveInteger(0, 7, 10), 7);
  assert.equal(positiveInteger(-3, 7, 10), 7);
  assert.equal(positiveInteger('nonsense', 7, 10), 7);
  assert.equal(positiveInteger(undefined, 7, 10), 7);
  assert.equal(positiveInteger(1e9, 7, 10), 10);
});

/* ----------------------------------------------------------------- real clones */

test('a successful clone lands at the exact destination', async (t) => {
  const root = await makeRoot('ok');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = await makeSourceRepo(root);
  const parent = path.join(root, 'targets');

  const result = await cloneRepository({
    url: pathToFileURL(source).href,
    parentDirectory: parent,
    folderName: 'cloned',
  });

  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  assert.equal(result.value.path, path.join(parent, 'cloned'));
  assert.equal(result.value.folderName, 'cloned');
  assert.equal(await fs.readFile(path.join(parent, 'cloned', 'README.md'), 'utf8'), '# fixture\n');
  assert.deepEqual(await stagingLeftovers(parent), []);
  /* The .git directory survived the rename: this is a real clone. */
  assert.ok((await fs.stat(path.join(parent, 'cloned', '.git'))).isDirectory());
});

test('a requested branch is checked out', async (t) => {
  const root = await makeRoot('branch');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = await makeSourceRepo(root);
  await git(source, ['checkout', '-q', '-b', 'demo-branch']);
  await fs.writeFile(path.join(source, 'branch.txt'), 'motor\n', 'utf8');
  await git(source, ['add', 'branch.txt']);
  await git(source, ['commit', '-q', '-m', 'branch commit']);
  await git(source, ['checkout', '-q', 'main']);
  const parent = path.join(root, 'targets');

  const result = await cloneRepository({
    url: pathToFileURL(source).href,
    parentDirectory: parent,
    folderName: 'onbranch',
    branch: 'demo-branch',
  });

  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  assert.equal(result.value.branch, 'demo-branch');
  assert.equal(await fs.readFile(path.join(parent, 'onbranch', 'branch.txt'), 'utf8'), 'motor\n');
});

test('a target that already exists is refused and left untouched', async (t) => {
  const root = await makeRoot('exists');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = await makeSourceRepo(root);
  const parent = path.join(root, 'targets');
  await fs.mkdir(parent);
  const occupied = path.join(parent, 'taken');
  await fs.mkdir(occupied);
  await fs.writeFile(path.join(occupied, 'keep.txt'), 'must survive\n', 'utf8');

  const result = await cloneRepository({
    url: pathToFileURL(source).href,
    parentDirectory: parent,
    folderName: 'taken',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'git-workspace/target-exists');
  assert.equal(await fs.readFile(path.join(occupied, 'keep.txt'), 'utf8'), 'must survive\n');
  assert.deepEqual(await stagingLeftovers(parent), []);
});

test('a failing clone cleans its staging directory and reports the git diagnostics', async (t) => {
  const root = await makeRoot('fail');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const parent = path.join(root, 'targets');
  await fs.mkdir(parent, { recursive: true });
  const missing = pathToFileURL(path.join(root, 'does-not-exist')).href;

  const result = await cloneRepository({ url: missing, parentDirectory: parent, folderName: 'nope' });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'git-workspace/clone-failed');
  /* git's own words are carried through, so the dialog can explain itself. */
  assert.match(result.error.message, /git clone failed/i);
  assert.deepEqual(await stagingLeftovers(parent), []);
  await assert.rejects(fs.stat(path.join(parent, 'nope')));
});

test('a failing clone that cannot clean its staging directory says so in the message', async (t) => {
  const root = await makeRoot('fail-cleanup');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const parent = path.join(root, 'targets');
  await fs.mkdir(parent, { recursive: true });
  const missing = pathToFileURL(path.join(root, 'does-not-exist')).href;

  /* Only the staging directory's removal fails; the temporary output files in
     `runGit` are removed through the same call and must keep working. */
  const realRm = fs.rm;
  mock.method(fs, 'rm', async (target, options) => {
    if (String(target).includes(STAGING_PREFIX)) throw new Error('EBUSY: resource busy or locked');
    return realRm.call(fs, target, options);
  });
  try {
    const result = await cloneRepository({
      url: missing,
      parentDirectory: parent,
      folderName: 'nope',
      logger: { warn: () => {} },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'git-workspace/clone-failed');
    /* A surviving staging directory is part of the outcome: it is a directory
       the user has to delete by hand, so it belongs in `message`, not only in a
       logger warning nobody reads. */
    assert.match(result.error.message, /The staging directory .* could not be removed: EBUSY/);
    assert.match(result.error.message, /git clone failed/i);
  } finally {
    mock.restoreAll();
  }
  /* The mocked removal did not happen, so the leftover is still there; clean it
     up through the real implementation. */
  await fs.rm(parent, { recursive: true, force: true });
});

test('a clone that cannot be moved into place reports a staging directory that survived cleanup', async (t) => {
  const root = await makeRoot('move-failed');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = await makeSourceRepo(root);
  const parent = path.join(root, 'targets');

  /* The clone itself succeeds; the rename into place fails (a locked target is
     the measured Windows case), and the staging cleanup fails too. */
  const realRm = fs.rm;
  mock.method(fs, 'rename', async () => {
    throw new Error('EPERM: operation not permitted, rename');
  });
  mock.method(fs, 'rm', async (target, options) => {
    if (String(target).includes(STAGING_PREFIX)) throw new Error('EBUSY: resource busy or locked');
    return realRm.call(fs, target, options);
  });
  let result;
  try {
    result = await cloneRepository({
      url: pathToFileURL(source).href,
      parentDirectory: parent,
      folderName: 'landed',
      logger: { warn: () => {} },
    });
  } finally {
    mock.restoreAll();
  }

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'git-workspace/move-failed');
  assert.match(result.error.message, /could not be moved to/);
  assert.match(result.error.message, /EPERM/);
  /* Same contract as the clone-failed branch: a staging directory that survived
     cleanup is reported in the message, not just in the log. */
  assert.match(result.error.message, /The staging directory .* could not be removed: EBUSY/);

  const leftovers = await stagingLeftovers(parent);
  assert.equal(leftovers.length, 1, 'the staging directory really is still there');
  await fs.rm(parent, { recursive: true, force: true });
});

test('an unsafe folder name is refused before any process runs', async (t) => {
  const root = await makeRoot('unsafe');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = await makeSourceRepo(root);
  const parent = path.join(root, 'targets');
  await fs.mkdir(parent);
  let spawned = false;

  for (const folderName of ['a/b', '..', '.']) {
    const result = await cloneRepository({
      url: pathToFileURL(source).href,
      parentDirectory: parent,
      folderName,
      spawn: () => {
        spawned = true;
        throw new Error('must not spawn');
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'git-workspace/invalid-folder-name');
  }
  assert.equal(spawned, false);
  assert.deepEqual(await fs.readdir(parent), []);
});

/* ------------------------------------------------------- injected child process */

test('a timeout kills the process and removes the staging directory', async (t) => {
  const root = await makeRoot('timeout');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const parent = path.join(root, 'targets');
  let killed = 0;

  /* A stand-in process that never exits on its own; the killer makes it exit. */
  const fakeSpawn = () => {
    let closeHandler = () => {};
    const child = {
      pid: 4242,
      on(event, handler) {
        if (event === 'close') closeHandler = handler;
      },
      kill() {
        killed += 1;
        closeHandler(1, 'SIGKILL');
      },
    };
    return child;
  };

  const startedAt = Date.now();
  const result = await cloneRepository({
    url: 'https://github.com/o/r',
    parentDirectory: parent,
    folderName: 'slow',
    timeoutMs: 80,
    spawn: fakeSpawn,
    kill: (child) => child.kill(),
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'git-workspace/clone-timeout');
  assert.equal(killed, 1);
  assert.ok(elapsed < 5000, `the timeout must be honoured, took ${elapsed}ms`);
  assert.deepEqual(await stagingLeftovers(parent), []);
});

test('git that cannot be started reports a spawn failure', async (t) => {
  const root = await makeRoot('nospawn');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const parent = path.join(root, 'targets');

  const fakeSpawn = () => {
    const child = {
      pid: 4244,
      on(event, handler) {
        if (event === 'error') handler(new Error('ENOENT: git not found'));
      },
      kill() {},
    };
    return child;
  };

  const result = await cloneRepository({
    url: 'https://github.com/o/r',
    parentDirectory: parent,
    folderName: 'nogit',
    spawn: fakeSpawn,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'git-workspace/spawn-failed');
  assert.match(result.error.message, /ENOENT/);
  assert.deepEqual(await stagingLeftovers(parent), []);
});

test('a second clone of the same destination is refused while the first runs', async (t) => {
  const root = await makeRoot('busy');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = await makeSourceRepo(root);
  const parent = path.join(root, 'targets');
  const url = pathToFileURL(source).href;

  const first = cloneRepository({ url, parentDirectory: parent, folderName: 'same' });
  /* Let the first request claim the destination before asking again. */
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await cloneRepository({ url, parentDirectory: parent, folderName: 'same' });
  const firstResult = await first;

  assert.equal(firstResult.ok, true, firstResult.ok === false ? firstResult.error.message : '');
  assert.equal(second.ok, false);
  /* Either refusal is correct: the busy guard, or the destination the first run
     had already created when the two requests did not overlap. */
  assert.ok(
    second.error.code === 'git-workspace/clone-busy' || second.error.code === 'git-workspace/target-exists',
    `unexpected code ${second.error.code}`,
  );
});

/* ------------------------------------------------- timeout wording and killers */

test('the timeout message claims a stop only when the exit was observed', () => {
  const unconfirmed = timeoutMessage({ timeoutMs: 1200, exited: false });
  /* Evidence, not optimism: without an `exit` event the process may still be
     alive and may still be writing into the staging directory. */
  assert.equal(unconfirmed.includes('was stopped'), false, unconfirmed);
  assert.ok(unconfirmed.includes('A stop was requested'), unconfirmed);
  assert.ok(unconfirmed.includes('may still be running'), unconfirmed);

  const observed = timeoutMessage({ timeoutMs: 1200, exited: true });
  assert.ok(observed.includes('exit observed'), observed);
  assert.equal(observed.includes('may still be running'), false, observed);
  assert.equal(observed.includes('A stop was requested'), false, observed);

  /* The grace window is reported in the wording, because "5s" is the reason the
     result arrived when it did. */
  const shortGrace = timeoutMessage({ timeoutMs: 1200, exited: false, graceMs: 50 });
  assert.ok(shortGrace.includes('not confirmed within 0.1s'), shortGrace);

  /* The limit itself is reported to one decimal: `Math.round(1200 / 1000)`
     claimed "within 1s", which is not the limit that expired. Whole minutes keep
     their integer spelling. */
  assert.ok(unconfirmed.includes('within 1.2s'), unconfirmed);
  assert.ok(observed.includes('within 1.2s'), observed);
  assert.equal(unconfirmed.includes('within 1s'), false, unconfirmed);
  const tenMinutes = timeoutMessage({ timeoutMs: 600_000, exited: false });
  assert.ok(tenMinutes.includes('within 600s'), tenMinutes);
  const quarter = timeoutMessage({ timeoutMs: 250, exited: true });
  assert.ok(quarter.includes('within 0.3s'), quarter);
});

/** A stand-in child that never exits until the test's killer makes it. */
function survivingChild(pid) {
  const handlers = { close: [], exit: [], error: [] };
  return {
    pid,
    on(event, handler) {
      handlers[event]?.push(handler);
    },
    kill(signal) {
      for (const handler of handlers.close) handler(1, signal);
      for (const handler of handlers.exit) handler(1, signal);
    },
  };
}

test('a timeout whose stop request is ignored reports "may still be running"', async (t) => {
  const root = await makeRoot('timeout-noop');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const parent = path.join(root, 'targets');

  const result = await cloneRepository({
    url: 'https://github.com/o/r',
    parentDirectory: parent,
    folderName: 'stuck',
    timeoutMs: 60,
    /* Short grace window (the option exists for this): the clone must not wait
       five real seconds to report that the stop was never confirmed. */
    killGraceMs: 50,
    spawn: () => survivingChild(4243),
    /* A killer that does nothing: exactly the "taskkill was refused" outcome. */
    kill: () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'git-workspace/clone-timeout');
  assert.equal(result.error.message.includes('was stopped'), false, result.error.message);
  assert.match(result.error.message, /A stop was requested/);
  assert.match(result.error.message, /may still be running/);
  /* The staging directory is still removed, even though the child may hold it. */
  assert.deepEqual(await stagingLeftovers(parent), []);
  await assert.rejects(fs.stat(path.join(parent, 'stuck')));
});

test('a timeout whose child really exited reports the observed exit', async (t) => {
  const root = await makeRoot('timeout-exit');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const parent = path.join(root, 'targets');
  let killCalls = 0;

  const result = await cloneRepository({
    url: 'https://github.com/o/r',
    parentDirectory: parent,
    folderName: 'stopped',
    timeoutMs: 60,
    killGraceMs: 50,
    spawn: () => survivingChild(4245),
    kill: (child) => {
      killCalls += 1;
      child.kill('SIGKILL');
    },
  });

  assert.equal(killCalls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'git-workspace/clone-timeout');
  assert.match(result.error.message, /exit observed/);
  assert.equal(result.error.message.includes('may still be running'), false, result.error.message);
  assert.deepEqual(await stagingLeftovers(parent), []);
});

test('killProcessTree falls back to SIGKILL when taskkill fails, and only then', async () => {
  const child = {
    pid: 4246,
    kills: [],
    kill(signal) {
      this.kills.push(signal);
    },
  };
  const killer = new EventEmitter();
  const spawned = [];
  const promise = killProcessTree(child, {
    platform: 'win32',
    spawnKiller: (command, args, options) => {
      spawned.push({ command, args, options });
      return killer;
    },
  });

  assert.deepEqual(spawned, [
    { command: 'taskkill', args: ['/pid', '4246', '/T', '/F'], options: { windowsHide: true, stdio: 'ignore' } },
  ]);

  /* taskkill exits non-zero ("Access denied" on the measured host): the direct
     signal is what actually ends the child, so it must be sent. */
  killer.emit('exit', 1);
  await promise;
  assert.deepEqual(child.kills, ['SIGKILL']);

  /* A late second event must not signal the child again. */
  killer.emit('exit', 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(child.kills, ['SIGKILL']);

  /* Success (code 0) is trusted: no fallback signal. */
  const trusted = { pid: 4247, kills: [], kill(signal) { this.kills.push(signal); } };
  const successfulKiller = new EventEmitter();
  const resolved = killProcessTree(trusted, {
    platform: 'win32',
    spawnKiller: () => successfulKiller,
  });
  successfulKiller.emit('exit', 0);
  await resolved;
  assert.deepEqual(trusted.kills, []);
});

test('killProcessTree signals the child directly off Windows, or when the killer throws', async () => {
  const direct = { pid: 4248, kills: [], kill(signal) { this.kills.push(signal); } };
  await killProcessTree(direct, { platform: 'linux' });
  assert.deepEqual(direct.kills, ['SIGKILL']);

  /* A spawn failure (no taskkill, or no permission to start it) must still end
     the direct child rather than resolve silently. */
  const failed = { pid: 4249, kills: [], kill(signal) { this.kills.push(signal); } };
  await killProcessTree(failed, {
    platform: 'win32',
    spawnKiller: () => {
      throw new Error('spawn EPERM');
    },
  });
  assert.deepEqual(failed.kills, ['SIGKILL']);

  /* A child without a pid cannot be targeted by taskkill at all. */
  const pidless = { kills: [], kill(signal) { this.kills.push(signal); } };
  await killProcessTree(pidless, { platform: 'win32', spawnKiller: () => new EventEmitter() });
  assert.deepEqual(pidless.kills, ['SIGKILL']);

  await killProcessTree(null, { platform: 'win32' });
});
