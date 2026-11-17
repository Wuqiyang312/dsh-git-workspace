/**
 * R5 regression: a clone response from an *earlier* dialog session must not
 * close the dialog that is open now, and must not start a session.
 *
 * The bug was a state machine, not a typo, so this test drives the real
 * component instead of grepping it. There is no renderer here: the file
 * supplies a small hooks implementation (useState/useRef/useEffect with
 * dependency arrays, re-render on state change, effect cleanup) and plain
 * objects from `createElement`, which is enough to walk the returned tree and
 * fire the handlers the browser would fire — input `onChange`, form
 * `onSubmit`, the document-level `keydown` listener Escape uses.
 *
 * What it therefore does *not* prove: that the DOM the component describes
 * looks or behaves right on screen. Rendering stays unverified.
 */
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'client.js');

/** Let every queued microtask (and the component's own timers) run. */
async function settle() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * A minimal React: hooks with stable slots per component, dependency-compared
 * effects with cleanup, and synchronous re-render on a state change.
 */
function createReact() {
  const instances = new Map();
  const renders = new Map();
  const queue = new Set();
  let current = null;
  let component = null;
  let flushing = false;

  function slot(kind) {
    const index = current.index;
    current.index += 1;
    let entry = current.hooks[index];
    if (entry === undefined) {
      entry = { kind, instance: current, component };
      current.hooks[index] = entry;
    }
    assert.equal(entry.kind, kind, 'hooks must be called in a stable order');
    return entry;
  }

  function schedule(target) {
    queue.add(target);
    flush();
  }

  function flush() {
    if (flushing) return;
    flushing = true;
    try {
      let guard = 0;
      while (queue.size > 0) {
        if (guard > 200) throw new Error('render did not settle');
        guard += 1;
        const next = [...queue][0];
        queue.delete(next);
        render(next);
      }
    } finally {
      flushing = false;
    }
  }

  function runEffects(instance) {
    const pending = instance.pending;
    instance.pending = [];
    for (const entry of pending) {
      if (typeof entry.cleanup === 'function') entry.cleanup();
      const result = entry.fn();
      entry.cleanup = typeof result === 'function' ? result : undefined;
    }
  }

  function render(target) {
    let instance = instances.get(target);
    if (instance === undefined) {
      instance = { hooks: [], index: 0, pending: [] };
      instances.set(target, instance);
    }
    instance.index = 0;
    const previousInstance = current;
    const previousComponent = component;
    current = instance;
    component = target;
    let tree;
    try {
      tree = target();
    } finally {
      current = previousInstance;
      component = previousComponent;
    }
    renders.set(target, tree);
    runEffects(instance);
    return tree;
  }

  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const entry = slot('state');
      if (!('value' in entry)) entry.value = typeof initial === 'function' ? initial() : initial;
      const set = (next) => {
        const value = typeof next === 'function' ? next(entry.value) : next;
        if (Object.is(value, entry.value)) return;
        entry.value = value;
        schedule(entry.component);
      };
      return [entry.value, set];
    },
    useRef(initial) {
      const entry = slot('ref');
      if (!('ref' in entry)) entry.ref = { current: initial };
      return entry.ref;
    },
    useEffect(fn, deps) {
      const entry = slot('effect');
      const changed =
        entry.deps === undefined ||
        deps === undefined ||
        deps.length !== entry.deps.length ||
        deps.some((value, index) => !Object.is(value, entry.deps[index]));
      if (changed) {
        entry.deps = deps;
        entry.fn = fn;
        entry.instance.pending.push(entry);
      }
    },
    useMemo(compute) {
      slot('memo');
      return compute();
    },
  };

  return { React, renders, render, flush };
}

/** Every node in a `createElement` tree, depth first. */
function walk(node, visit) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node !== 'object') return;
  visit(node);
  for (const child of node.children) walk(child, visit);
}

function find(root, predicate) {
  let found = null;
  walk(root, (node) => {
    if (found === null && predicate(node)) found = node;
  });
  return found;
}

