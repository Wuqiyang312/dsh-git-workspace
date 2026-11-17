/**
 * Structural check of the Client half.
 *
 * There is no browser here, so this does not render anything: it loads
 * `client.js` through the same `window.__ModuleLoader__.load` contract the
 * Harness page uses, hands `apply()` a recording stand-in for the Client
 * context, and asserts the *registrations* — slot names, ids, orders, the
 * locale namespace, the stylesheet and the disposers. Whether those
 * registrations look right on screen is a separate, unverified question.
 *
 * `react` is stubbed for this reason too: nothing renders, so nothing needs a
 * real renderer.
 */
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'client.js');

/** A recording stand-in for the Client Cordis context. */
function createClientContext() {
  const slots = [];
  const effects = [];
  const locales = [];
  const head = [];
  return {
    registrations: slots,
    effects,
    locales,
    head,
    ctx: {
      get: (name) => {
        if (name === 'locale') {
          return {
            register: (namespace, dictionaries) => {
              locales.push({ namespace, dictionaries });
              return () => {};
            },
            bind: () => (key) => key,
            getSnapshot: () => ({ revision: 0 }),
            subscribe: () => () => {},
          };
        }
        if (name === 'uiWorkspace') {
          return {
            startSession: () => {},
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
    },
  };
}

/**
 * A stand-in for the dynamic Client context the runner actually builds.
 *
 * `cordis-refs/pkg/client-runner/lib/client.js` (`dynamicCordisContext`) hands
 * `apply()` a Proxy: the declared services plus a few facade verbs are readable,
 * and any other property throws `dynamic ctx does not expose "<name>"`. A guard
 * failure also ends up in the Host log, so reading an undeclared property is a
 * real defect, not a style point. `ctx.get(name)` performs an optional lookup
 * and never throws. This reproduction is deliberately strict about the same
 * rule, so a regression such as `const styles = ctx.styles` fails here.
 *
 * @param {string[]} declared the services the plugin declares in `inject`.
 * @returns {{ ctx: object, violations: string[], harness: object }} the guarded
 *   context, the names it rejected, and the recording stand-in underneath.
 */
function createGuardedClientContext(declared) {
  const harness = createClientContext();
  const violations = [];
  const declaredNames = new Set(declared);
  /* Facade verbs of the real proxy (`CTX_VERBS`); none of them needs `inject`. */
  const verbs = new Set([
    'get', 'effect', 'on', 'once', 'provide',
    'timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce',
  ]);

  const ctx = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        if (verbs.has(prop)) {
          const method = harness.ctx[prop];
          assert.equal(typeof method, 'function', `the harness must implement ctx.${prop}`);
          return (...args) => method(...args);
        }
        if (!declaredNames.has(prop)) {
          violations.push(prop);
          throw new Error(`dynamic ctx does not expose "${prop}"`);
        }
        return harness.ctx[prop];
      },
      has: (_target, prop) => prop === 'get' || (typeof prop === 'string' && (verbs.has(prop) || declaredNames.has(prop))),
    },
  );

  return { ctx, violations, harness };
}

/** Load `client.js` in a sandbox with the globals the module contract provides. */
function loadClientModule(options = {}) {
  const source = fsSync.readFileSync(clientPath, 'utf8');
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
    addEventListener() {},
    removeEventListener() {},
    activeElement: null,
    querySelectorAll: () => [],
  };
  const sandbox = {
    window: {},
    document,
    fetch: options.fetch ?? (async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })),
    setTimeout,
    clearTimeout,
    console,
  };
  sandbox.window.document = document;
  sandbox.window.setTimeout = setTimeout;
  sandbox.window.clearTimeout = clearTimeout;
  vm.createContext(sandbox);

  let loaded;
  sandbox.window.__ModuleLoader__ = {
    load: (definition) => {
      loaded = definition;
    },
  };
  vm.runInContext(source, sandbox, { filename: clientPath });

  assert.ok(loaded !== undefined, 'client.js must call window.__ModuleLoader__.load');
  assert.equal(loaded.id, '@wuqiyang312/dsh-git-workspace');

  const factory = loaded.factory;
  const React = {
    createElement: () => null,
    Fragment: 'fragment',
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useMemo: (compute) => compute(),
  };
  const module = factory((specifier) => {
    assert.equal(specifier, 'react', 'the Client half must only require react');
    return React;
  });
  return { module, document, source };
}

