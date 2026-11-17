/**
 * The Host request handlers, driven directly (no Cordis context, no HTTP server).
 *
 * The clone endpoint runs a real `git clone` of a throwaway repository in
 * `os.tmpdir()`, with a stub workspace registry standing in for
 * `ctx.workspaceRegistry`, so the whole wiring — validation, clone, rename,
 * registration, JSON shape — is exercised once.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { DEFAULT_CLONE_DIR_NAME, createHandlers, normalizeConfig, readJsonBody } from '../index.js';

/** Run one git command with its output redirected to files (pipes are refused in some sandboxes). */
async function git(cwd, args) {
  const token = `${process.pid}-${Math.random().toString(16).slice(2)}`;
  const outPath = path.join(os.tmpdir(), `dsh-gw-routes-${token}.out`);
  const errPath = path.join(os.tmpdir(), `dsh-gw-routes-${token}.err`);
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

/** A JSON POST request around a payload (or raw text). */
function post(payload) {
  return new Request('http://127.0.0.1/api/git-workspace/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

function makeRoot(label) {
  return fs.mkdtemp(path.join(os.tmpdir(), `dsh-gw-routes-${label}-`));
}

test('readJsonBody rejects malformed JSON with 400 and a stable code', async () => {
  const result = await readJsonBody(post('{oops'), 1024);
  assert.equal(result.ok, false);
  assert.equal(result.response.status, 400);
  assert.equal((await result.response.json()).error.code, 'git-workspace/invalid-json');
});

test('readJsonBody rejects a body over the cap with 413', async () => {
  const result = await readJsonBody(post({ url: 'x'.repeat(500) }), 64);
  assert.equal(result.ok, false);
  assert.equal(result.response.status, 413);
  assert.equal((await result.response.json()).error.code, 'git-workspace/body-too-large');
});

test('readJsonBody rejects a non-object payload', async () => {
  const result = await readJsonBody(post('[1,2]'), 1024);
  assert.equal(result.ok, false);
  assert.equal(result.response.status, 400);
});

test('normalizeConfig keeps usable values and warns about the rest', () => {
  const warnings = [];
  const config = normalizeConfig(
    { cloneRoot: 'relative/place', gitCommand: 'git --version', timeoutMs: 'nope', shallow: true },
    { warn: (text) => warnings.push(text) },
  );
  /* A relative clone root and a whitespace-laden command are both refused. */
  assert.equal(config.cloneRoot, '');
  assert.equal(config.gitCommand, 'git');
  assert.equal(config.timeoutMs, 600000);
  assert.equal(config.shallow, true);
  assert.equal(warnings.length, 2);
});

test('GET /defaults derives <dirname>/repos and creates it', async (t) => {
  const root = await makeRoot('defaults');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const defaultDirectory = path.join(root, 'default-workspace');
  await fs.mkdir(defaultDirectory, { recursive: true });

  const handlers = createHandlers({
    config: normalizeConfig({}),
    defaultDirectory: () => defaultDirectory,
    registry: () => undefined,
  });

  const response = await handlers.defaults();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  const expected = path.join(root, DEFAULT_CLONE_DIR_NAME);
  assert.equal(body.value.parentDirectory, expected);
  assert.equal(body.value.shallow, false);
  assert.equal(body.value.configured, false);
  assert.equal(body.value.platform, process.platform);
  assert.ok((await fs.stat(expected)).isDirectory());
});

test('GET /defaults prefers an explicit cloneRoot', async (t) => {
  const root = await makeRoot('root');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cloneRoot = path.join(root, 'elsewhere', 'repos');

  const handlers = createHandlers({
    config: normalizeConfig({ cloneRoot }),
    defaultDirectory: () => path.join(root, 'default-workspace'),
    registry: () => undefined,
  });

  const body = await (await handlers.defaults()).json();
  assert.equal(body.value.parentDirectory, cloneRoot);
  assert.equal(body.value.configured, true);
});

test('POST /parse returns the parsed address or a stable error code', async () => {
  const handlers = createHandlers({
    config: normalizeConfig({}),
    defaultDirectory: () => path.join(os.tmpdir(), 'default-workspace'),
    registry: () => undefined,
  });

  const ok = await (await handlers.parse(post({ url: 'https://github.com/octocat/Hello-World/tree/test' }))).json();
  assert.equal(ok.ok, true);
  assert.equal(ok.value.folderName, 'Hello-World');
  assert.equal(ok.value.branch, 'test');

  const bad = await (await handlers.parse(post({ url: '-u' }))).json();
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'git-workspace/unsafe-url');
});

test('POST /clone requires a URL and an absolute parent directory', async () => {
  const handlers = createHandlers({
    config: normalizeConfig({}),
    defaultDirectory: () => path.join(os.tmpdir(), 'default-workspace'),
    registry: () => undefined,
  });

  const missing = await handlers.clone(post({}));
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, 'git-workspace/missing-url');

  const relative = await handlers.clone(post({ url: 'https://github.com/o/r', parentDirectory: 'relative' }));
  assert.equal(relative.status, 400);
  assert.equal((await relative.json()).error.code, 'git-workspace/invalid-parent-directory');
});

test('POST /clone clones and reports the registered workspace', async (t) => {
  const root = await makeRoot('clone');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const source = path.join(root, 'source');
  await fs.mkdir(source, { recursive: true });
  await git(source, ['init', '-q']);
  await fs.writeFile(path.join(source, 'README.md'), '# handler fixture\n', 'utf8');
  await git(source, ['add', 'README.md']);
  await git(source, ['commit', '-q', '-m', 'fixture']);

  const parent = path.join(root, 'repos');
  const created = [];
  const handlers = createHandlers({
    config: normalizeConfig({}),
    defaultDirectory: () => path.join(root, 'default-workspace'),
    registry: () => ({
      create: async (directory, title) => {
        created.push({ directory, title });
        return { id: 'ws-1', path: directory, title };
      },
    }),
  });

  const response = await handlers.clone(
    post({ url: pathToFileURL(source).href, parentDirectory: parent, folderName: 'handler-clone' }),
  );
  const body = await response.json();
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.deepEqual(body.value.workspace, {
    workspaceId: 'ws-1',
    path: path.join(parent, 'handler-clone'),
    title: 'handler-clone',
  });
  assert.equal(body.value.folderName, 'handler-clone');
  assert.equal(created.length, 1);
  assert.equal(created[0].directory, path.join(parent, 'handler-clone'));
});

test('POST /clone reports a missing registry without deleting the clone', async (t) => {
  const root = await makeRoot('noregistry');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await fs.mkdir(source, { recursive: true });
  await git(source, ['init', '-q']);
  await fs.writeFile(path.join(source, 'file.txt'), 'x\n', 'utf8');
  await git(source, ['add', 'file.txt']);
  await git(source, ['commit', '-q', '-m', 'fixture']);

  const parent = path.join(root, 'repos');
  const handlers = createHandlers({
    config: normalizeConfig({}),
    defaultDirectory: () => path.join(root, 'default-workspace'),
    registry: () => undefined,
  });

  const body = await (
    await handlers.clone(post({ url: pathToFileURL(source).href, parentDirectory: parent, folderName: 'kept' }))
  ).json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'git-workspace/no-workspace-registry');
  /* The user's repository is still there; only the registration is missing. */
  assert.ok((await fs.stat(path.join(parent, 'kept', '.git'))).isDirectory());
});