/** Load `client.js`, apply it to a recording context, and hand back the pieces. */
function loadDialog() {
  const source = fsSync.readFileSync(clientPath, 'utf8');
  const keydownListeners = new Set();
  const document = {
    head: { appendChild: (element) => element },
    createElement: (tagName) => ({
      tagName,
      textContent: '',
      attributes: {},
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      remove() {},
    }),
    addEventListener(type, handler) {
      if (type === 'keydown') keydownListeners.add(handler);
    },
    removeEventListener(type, handler) {
      if (type === 'keydown') keydownListeners.delete(handler);
    },
    activeElement: null,
    querySelectorAll: () => [],
  };

  /* `fetch` answers /defaults immediately; /clone is held open on a deferred so
     the test can control when the response arrives. */
  const calls = [];
  let cloneDeferred = null;
  const fetch = async (url) => {
    calls.push(url);
    if (url.endsWith('/clone')) {
      return cloneDeferred.promise;
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, value: { parentDirectory: '/tmp/repos' } }) };
  };

  /* Timers with a delay are inert here: the debounced /parse request only gets
     in the way of a test about /clone. Zero-delay timers still run, because the
     dialog's focus effect uses one. */
  const longTimers = [];
  const sandboxTimeout = (fn, delay) => {
    if (delay === 0) return setTimeout(fn, 0);
    longTimers.push(fn);
    return { long: true };
  };
  const sandboxClearTimeout = (timer) => {
    if (timer !== null && typeof timer === 'object') return;
    clearTimeout(timer);
  };

  const sandbox = { window: {}, document, fetch, setTimeout: sandboxTimeout, clearTimeout: sandboxClearTimeout, console };
  sandbox.window.document = document;
  sandbox.window.setTimeout = sandboxTimeout;
  sandbox.window.clearTimeout = sandboxClearTimeout;
  vm.createContext(sandbox);

  let loaded;
  sandbox.window.__ModuleLoader__ = { load: (definition) => { loaded = definition; } };
  vm.runInContext(source, sandbox, { filename: clientPath });
  assert.ok(loaded !== undefined, 'client.js must call window.__ModuleLoader__.load');

  const { React, renders, render, flush } = createReact();
  const module = loaded.factory((specifier) => {
    assert.equal(specifier, 'react');
    return React;
  });

  const sessions = [];
  const slots = [];
  const effects = [];
  const ctx = {
    get: (name) => {
      if (name === 'locale') {
        return {
          register: () => () => {},
          bind: () => (key) => key,
          getSnapshot: () => ({ revision: 0 }),
          subscribe: () => () => {},
        };
      }
      if (name === 'uiWorkspace') {
        return {
          startSession: (id) => sessions.push(id),
          openWorkspace: () => {},
          pickDirectory: async () => null,
        };
      }
      return undefined;
    },
    effect: (callback, label) => {
      const dispose = callback();
      effects.push({ label, dispose });
      return dispose;
    },
    slots: {
      inject: (name, register) => {
        slots.push({ slot: name, dispose: register() });
        return () => {};
      },
      register: (options, component) => {
        slots.push({ options, component });
        return () => {};
      },
    },
  };
  module.apply(ctx);

  const dialog = slots.find((entry) => entry.options?.name === 'shell.overlay')?.component;
  const trigger = slots.find((entry) => entry.options?.name === 'conversation.hero.options')?.component;
  assert.ok(dialog !== undefined && trigger !== undefined, 'both components must be registered');

  const openClone = () => {
    let resolve;
    const promise = new Promise((settleResolve) => { resolve = settleResolve; });
    cloneDeferred = { promise, resolve };
    /* `post()` reads `response.json()`, so the deferred must resolve to a
       Response stand-in rather than to the body itself. */
    return (payload) => resolve({ ok: true, status: 200, json: async () => payload });
  };

  return {
    React,
    document,
    keydownListeners,
    calls,
    sessions,
    renders,
    render,
    flush,
    dialog,
    trigger,
    openClone,
  };
}

/** Click the pill; returns nothing, the store drives the dialog. */
function openDialog(harness) {
  harness.render(harness.trigger);
  const button = find(harness.renders.get(harness.trigger), (node) => node.type === 'button');
  assert.ok(button !== null, 'the pill must render a button');
  button.props.onClick();
  harness.flush();
}

/** Type into the address field. */
function setAddress(harness, value) {
  const input = find(harness.renders.get(harness.dialog), (node) => node.props.id === 'dshgw-url');
  assert.ok(input !== null, 'the address field must be rendered');
  input.props.onChange({ target: { value } });
  harness.flush();
}