/**
 * Read the `CSS` string literal out of `client.js` without evaluating it.
 *
 * The stylesheet is a `[ … ].join('')` array: one quoted fragment per line, with
 * block comments between the entries. This walks the lines in order, so nothing
 * is skipped by a pattern that happens not to match: it tracks `/* … *\/` across
 * lines, then takes the text between the first and last single quote of every
 * remaining line. A line without quotes fails the extraction instead of being
 * dropped, which is what makes the surrounding assertions trustworthy.
 *
 * @param {string} source the text of `client.js`.
 * @returns {string} the concatenated stylesheet.
 */
function extractCssLiteral(source) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes('const CSS = ['));
  assert.notEqual(start, -1, 'client.js must declare `const CSS = [`');
  const end = lines.findIndex((line, index) => index > start && line.includes("].join('')"));
  assert.notEqual(end, -1, "the CSS array must close with `].join('')`");

  const fragments = [];
  let inComment = false;
  for (let index = start + 1; index < end; index += 1) {
    let line = lines[index];
    if (inComment) {
      const close = line.indexOf('*/');
      if (close === -1) continue;
      line = line.slice(close + 2);
      inComment = false;
    }
    const open = line.indexOf('/*');
    if (open !== -1) {
      const close = line.indexOf('*/', open + 2);
      if (close === -1) {
        inComment = true;
        line = line.slice(0, open);
      } else {
        line = `${line.slice(0, open)}${line.slice(close + 2)}`;
      }
    }
    if (line.trim() === '') continue;
    const first = line.indexOf("'");
    const last = line.lastIndexOf("'");
    assert.ok(
      first !== -1 && last > first,
      `CSS line ${index + 1} must hold a quoted fragment: ${line.trim()}`,
    );
    fragments.push(line.slice(first + 1, last));
  }
  return fragments.join('');
}

test('the Client half declares the services it reads and nothing more', () => {
  const { module } = loadClientModule();
  /* Copied out of the sandbox realm, so the comparison is by value. */
  assert.deepEqual([...module.inject], ['slots', 'locale']);
  assert.equal(typeof module.apply, 'function');
});

test('apply() runs against a guarded dynamic ctx without a single rejected read', () => {
  /* Regression guard for `ctx.styles`: the real dynamic context only allows
     declared services as direct properties, and `styles` is not one (it arrives
     as the `factory` closure parameter instead — see
     `cordis-refs/pkg/client-runner/lib/client.js`, `evaluateClientHalf`). Writing
     `const direct = ctx.styles` used to pass all the other tests while failing on
     every real apply(); with this proxy it fails immediately instead. */
  const { module } = loadClientModule();
  const guarded = createGuardedClientContext([...module.inject]);

  assert.doesNotThrow(() => module.apply(guarded.ctx), 'apply() must not read an undeclared property');
  assert.deepEqual(guarded.violations, [], 'no ctx property may be read outside `inject`');

  /* The guard is not vacuous: reading an undeclared property through it throws,
     while the same name through `ctx.get()` is an allowed optional lookup. */
  assert.throws(() => guarded.ctx.styles, /dynamic ctx does not expose "styles"/);
  assert.equal(guarded.violations.pop(), 'styles');
  assert.equal(guarded.ctx.get('styles'), undefined, 'ctx.get must stay a non-throwing lookup');
  assert.equal(guarded.ctx.get('locale') !== undefined, true);

  /* The registrations still happened under the guard. */
  const names = guarded.harness.registrations
    .filter((entry) => entry.options !== undefined)
    .map((entry) => entry.options.name)
    .sort();
  assert.deepEqual(names, ['conversation.hero.options', 'shell.overlay']);
  assert.match(guarded.harness.effects.map((entry) => entry.label).join(' | '), /styles/);
});

test('apply() registers the pill and the dialog in the agreed slots', () => {
  const { module } = loadClientModule();
  const harness = createClientContext();
  module.apply(harness.ctx);

  const options = harness.registrations.filter((entry) => entry.options !== undefined);
  assert.equal(options.length, 2, 'exactly two slot registrations');

  const trigger = options.find((entry) => entry.options.name === 'conversation.hero.options');
  assert.ok(trigger !== undefined, 'the pill must register in conversation.hero.options');
  assert.equal(trigger.options.id, 'git-workspace');
  assert.equal(trigger.options.order, 100);
  assert.equal(typeof trigger.options.label, 'function');
  /* The stub `locale.bind` echoes the key, so the English fallback answers. */
  assert.equal(trigger.options.label(), 'Add Git workspace');

  const dialog = options.find((entry) => entry.options.name === 'shell.overlay');
  assert.ok(dialog !== undefined, 'the dialog must register in shell.overlay');
  assert.equal(dialog.options.id, 'git-workspace-dialog');

  /* The built-in "add workspace…" dropdown is untouched. */
  const forbidden = ['conversation.hero.workspace', 'sidebar.workspaces'];
  assert.ok(!options.some((entry) => forbidden.includes(entry.options.name)));
});

