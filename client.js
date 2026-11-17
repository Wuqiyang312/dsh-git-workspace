/**
 * Client half of `@wuqiyang312/dsh-git-workspace`.
 *
 * Two registrations, both released through `ctx.slots.inject`:
 *
 *   - `conversation.hero.options` — the compact "Add Git workspace" pill on the
 *     New Session row, right of the workspace and preset controls.
 *   - `shell.overlay` — the modal dialog, rendered frame-wide on demand.
 *
 * The two halves share one tiny store instead of React context, because the
 * shell renders each slot occupant in its own position in the tree.
 *
 * No Harness Client package is imported: the controls are plain elements and
 * the stylesheet only uses `--dsw-alias-*` theme tokens.
 */
window.__ModuleLoader__.load({
  id: '@wuqiyang312/dsh-git-workspace',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Route prefix, matching `ROUTE_PREFIX` on the Host half. */
    const API = '/api/git-workspace';

    /** Locale namespace; one owner per namespace, so it is plugin-specific. */
    const NAMESPACE = 'gitWorkspace';

    const EN = {
      'trigger.label': 'Add Git workspace',
      'trigger.title': 'Clone a Git repository and open it as a workspace',
      'dialog.title': 'Add a Git workspace',
      'dialog.subtitle': 'The repository is cloned locally and registered as a workspace.',
      'field.url': 'Git address',
      'field.url.hint': 'HTTPS or SSH, optionally a /tree/<branch> link, or owner/repo.',
      'field.parent': 'Parent directory',
      'field.parent.browse': 'Browse…',
      'field.parent.browseFailed': 'The directory picker is unavailable in this profile.',
      'field.folder': 'Folder name',
      'field.folder.hint': 'One directory name inside the parent directory.',
      'field.branch': 'Branch',
      'field.branch.hint': 'Empty clones the remote default branch.',
      'field.shallow': 'Shallow clone (depth 1)',
      'field.shallow.hint': 'Faster, without history. Switch it off if the repository needs full history.',
      'action.cancel': 'Cancel',
      'action.submit': 'Clone and open',
      'action.cloning': 'Cloning…',
      'action.close': 'Close',
      'state.loading': 'Reading defaults…',
      'state.resolving': 'Reading the address…',
      'error.generic': 'The workspace could not be created.',
      'error.defaults': 'The default directory could not be read.',
      'error.urlRequired': 'Enter a Git address.',
      'notice.closedWhileCloning':
        'The previous clone was still running when the dialog was closed. It continues on the Host; this dialog will not switch to it.',
      'error.git-workspace/invalid-url': 'That is not a usable Git address.',
      'error.git-workspace/unsafe-url': 'That address is not accepted for safety reasons.',
      'error.git-workspace/url-too-long': 'That address is too long.',
      'error.git-workspace/invalid-branch': 'That branch name is not usable.',
      'error.git-workspace/invalid-folder-name': 'That folder name is not usable.',
      'error.git-workspace/invalid-parent-directory': 'That parent directory is not usable.',
      'error.git-workspace/target-exists': 'That folder already exists. Choose another name.',
      'error.git-workspace/clone-busy': 'A clone into that folder is already running.',
      'error.git-workspace/clone-timeout': 'The clone took too long and a stop was requested.',
      'error.git-workspace/clone-failed': 'git could not clone that repository.',
      'error.git-workspace/spawn-failed': 'git could not be started on this machine.',
      'error.git-workspace/move-failed': 'The clone finished but could not be moved into place.',
      'error.git-workspace/register-failed': 'The repository was cloned but could not be registered as a workspace.',
      'error.git-workspace/no-workspace-registry': 'This profile has no workspace registry to register the clone with.',
      'error.git-workspace/no-clone-root': 'No clone directory is available.',
      'error.git-workspace/clone-root-failed': 'The clone directory could not be created.',
      'error.git-workspace/missing-url': 'Enter a Git address.',
      'error.git-workspace/invalid-json': 'The request was malformed.',
      'error.git-workspace/body-too-large': 'The request was too large.',
      'error.git-workspace/network': 'The Harness Host could not be reached.',
    };

    const ZH = {
      'trigger.label': '添加 Git 工作区',
      'trigger.title': '克隆一个 Git 仓库并作为工作区打开',
      'dialog.title': '添加 Git 工作区',
      'dialog.subtitle': '仓库会被克隆到本地，并登记为一个工作区。',
      'field.url': 'Git 地址',
      'field.url.hint': 'HTTPS 或 SSH，也可以是带 /tree/<分支> 的链接，或 owner/repo 简写。',
      'field.parent': '存放父目录',
      'field.parent.browse': '浏览…',
      'field.parent.browseFailed': '当前配置没有可用的目录选择器。',
      'field.folder': '文件夹名',
      'field.folder.hint': '父目录下的一个目录名。',
      'field.branch': '分支',
      'field.branch.hint': '留空则克隆远端默认分支。',
      'field.shallow': '浅克隆（深度 1）',
      'field.shallow.hint': '更快，但没有历史。需要完整历史时请关闭。',
      'action.cancel': '取消',
      'action.submit': '克隆并打开',
      'action.cloning': '正在克隆…',
      'action.close': '关闭',
      'state.loading': '正在读取默认值…',
      'state.resolving': '正在解析地址…',
      'error.generic': '创建工作区失败。',
      'error.defaults': '读取默认目录失败。',
      'error.urlRequired': '请输入 Git 地址。',
      'notice.closedWhileCloning': '上一次克隆在关闭对话框时仍在进行，它会继续在 Host 端运行；本对话框不会跳转到那个结果。',
      'error.git-workspace/invalid-url': '这不是一个可用的 Git 地址。',
      'error.git-workspace/unsafe-url': '出于安全考虑，不接受这个地址。',
      'error.git-workspace/url-too-long': '地址过长。',
      'error.git-workspace/invalid-branch': '分支名不可用。',
      'error.git-workspace/invalid-folder-name': '文件夹名不可用。',
      'error.git-workspace/invalid-parent-directory': '父目录不可用。',
      'error.git-workspace/target-exists': '该文件夹已存在，请换一个名字。',
      'error.git-workspace/clone-busy': '该文件夹已有一个克隆正在进行。',
      'error.git-workspace/clone-timeout': '克隆超时，已请求停止（是否已退出见下方详情）。',
      'error.git-workspace/clone-failed': 'git 无法克隆该仓库。',
      'error.git-workspace/spawn-failed': '无法在本机启动 git。',
      'error.git-workspace/move-failed': '克隆完成，但无法移动到目标位置。',
      'error.git-workspace/register-failed': '仓库已克隆，但未能登记为工作区。',
      'error.git-workspace/no-workspace-registry': '当前配置没有工作区注册表，无法登记克隆结果。',
      'error.git-workspace/no-clone-root': '没有可用的克隆目录。',
      'error.git-workspace/clone-root-failed': '无法创建克隆目录。',
      'error.git-workspace/missing-url': '请输入 Git 地址。',
      'error.git-workspace/invalid-json': '请求格式不正确。',
      'error.git-workspace/body-too-large': '请求内容过大。',
      'error.git-workspace/network': '无法连接 Harness Host。',
    };

    const CSS = [
      /* The pill sits in the New Session options row, so it borrows that row's
         rhythm: 26px tall, 999px radius, 12px text. */
      '.dshgw-trigger{appearance:none;display:inline-flex;align-items:center;gap:6px;',
      'box-sizing:border-box;height:26px;padding:0 10px;border-radius:999px;',
      'font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer;',
      'color:var(--dsw-alias-label-secondary);background:transparent;',
      'border:1px solid var(--dsw-alias-border-l1);',
      'transition:background 140ms ease,color 140ms ease,border-color 140ms ease;}',
      '.dshgw-trigger:hover{color:var(--dsw-alias-label-primary);',
      'background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);}',
      '.dshgw-trigger:active{background:var(--dsw-alias-bg-layer-1);}',
      '.dshgw-trigger:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '.dshgw-trigger svg{flex:none;width:13px;height:13px;}',
      /* Overlay: the frame-wide layer is already positioned, so this only fills it.
         The scrim uses the Modal primitive's tokens (`--dsw-alias-bg-mask-1` plus
         `--dsw-mask-blur`), *not* `--dsw-alias-bg-overlay`: that token is a solid
         panel colour (dark theme resolves it to an opaque rgb(97,102,107)), so it
         turns the whole frame grey instead of dimming it. */
      '.dshgw-backdrop{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;',
      'box-sizing:border-box;padding:24px;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.4));',
      'backdrop-filter:var(--dsw-mask-blur,none);z-index:60;}',
      '.dshgw-card{box-sizing:border-box;display:flex;flex-direction:column;',
      'width:min(520px,100%);max-height:min(86vh,640px);overflow:auto;',
      'padding:18px 20px 16px;border-radius:12px;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);',
      'border:1px solid var(--dsw-alias-border-l1);',
      'box-shadow:0 18px 48px -20px rgba(0,0,0,.45);}',
      '.dshgw-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;',
      'margin:0 0 14px;}',
      '.dshgw-title{margin:0;font-size:14px;line-height:20px;font-weight:600;}',
      '.dshgw-subtitle{margin:3px 0 0;font-size:11.5px;line-height:16px;',
      'color:var(--dsw-alias-label-secondary);}',
      '.dshgw-close{flex:none;appearance:none;width:22px;height:22px;padding:0;border:0;',
      'border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);',
      'font-size:15px;line-height:1;cursor:pointer;}',
      '.dshgw-close:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);}',
      '.dshgw-close:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.dshgw-field{display:flex;flex-direction:column;gap:5px;margin:0 0 12px;}',
      '.dshgw-label{font-size:11.5px;line-height:16px;font-weight:600;',
      'color:var(--dsw-alias-label-secondary);}',
      '.dshgw-hint{margin:0;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);}',
      '.dshgw-row{display:flex;align-items:center;gap:6px;}',
      '.dshgw-input{box-sizing:border-box;flex:1 1 auto;min-width:0;height:30px;padding:0 9px;',
      'font:inherit;font-size:12.5px;line-height:18px;border-radius:7px;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);',
      'border:1px solid var(--dsw-alias-border-l1);}',
      '.dshgw-input::placeholder{color:var(--dsw-alias-label-secondary);}',
      '.dshgw-input:focus{outline:none;border-color:var(--dsw-alias-border-l2);',
      'box-shadow:0 0 0 1px var(--dsw-alias-border-l2);}',
      '.dshgw-browse{flex:none;appearance:none;height:30px;padding:0 10px;border-radius:7px;',
      'font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;',
      'color:var(--dsw-alias-label-secondary);background:transparent;',
      'border:1px solid var(--dsw-alias-border-l1);}',
      '.dshgw-browse:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);}',
      '.dshgw-browse:disabled{opacity:.5;cursor:default;}',
      '.dshgw-browse:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '.dshgw-check{display:flex;align-items:center;gap:7px;margin:0 0 4px;',
      'font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-primary);cursor:pointer;}',
      '.dshgw-check input{width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-brand-primary);}',
      '.dshgw-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;',
      'margin:16px 0 0;padding:12px 0 0;border-top:1px solid var(--dsw-alias-border-l1);}',
      '.dshgw-button{appearance:none;height:30px;padding:0 14px;border-radius:7px;',
      'font:inherit;font-size:12.5px;line-height:1;cursor:pointer;',
      'color:var(--dsw-alias-label-primary);background:transparent;',
      'border:1px solid var(--dsw-alias-border-l1);}',
      '.dshgw-button:hover:enabled{background:var(--dsw-alias-bg-layer-2);}',
      '.dshgw-button:disabled{opacity:.55;cursor:default;}',
      '.dshgw-button:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      /* Primary action: the brand colour is used as the *border and text*, not as
         a solid fill. A solid fill would need a known on-brand text colour, and
         the only theme tokens available for text are the label tokens, which can
         contrast badly against a custom brand colour. Using tokens only keeps
         this correct in light, dark and custom themes. */
      '.dshgw-primary{color:var(--dsw-alias-brand-primary);',
      'background:var(--dsw-alias-bg-layer-2);',
      'border-color:var(--dsw-alias-brand-primary);font-weight:600;}',
      '.dshgw-primary:hover:enabled{background:var(--dsw-alias-bg-layer-1);}',
      '.dshgw-error{margin:10px 0 0;padding:8px 10px;border-radius:7px;',
      'font-size:11.5px;line-height:17px;overflow-wrap:anywhere;',
      'color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary));',
      'background:var(--dsw-alias-bg-layer-2);',
      'border:1px solid var(--dsw-alias-state-error-primary);}',
      '.dshgw-error-summary{margin:0;font-weight:600;}',
      /* git's own diagnostics: monospace, scrollable, never wider than the card. */
      '.dshgw-error-detail{margin:6px 0 0;padding:0;max-height:110px;overflow:auto;',
      'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
      'font-size:10.5px;line-height:15px;white-space:pre-wrap;',
      'color:var(--dsw-alias-label-secondary);}',
      '.dshgw-notice{margin:10px 0 0;font-size:11.5px;line-height:17px;',
      'color:var(--dsw-alias-label-secondary);}',
    ].join('');

    /**
     * Dictionary lookup with an English fallback, so a missing registration or a
     * reloaded instance still renders words instead of key names.
     */
    function text(locale, key) {
      if (locale === undefined) return EN[key] ?? key;
      try {
        const value = locale.bind(NAMESPACE)(key);
        return value === undefined || value === '' || value === key ? EN[key] ?? key : value;
      } catch {
        return EN[key] ?? key;
      }
    }

    /** Re-read the locale on every language switch, without remounting. */
    function useLocaleTick(locale) {
      const [revision, setRevision] = React.useState(0);
      React.useEffect(() => {
        if (locale === undefined) return undefined;
        try {
          setRevision(locale.getSnapshot().revision);
          return locale.subscribe(() => setRevision(locale.getSnapshot().revision));
        } catch {
          return undefined;
        }
      }, [locale]);
      return revision;
    }

    /**
     * Whether a response still belongs to the dialog that asked for it.
     *
     * The dialog never unmounts while it is closed — it renders `null` — so
     * `disposed` cannot notice "closed, then opened again". Only a token that
     * is bumped on every open (and on every submit) can: a request sent by a
     * previous dialog session must not close the current one, start a session
     * or flip its `busy` flag.
     *
     * @param {number} seq the token captured when the request was sent.
     * @param {number} current the dialog's current token.
     * @param {boolean} disposed whether the component was unmounted.
     * @returns {boolean} true when the response may still be applied.
     */
    function isCurrent(seq, current, disposed) {
      return disposed !== true && seq === current;
    }

    /** One small subscribe/set pair shared by the trigger and the overlay. */
    function createStore() {
      const listeners = new Set();
      let state = { open: false };
      const get = () => state;
      const subscribe = (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
      const set = (next) => {
        state = typeof next === 'function' ? next(state) : next;
        for (const listener of listeners) {
          try {
            listener();
          } catch {
            /* one broken consumer must not stop the others */
          }
        }
      };
      return { get, subscribe, set, open: () => set({ open: true }), close: () => set({ open: false }) };
    }

    function useStore(store) {
      const [snapshot, setSnapshot] = React.useState(store.get());
      React.useEffect(() => {
        setSnapshot(store.get());
        return store.subscribe(() => setSnapshot(store.get()));
      }, [store]);
      return snapshot;
    }

    /** POST helper that always resolves to the route's `{ ok, value|error }` shape. */
    async function post(path, payload) {
      let response;
      try {
        response = await fetch(`${API}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
        });
      } catch {
        return { ok: false, error: { code: 'git-workspace/network', message: 'The Harness Host could not be reached.' } };
      }
      let body;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      if (body === null || typeof body !== 'object') {
        return { ok: false, error: { code: 'git-workspace/http', message: `HTTP ${response.status}` } };
      }
      return body;
    }

    async function readDefaults() {
      let response;
      try {
        response = await fetch(`${API}/defaults`, { method: 'GET' });
      } catch {
        return { ok: false, error: { code: 'git-workspace/network', message: 'The Harness Host could not be reached.' } };
      }
      try {
        return await response.json();
      } catch {
        return { ok: false, error: { code: 'git-workspace/http', message: `HTTP ${response.status}` } };
      }
    }

    /** Icon for the pill: a repository branch joined to a small plus. */
    function TriggerIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: 'false' },
        h('path', {
          d: 'M7 4v11',
          stroke: 'currentColor',
          'stroke-width': '1.8',
          'stroke-linecap': 'round',
        }),
        h('circle', { cx: '7', cy: '3.6', r: '1.8', fill: 'currentColor' }),
        h('circle', { cx: '7', cy: '16.6', r: '1.8', fill: 'currentColor' }),
        h('path', {
          d: 'M7 11.5h5.2A3.3 3.3 0 0 0 15.5 8.2V7',
          stroke: 'currentColor',
          'stroke-width': '1.8',
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        }),
        h('path', {
          d: 'M17.6 4.4v5.2M15 7h5.2',
          stroke: 'currentColor',
          'stroke-width': '1.8',
          'stroke-linecap': 'round',
        }),
      );
    }

    /**
     * Build the two components. `services` carries the locale lookup and the
     * optional Client services, resolved once per `apply()`.
     */
    function createComponents(services) {
      const { locale, store, uiWorkspace } = services;

      function GitWorkspaceTrigger() {
        useLocaleTick(locale);
        const t = (key) => text(locale, key);
        return h(
          'button',
          {
            type: 'button',
            className: 'dshgw-trigger',
            title: t('trigger.title'),
            'aria-label': t('trigger.label'),
            onClick: () => store.open(),
          },
          h(TriggerIcon),
          h('span', null, t('trigger.label')),
        );
      }

      function GitWorkspaceDialog() {
        useLocaleTick(locale);
        const t = (key) => text(locale, key);
        const snapshot = useStore(store);
        const open = snapshot.open === true;

        const [url, setUrl] = React.useState('');
        const [parentDirectory, setParentDirectory] = React.useState('');
        const [folderName, setFolderName] = React.useState('');
        const [branch, setBranch] = React.useState('');
        const [shallow, setShallow] = React.useState(false);
        const [loadingDefaults, setLoadingDefaults] = React.useState(false);
        const [resolving, setResolving] = React.useState(false);
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState(null);
        const [notice, setNotice] = React.useState(null);

        /* Fields the user edited by hand; autofill must never overwrite them. */
        const touched = React.useRef({ folderName: false, branch: false });
        const cardRef = React.useRef(null);
        const urlRef = React.useRef(null);
        const previousFocus = React.useRef(null);
        const disposed = React.useRef(false);

        /* Which dialog session a clone response belongs to.
           `disposed` alone is not enough: closing only makes this component
           render `null` — it is never unmounted — so a clone that was still in
           flight when the user pressed Escape would, on resolving, close the
           *next* dialog and navigate away from a session the user just opened.
           Both `open` and `submit` bump the token; every response compares the
           token it captured with the current one (see `isCurrent`). */
        const submitSeq = React.useRef(0);
        /* Set when the dialog is closed while a clone is in flight, so the next
           open can say so instead of pretending nothing happened. A ref, not
           state: the Escape handler is installed once per open and would see a
           stale `busy` from the render that opened the dialog. */
        const closedWhileBusy = React.useRef(false);
        const busyRef = React.useRef(false);
        busyRef.current = busy;

        React.useEffect(() => {
          disposed.current = false;
          return () => {
            disposed.current = true;
          };
        }, []);

        /**
         * Close the dialog. Closing is always allowed — there is no cancel
         * button and the Host's `git` process cannot be stopped from here — but
         * a close during a clone is remembered: the in-flight response is
         * discarded by the token, and the next open shows a hint rather than
         * silently dropping the request.
         */
        const dismiss = () => {
          closedWhileBusy.current = busyRef.current;
          /* Invalidate the in-flight response immediately, not only on the next
             open: a clone that resolves while the dialog is closed must not call
             `startSession` and pull the user into a session they just dismissed. */
          submitSeq.current += 1;
          store.close();
        };

        /* Reset and load defaults each time the dialog opens. */
        React.useEffect(() => {
          if (!open) return undefined;
          let cancelled = false;
          /* Invalidate every response from an earlier dialog session first. */
          submitSeq.current += 1;
          setUrl('');
          setFolderName('');
          setBranch('');
          setError(null);
          setNotice(closedWhileBusy.current ? t('notice.closedWhileCloning') : null);
          closedWhileBusy.current = false;
          setBusy(false);
          touched.current = { folderName: false, branch: false };
          setLoadingDefaults(true);
          void readDefaults().then((result) => {
            if (cancelled || disposed.current) return;
            setLoadingDefaults(false);
            if (result?.ok === true) {
              const value = result.value ?? {};
              setParentDirectory(typeof value.parentDirectory === 'string' ? value.parentDirectory : '');
              setShallow(value.shallow === true);
              return;
            }
            setError({ code: result?.error?.code, message: result?.error?.message ?? t('error.defaults') });
          });
          return () => {
            cancelled = true;
          };
        }, [open]);

        /* Focus the first field, trap Tab, close on Escape, restore focus. */
        React.useEffect(() => {
          if (!open) return undefined;
          previousFocus.current = document.activeElement;
          const focusTimer = window.setTimeout(() => {
            urlRef.current?.focus?.();
          }, 0);

          const onKeyDown = (event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              /* Escape is allowed mid-clone: the token makes the pending
                 response a no-op, and the next open explains what happened. */
              dismiss();
              return;
            }
            if (event.key !== 'Tab') return;
            const card = cardRef.current;
            if (card === null || card === undefined) return;
            const focusable = card.querySelectorAll(
              'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]',
            );
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          };

          document.addEventListener('keydown', onKeyDown, true);
          return () => {
            window.clearTimeout(focusTimer);
            document.removeEventListener('keydown', onKeyDown, true);
            const target = previousFocus.current;
            previousFocus.current = null;
            if (target !== null && typeof target?.focus === 'function') {
              try {
                target.focus();
              } catch {
                /* the element may have been removed while the dialog was open */
              }
            }
          };
        }, [open]);

        /* Debounced address parsing: pre-fills the folder name and branch. */
        React.useEffect(() => {
          if (!open) return undefined;
          const value = url.trim();
          if (value === '') {
            setResolving(false);
            return undefined;
          }
          let cancelled = false;
          setResolving(true);
          const timer = window.setTimeout(() => {
            void post('/parse', { url: value }).then((result) => {
              if (cancelled || disposed.current) return;
              setResolving(false);
              if (result?.ok !== true) return;
              const parsed = result.value ?? {};
              if (touched.current.folderName !== true && typeof parsed.folderName === 'string') {
                setFolderName(parsed.folderName);
              }
              if (touched.current.branch !== true && typeof parsed.branch === 'string') {
                setBranch(parsed.branch);
              }
            });
          }, 350);
          return () => {
            cancelled = true;
            window.clearTimeout(timer);
          };
        }, [open, url]);

        if (!open) return null;

        const browse = () => {
          if (uiWorkspace === undefined || typeof uiWorkspace.pickDirectory !== 'function') {
            setNotice(t('field.parent.browseFailed'));
            return;
          }
          Promise.resolve()
            .then(() => uiWorkspace.pickDirectory())
            .then((picked) => {
              if (disposed.current) return;
              if (typeof picked === 'string' && picked !== '') setParentDirectory(picked);
            })
            .catch(() => {
              if (!disposed.current) setNotice(t('field.parent.browseFailed'));
            });
        };

        const submit = (event) => {
          event.preventDefault();
          if (busy) return;
          const address = url.trim();
          if (address === '') {
            setError({ code: 'git-workspace/missing-url', message: t('error.urlRequired') });
            return;
          }
          setBusy(true);
          setError(null);
          /* The token this request belongs to. Any later open (or submit)
             bumps it, and then this response must not touch the dialog at all —
             not `setBusy`, not `store.close()`, not `startSession`. */
          const seq = ++submitSeq.current;
          void post('/clone', {
            url: address,
            branch: branch.trim() === '' ? undefined : branch.trim(),
            parentDirectory: parentDirectory.trim() === '' ? undefined : parentDirectory.trim(),
            folderName: folderName.trim() === '' ? undefined : folderName.trim(),
            /* The switch is sent as a boolean, so "off" really means a full clone
               even when the profile's own default is shallow. */
            shallow,
          }).then((result) => {
            if (!isCurrent(seq, submitSeq.current, disposed.current)) return;
            if (result?.ok !== true) {
              setBusy(false);
              setError({ code: result?.error?.code, message: result?.error?.message });
              return;
            }
            setBusy(false);
            const workspaceId = result.value?.workspace?.workspaceId;
            store.close();
            if (typeof workspaceId === 'string' && workspaceId !== '' && uiWorkspace?.startSession !== undefined) {
              try {
                uiWorkspace.startSession(workspaceId);
              } catch {
                /* the workspace is registered either way; the user can pick it from the list */
              }
            }
          });
        };

        /**
         * Codes whose server message carries diagnostics worth showing verbatim
         * (git's own stderr tail, or the filesystem error). Everything else gets
         * only its localized sentence: the English detail would just repeat it.
         */
        const DETAIL_CODES = new Set([
          'git-workspace/clone-failed',
          'git-workspace/clone-timeout',
          'git-workspace/spawn-failed',
          'git-workspace/move-failed',
          'git-workspace/register-failed',
          'git-workspace/clone-root-failed',
          'git-workspace/target-check-failed',
          'git-workspace/invalid-parent-directory',
          'git-workspace/target-exists',
          'git-workspace/no-workspace-registry',
        ]);

        const errorView = (() => {
          if (error === null || error === undefined) return null;
          const message = typeof error.message === 'string' ? error.message : '';
          if (typeof error.code === 'string') {
            const key = `error.${error.code}`;
            const localized = text(locale, key);
            if (localized !== key) {
              return {
                summary: localized,
                detail: DETAIL_CODES.has(error.code) && message !== '' ? message : null,
              };
            }
          }
          return { summary: message !== '' ? message : t('error.generic'), detail: null };
        })();

        const dialogId = 'dshgw-dialog-title';

        return h(
          'div',
          {
            className: 'dshgw-backdrop',
            onMouseDown: (event) => {
              if (event.target === event.currentTarget) dismiss();
            },
          },
          h(
            'div',
            {
              className: 'dshgw-card',
              ref: cardRef,
              role: 'dialog',
              'aria-modal': 'true',
              'aria-labelledby': dialogId,
            },
            h(
              'div',
              { className: 'dshgw-head' },
              h(
                'div',
                null,
                h('h2', { className: 'dshgw-title', id: dialogId }, t('dialog.title')),
                h('p', { className: 'dshgw-subtitle' }, t('dialog.subtitle')),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshgw-close',
                  'aria-label': t('action.close'),
                  title: t('action.close'),
                  /* Same path as Escape and the backdrop: allowed mid-clone, but
                     it remembers that the pending response must be dropped. */
                  onClick: () => dismiss(),
                },
                '\u00d7',
              ),
            ),
            h(
              'form',
              { onSubmit: submit },
              h(
                'div',
                { className: 'dshgw-field' },
                h('label', { className: 'dshgw-label', htmlFor: 'dshgw-url' }, t('field.url')),
                h('input', {
                  id: 'dshgw-url',
                  ref: urlRef,
                  className: 'dshgw-input',
                  type: 'text',
                  value: url,
                  spellCheck: false,
                  autoComplete: 'off',
                  placeholder: 'https://github.com/owner/repo',
                  onChange: (event) => setUrl(event.target.value),
                }),
                h('p', { className: 'dshgw-hint' }, t('field.url.hint')),
              ),
              h(
                'div',
                { className: 'dshgw-field' },
                h('label', { className: 'dshgw-label', htmlFor: 'dshgw-parent' }, t('field.parent')),
                h(
                  'div',
                  { className: 'dshgw-row' },
                  h('input', {
                    id: 'dshgw-parent',
                    className: 'dshgw-input',
                    type: 'text',
                    value: parentDirectory,
                    spellCheck: false,
                    autoComplete: 'off',
                    disabled: loadingDefaults,
                    onChange: (event) => setParentDirectory(event.target.value),
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshgw-browse',
                      onClick: browse,
                      disabled: uiWorkspace === undefined,
                    },
                    t('field.parent.browse'),
                  ),
                ),
                loadingDefaults ? h('p', { className: 'dshgw-hint' }, t('state.loading')) : undefined,
              ),
              h(
                'div',
                { className: 'dshgw-field' },
                h('label', { className: 'dshgw-label', htmlFor: 'dshgw-folder' }, t('field.folder')),
                h('input', {
                  id: 'dshgw-folder',
                  className: 'dshgw-input',
                  type: 'text',
                  value: folderName,
                  spellCheck: false,
                  autoComplete: 'off',
                  onChange: (event) => {
                    touched.current.folderName = true;
                    setFolderName(event.target.value);
                  },
                }),
                h('p', { className: 'dshgw-hint' }, t('field.folder.hint')),
              ),
              h(
                'div',
                { className: 'dshgw-field' },
                h('label', { className: 'dshgw-label', htmlFor: 'dshgw-branch' }, t('field.branch')),
                h('input', {
                  id: 'dshgw-branch',
                  className: 'dshgw-input',
                  type: 'text',
                  value: branch,
                  spellCheck: false,
                  autoComplete: 'off',
                  onChange: (event) => {
                    touched.current.branch = true;
                    setBranch(event.target.value);
                  },
                }),
                h('p', { className: 'dshgw-hint' }, t('field.branch.hint')),
              ),
              h(
                'label',
                { className: 'dshgw-check' },
                h('input', {
                  type: 'checkbox',
                  checked: shallow,
                  onChange: (event) => setShallow(event.target.checked),
                }),
                h('span', null, t('field.shallow')),
              ),
              h('p', { className: 'dshgw-hint' }, t('field.shallow.hint')),
              resolving ? h('p', { className: 'dshgw-notice' }, t('state.resolving')) : undefined,
              notice === null ? undefined : h('p', { className: 'dshgw-notice' }, notice),
              errorView === null
                ? undefined
                : h(
                    'div',
                    { className: 'dshgw-error', role: 'alert' },
                    h('p', { className: 'dshgw-error-summary' }, errorView.summary),
                    errorView.detail === null
                      ? undefined
                      : h('pre', { className: 'dshgw-error-detail' }, errorView.detail),
                  ),
              h(
                'div',
                { className: 'dshgw-foot' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshgw-button',
                    /* Disabled mid-clone, so this never discards a running
                       request; Escape and the backdrop are the escape hatches. */
                    onClick: () => dismiss(),
                    disabled: busy,
                  },
                  t('action.cancel'),
                ),
                h(
                  'button',
                  { type: 'submit', className: 'dshgw-button dshgw-primary', disabled: busy || loadingDefaults },
                  busy ? t('action.cloning') : t('action.submit'),
                ),
              ),
            ),
          ),
        );
      }

      return { GitWorkspaceTrigger, GitWorkspaceDialog };
    }

    /** Insert one stylesheet and return the disposer that removes it again. */
    function insertStyles(css, styles) {
      /* If a stylesheet registrar is ever handed in, use it so this plugin's CSS
         shares its lifecycle. When it answers without a disposer the insertion
         still happened, so a no-op disposer is returned rather than inserting a
         duplicate <style> as well. In the current host nothing is handed in (see
         `apply()`), so the plain <style> element below is what actually runs; it
         is also the fallback when the registrar throws. */
      if (styles !== undefined && typeof styles.insert === 'function') {
        try {
          const dispose = styles.insert(css);
          return typeof dispose === 'function' ? dispose : () => {};
        } catch {
          /* fall through to the element */
        }
      }
      const element = document.createElement('style');
      element.setAttribute('data-dsh-git-workspace', '');
      element.textContent = css;
      document.head.appendChild(element);
      return () => {
        element.remove();
      };
    }

    return {
      /**
       * `uiWorkspace` is optional: without it the dialog still clones and
       * registers, but cannot browse for a directory or open the new session.
       */
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = ctx.get('locale');
        const uiWorkspace = ctx.get('uiWorkspace');
        /* `styles` is optional and is *not* one of the services declared in
           `inject` (see above). There is no `provide('styles')` anywhere in the
           repository: the runner passes a stylesheet registrar to the `factory`
           as a closure parameter (`evaluateClientHalf` in
           `cordis-refs/pkg/client-runner/lib/client.js`), and the factory only
           receives `require` here, so this lookup currently finds nothing and
           `insertStyles` falls back to a plain `<style>` element. The lookup is
           kept because a context that *does* offer the registrar is reused if a
           future host provides one — but the measured code path is the fallback.
           It is also not read as `ctx.styles`: the dynamic context only allows
           declared services as direct properties, and `ctx.styles` would make the
           guard proxy throw `dynamic ctx does not expose "styles"` and be
           reported as a guard failure on every apply(). `ctx.get(name)` performs
           no declaration check, so it is the only correct accessor here. */
        const styles = (() => {
          try {
            return ctx.get('styles');
          } catch {
            return undefined;
          }
        })();
        const store = createStore();
        ctx.effect(() => {
          if (locale === undefined) return () => {};
          try {
            return locale.register(NAMESPACE, { en: EN, zh: ZH });
          } catch {
            /* a reloaded instance can meet its own earlier dictionary */
            return () => {};
          }
        }, 'git-workspace: dictionaries');

        ctx.effect(() => insertStyles(CSS, styles), 'git-workspace: styles');

        const { GitWorkspaceTrigger, GitWorkspaceDialog } = createComponents({ locale, store, uiWorkspace });

        ctx.slots.inject('conversation.hero.options', () =>
          ctx.slots.register(
            {
              name: 'conversation.hero.options',
              id: 'git-workspace',
              order: 100,
              label: () => text(locale, 'trigger.label'),
            },
            GitWorkspaceTrigger,
          ),
        );

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'git-workspace-dialog',
              order: 100,
              label: () => text(locale, 'dialog.title'),
            },
            GitWorkspaceDialog,
          ),
        );

        /* Closing on teardown keeps a stale store from reopening a dialog in a
           successor instance that was created with the same module scope. */
        ctx.effect(() => () => store.close(), 'git-workspace: dialog state');
      },
    };
  },
});
