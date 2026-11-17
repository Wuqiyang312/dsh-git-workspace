/**
 * The Host half's `apply()` wiring, against a recording Cordis context.
 *
 * No Cordis runtime and no HTTP server: this checks the parts that would
 * otherwise only fail at load time — the three routes, their paths and methods,
 * the `requestBody` mode, and that teardown releases exactly what was
 * registered.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apply } from '../index.js';

/**
 * A stand-in Host context that records routes and effects.
 *
 * `defaultDirectory` points into `os.tmpdir()` because `/defaults` really does
 * `mkdir -p` its clone root; the test must never create directories next to the
 * real workspace.
 */
function createHostContext(defaultDirectory) {
  const routes = [];
  const effects = [];
  const warnings = [];
  const ctx = {
    logger: {
      info: () => {},
      warn: (text) => warnings.push(text),
      error: (text) => warnings.push(text),
    },
    get: (name) => {
      if (name === 'workingDirectory') return { defaultDirectory };
      if (name === 'workspaceRegistry') return { create: async () => ({ id: 'ws', path: 'p', title: 't' }) };
      if (name === 'connection') {
        return {
          fetch: {
            register: (route) => {
              routes.push(route);
              return async () => {};
            },
          },
        };
      }
      return undefined;
    },
    effect: (callback, label) => {
      const dispose = callback();
      effects.push({ label, dispose });
      return dispose;
    },
  };
  return { ctx, routes, effects, warnings };
}

test('apply() registers the three routes with the agreed methods', () => {
  const host = createHostContext(path.join(os.tmpdir(), 'dsh-gw-apply', 'default-workspace'));
  apply(host.ctx, {});

  const byPath = new Map(host.routes.map((route) => [route.path, route]));
  assert.deepEqual([...byPath.keys()].sort(), [
    '/api/git-workspace/clone',
    '/api/git-workspace/defaults',
    '/api/git-workspace/parse',
  ]);
  assert.deepEqual(byPath.get('/api/git-workspace/defaults').methods, ['GET', 'HEAD']);
  assert.deepEqual(byPath.get('/api/git-workspace/parse').methods, ['POST']);
  assert.deepEqual(byPath.get('/api/git-workspace/clone').methods, ['POST']);
  for (const route of host.routes) {
    assert.equal(route.requestBody, 'buffered');
    assert.equal(typeof route.fetch, 'function');
  }
  assert.equal(host.warnings.length, 0);
});

test('apply() serves /defaults from the profile working directory', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-gw-apply-defaults-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const defaultDirectory = path.join(root, 'default-workspace');
  await fs.mkdir(defaultDirectory, { recursive: true });

  const host = createHostContext(defaultDirectory);
  apply(host.ctx, {});
  const route = host.routes.find((entry) => entry.path === '/api/git-workspace/defaults');
  const body = await (await route.fetch(new Request('http://127.0.0.1/api/git-workspace/defaults'))).json();
  assert.equal(body.ok, true);
  /* The derived root is the sibling `repos` directory, and it now exists. */
  assert.equal(body.value.parentDirectory, path.join(root, 'repos'));
  assert.ok((await fs.stat(path.join(root, 'repos'))).isDirectory());
});

test('apply() releases every route on teardown', async () => {
  const host = createHostContext(path.join(os.tmpdir(), 'dsh-gw-apply', 'default-workspace'));
  apply(host.ctx, {});
  assert.equal(host.routes.length, 3);
  assert.equal(host.effects.length, 1);
  /* The single effect owns all three disposers. */
  await host.effects[0].dispose();
});

test('apply() survives a profile without a connection service', () => {
  const warnings = [];
  const ctx = {
    logger: { warn: (text) => warnings.push(text), info: () => {}, error: () => {} },
    get: () => undefined,
    effect: () => {},
  };
  assert.doesNotThrow(() => apply(ctx, {}));
  assert.match(warnings.join('\n'), /connection service is absent/);
});

test('apply() rejects a hostile config value instead of failing to load', () => {
  const host = createHostContext(path.join(os.tmpdir(), 'dsh-gw-apply', 'default-workspace'));
  assert.doesNotThrow(() => apply(host.ctx, { cloneRoot: 42, gitCommand: 'git --upload-pack=calc', timeoutMs: -1 }));
  assert.match(host.warnings.join('\n'), /cloneRoot must be a string/);
  assert.match(host.warnings.join('\n'), /gitCommand cannot contain whitespace/);
});