test('apply() registers en and zh dictionaries under one namespace', () => {
  const { module } = loadClientModule();
  const harness = createClientContext();
  module.apply(harness.ctx);

  assert.equal(harness.locales.length, 1);
  const [registration] = harness.locales;
  assert.equal(registration.namespace, 'gitWorkspace');
  assert.ok(Object.keys(registration.dictionaries.en).length > 20);
  /* Both languages must cover exactly the same keys, or one of them renders a raw key. */
  assert.deepEqual(
    Object.keys(registration.dictionaries.en).sort(),
    Object.keys(registration.dictionaries.zh).sort(),
  );
  assert.equal(registration.dictionaries.en['trigger.label'], 'Add Git workspace');
  assert.equal(registration.dictionaries.zh['trigger.label'], '添加 Git 工作区');
  /* Every error code the Host can emit has a localized string. */
  for (const code of [
    'git-workspace/invalid-url',
    'git-workspace/unsafe-url',
    'git-workspace/clone-timeout',
    'git-workspace/clone-failed',
    'git-workspace/target-exists',
    'git-workspace/invalid-folder-name',
    'git-workspace/no-workspace-registry',
  ]) {
    assert.equal(typeof registration.dictionaries.en[`error.${code}`], 'string', `en error.${code}`);
    assert.equal(typeof registration.dictionaries.zh[`error.${code}`], 'string', `zh error.${code}`);
  }
});

test('apply() inserts one stylesheet and every effect returns a disposer', () => {
  const { module } = loadClientModule();
  const harness = createClientContext();
  module.apply(harness.ctx);

  assert.ok(harness.effects.length >= 3, 'dictionaries, styles and dialog state each own an effect');
  for (const entry of harness.effects) {
    assert.equal(typeof entry.dispose, 'function', `${entry.label} must return a disposer`);
  }
  const labels = harness.effects.map((entry) => entry.label).join(' | ');
  assert.match(labels, /dictionaries/);
  assert.match(labels, /styles/);
});

/* ------------------------------------------------ the stylesheet stays parsed */

/**
 * Split a stylesheet into `{ selectors, body }` rules.
 *
 * Uses the same `}` split as the balance test, so a rule whose braces are
 * unbalanced shows up here as a selector or body that makes no sense — the
 * assertions below then fail on the rule that broke, not on a byte offset.
 *
 * @param {string} css the stylesheet text.
 * @returns {Array<{ selectors: string[], body: string }>} the rules in order.
 */
function rulesOf(css) {
  return css
    .split('}')
    .filter((part) => part.trim() !== '')
    .map((part) => {
      const open = part.indexOf('{');
      assert.notEqual(open, -1, `a rule has no "{": ${part.slice(0, 60)}`);
      return {
        selectors: part.slice(0, open).split(',').map((selector) => selector.trim()),
        body: part.slice(open + 1).trim(),
      };
    });
}

test('the stylesheet defines every rule the markup depends on', () => {
  /* Why these six: the Client half renders no inline styles at all, so each of
     these classes is the *only* thing that makes its element usable —
       .dshgw-trigger  the pill in the New Session row (it is a bare <button>;
                       without this rule it is an unstyled native button),
       .dshgw-backdrop the full-frame modal layer that dims the page,
       .dshgw-card     the dialog panel itself (size, padding, background),
       .dshgw-error    the error box, which is how a failed clone is shown,
       .dshgw-button   the Cancel/Submit buttons,
       .dshgw-primary  the submit button's brand treatment.
     The brace-balance test above cannot see a whole rule that was deleted with
     its braces intact, so this one names the rules that must exist. Matching is
     per selector inside the rule, never character-for-character: declarations
     may be edited freely, renaming or dropping a rule is what fails. */
  const css = extractCssLiteral(fsSync.readFileSync(clientPath, 'utf8'));
  const rules = rulesOf(css);

  for (const className of [
    'dshgw-trigger',
    'dshgw-backdrop',
    'dshgw-card',
    'dshgw-error',
    'dshgw-button',
    'dshgw-primary',
  ]) {
    const rule = rules.find((entry) => entry.selectors.includes(`.${className}`));
    assert.ok(rule !== undefined, `the stylesheet must define a \`.${className}\` rule`);
    assert.notEqual(rule.body, '', `\`.${className}\` must declare something`);
    /* A body without a single declaration (`color:` …) would still "exist" as a
       selector but do nothing; `{color:red}` always contains a colon. */
    assert.ok(rule.body.includes(':'), `\`.${className}\` must contain at least one declaration`);
  }
});