/** Submit the form. */
function submit(harness) {
  const form = find(harness.renders.get(harness.dialog), (node) => node.type === 'form');
  assert.ok(form !== null, 'the form must be rendered');
  form.props.onSubmit({ preventDefault() {} });
  harness.flush();
}

/** Press Escape through the document listener the component installs. */
function escape(harness) {
  assert.ok(harness.keydownListeners.size > 0, 'the dialog must listen for keydown while open');
  for (const listener of harness.keydownListeners) listener({ key: 'Escape', stopPropagation() {} });
  harness.flush();
}

/** The dialog's rendered state: open means a backdrop node, closed means null. */
function isDialogOpen(harness) {
  const tree = harness.renders.get(harness.dialog);
  return tree !== null && tree !== undefined && tree.type === 'div';
}

test('a clone response from the previous dialog session cannot close the new one', async () => {
  const harness = loadDialog();
  /* The overlay slot renders the component even while closed, so its first
     render is what subscribes to the store. */
  harness.render(harness.dialog);
  harness.flush();
  assert.equal(isDialogOpen(harness), false, 'the dialog starts closed');

  openDialog(harness);
  assert.equal(isDialogOpen(harness), true, 'clicking the pill opens the dialog');

  setAddress(harness, 'https://github.com/o/r');
  const resolveClone = harness.openClone();
  submit(harness);
  assert.ok(harness.calls.some((url) => url.endsWith('/clone')), 'submit must POST /clone');

  /* Escape while the clone is in flight: closing is allowed. */
  escape(harness);
  assert.equal(isDialogOpen(harness), false, 'Escape closes the dialog mid-clone');

  /* Re-open: a fresh dialog session, empty fields. */
  openDialog(harness);
  assert.equal(isDialogOpen(harness), true, 'the dialog reopens');

  /* Now the *first* clone resolves. Before the fix this closed the new dialog
     and navigated to the old workspace. */
  resolveClone({ ok: true, value: { workspace: { workspaceId: 'ws-old' } } });
  await settle();

  assert.equal(isDialogOpen(harness), true, 'the stale response must not close the new dialog');
  assert.deepEqual(harness.sessions, [], 'the stale response must not start a session');
  assert.equal(
    harness.calls.filter((url) => url.endsWith('/clone')).length,
    1,
    'the stale response must not submit anything on its own',
  );
  /* The close was not silent: the next open says the clone is still running. */
  const notice = find(harness.renders.get(harness.dialog), (node) => node.props?.className === 'dshgw-notice');
  assert.ok(notice !== null, 'the dialog must explain that a clone was left running');
  assert.match(notice.children.join(''), /still running when the dialog was closed/);
});

test('a clone response that arrives while the dialog is closed starts nothing', async () => {
  /* The narrower half of the same bug: if the response lands between "closed"
     and "reopened", there is no new dialog to hijack — but `startSession`
     would still yank the user into a session they had just dismissed. */
  const harness = loadDialog();
  harness.render(harness.dialog);
  harness.flush();
  openDialog(harness);
  setAddress(harness, 'https://github.com/o/r');
  const resolveClone = harness.openClone();
  submit(harness);

  escape(harness);
  assert.equal(isDialogOpen(harness), false);

  resolveClone({ ok: true, value: { workspace: { workspaceId: 'ws-dismissed' } } });
  await settle();

  assert.deepEqual(harness.sessions, [], 'a closed dialog must not start a session');
  assert.equal(isDialogOpen(harness), false, 'a closed dialog must stay closed');

  /* Re-opening later is a clean dialog that mentions the abandoned clone. */
  openDialog(harness);
  const notice = find(harness.renders.get(harness.dialog), (node) => node.props?.className === 'dshgw-notice');
  assert.ok(notice !== null, 'the dialog must explain that a clone was left running');
});

test('a clone response with no dialog change still opens the new session', async () => {
  /* The control: without a close/reopen in between, the happy path is intact,
     so the test above cannot be passing because nothing ever calls
     `startSession`. */
  const harness = loadDialog();
  harness.render(harness.dialog);
  harness.flush();
  openDialog(harness);
  setAddress(harness, 'https://github.com/o/r');
  const resolveClone = harness.openClone();
  submit(harness);

  resolveClone({ ok: true, value: { workspace: { workspaceId: 'ws-new' } } });
  await settle();

  assert.deepEqual(harness.sessions, ['ws-new']);
  assert.equal(isDialogOpen(harness), false, 'a completed clone closes the dialog');
});