test('the backdrop dims the page with a mask token, not a solid panel colour', () => {
  /* Regression: the scrim originally used `--dsw-alias-bg-overlay`, which is the
     *panel* colour — `rgb(233,236,242)` in the light palette and `rgb(97,102,107)`
     in the dark one, both fully opaque. Painting it over `inset:0` covered the
     whole app in flat grey instead of dimming it, and the dialog looked like it
     had no mask at all. The Modal primitive (ui-settings-general, ui-layout's
     drawer mask) uses `--dsw-alias-bg-mask-1` + `--dsw-mask-blur`, which are the
     translucent tokens, so the backdrop must name those and never the panel one. */
  const css = extractCssLiteral(fsSync.readFileSync(clientPath, 'utf8'));
  const backdrop = rulesOf(css).find((rule) => rule.selectors.includes('.dshgw-backdrop'));
  assert.ok(backdrop !== undefined, 'the stylesheet must define `.dshgw-backdrop`');

  assert.ok(
    backdrop.body.includes('var(--dsw-alias-bg-mask-1'),
    '`.dshgw-backdrop` must use the translucent `--dsw-alias-bg-mask-1` token',
  );
  assert.ok(
    !backdrop.body.includes('--dsw-alias-bg-overlay'),
    '`.dshgw-backdrop` must not use `--dsw-alias-bg-overlay`: that token is an opaque panel colour',
  );
  /* A mask token alone is enough to dim; the blur keeps it consistent with the
     shipped Modals, which all pair the two. */
  assert.ok(
    backdrop.body.includes('backdrop-filter:var(--dsw-mask-blur'),
    '`.dshgw-backdrop` must pair the mask with `--dsw-mask-blur` like the shipped Modals',
  );
});

test('every CSS rule is closed: the stylesheet has balanced braces', () => {
  const source = fsSync.readFileSync(clientPath, 'utf8');
  const css = extractCssLiteral(source);
  assert.ok(css.length > 1000, 'the stylesheet literal must have been found');

  const open = (css.match(/\{/g) ?? []).length;
  const close = (css.match(/\}/g) ?? []).length;
  /* One missing `}` makes every following rule part of a broken declaration
     block, and a browser drops the lot silently — there is no error to see. */
  assert.equal(close, open, `the stylesheet has ${open} "{" but ${close} "}"`);
  assert.ok(open > 20, `expected many rules, found ${open}`);

  /* Per rule: split on `}`, and each non-empty part must hold exactly one `{`
     and no `}`. That catches a stray opener anywhere inside a rule, not just a
     miscount at the end of the file. */
  const parts = css.split('}');
  const trailing = parts.pop();
  assert.equal(trailing.trim(), '', 'the stylesheet must not end inside a rule');
  parts.forEach((rule, index) => {
    const body = rule.trim();
    assert.notEqual(body, '', `rule ${index + 1} is empty`);
    assert.equal((body.match(/\{/g) ?? []).length, 1, `rule ${index + 1} must open exactly once: ${body.slice(0, 60)}`);
    assert.equal(body.includes('}'), false, `rule ${index + 1} must be closed by its own "}"`);
  });
});

test('the stylesheet literal is read line by line, so a dropped fragment is caught', () => {
  /* The extractor itself is asserted, not assumed: dropping one line's text
     must change the result. Otherwise a regexp that quietly skips lines would
     make the balance test above pass on an incomplete stylesheet. */
  const source = fsSync.readFileSync(clientPath, 'utf8');
  const css = extractCssLiteral(source);
  assert.ok(css.includes('.dshgw-trigger{'), 'the first rule must be present');
  assert.ok(css.includes('.dshgw-notice{'), 'the last rule must be present');

  const damaged = source.replace(`      '.dshgw-notice{margin:10px 0 0;font-size:11.5px;line-height:17px;',\n`, '');
  if (damaged !== source) {
    assert.notEqual(extractCssLiteral(damaged), css, 'removing a line must change the extracted stylesheet');
  }
});
