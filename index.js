/**
 * Host half of `@wuqiyang312/dsh-git-workspace`.
 *
 * One capability, three routes under `/api/git-workspace`:
 *
 *   GET  /defaults  what the dialog should pre-fill (clone root, platform)
 *   POST /parse     parse a Git address into owner/repo/branch (no I/O)
 *   POST /clone     clone into the clone root and register the result
 *
 * The routes go through `ctx.connection.fetch.register` rather than a Web
 * server of this plugin's own: that registry already sits behind Connection's
 * Host/Origin and browser-authentication checks, so the endpoints are
 * same-origin and authenticated without this plugin re-implementing either.
 *
 * Everything user-supplied is validated in `src/parse.js` and `src/clone.js`
 * before it reaches a child process; git always runs in argv form.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { GitWorkspaceError, parseGitUrl } from './src/parse.js';
import { cloneRepository, positiveInteger } from './src/clone.js';

/** Route prefix for every endpoint in this module. */
export const ROUTE_PREFIX = '/api/git-workspace';

/** Folder created next to the default workspace directory when `cloneRoot` is empty. */
export const DEFAULT_CLONE_DIR_NAME = 'repos';

/**
 * Services read with `ctx.get`: none is a hard dependency, so a profile without
 * the workspace layer still activates and reports what is missing per request.
 */
export const inject = [];

const DEFAULT_CONFIG = {
  cloneRoot: '',
  gitCommand: 'git',
  timeoutMs: 600_000,
  maxOutputBytes: 65_536,
  shallow: false,
  depth: 1,
  maxBodyBytes: 65_536,
};

/**
 * Turn one Loader row into a configuration object.
 *
 * The fields are validated at runtime rather than through a schemastery schema:
 * a bad value then produces a readable warning instead of a load failure that
 * hides the whole plugin, and the routes keep answering with a usable default.
 *
 * @param {unknown} raw the row's `config`.
 * @param {{warn?: (text: string) => void}} [logger] Host logger.
 * @returns {typeof DEFAULT_CONFIG} the effective configuration.
 */
export function normalizeConfig(raw, logger) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const config = { ...DEFAULT_CONFIG };

  if (typeof source.cloneRoot === 'string') {
    const value = source.cloneRoot.trim();
    if (value !== '' && !path.isAbsolute(value)) {
      logger?.warn?.(`[git-workspace] cloneRoot must be an absolute path; "${value}" is ignored and the default is used.`);
    } else {
      config.cloneRoot = value;
    }
  } else if (source.cloneRoot !== undefined) {
    logger?.warn?.('[git-workspace] cloneRoot must be a string; the default is used.');
  }

  if (typeof source.gitCommand === 'string' && source.gitCommand.trim() !== '') {
    const value = source.gitCommand.trim();
    /* A command with whitespace would only "work" through a shell, which this
       plugin never uses, so it is rejected instead of silently failing. */
    if (/\s/.test(value)) {
      logger?.warn?.('[git-workspace] gitCommand cannot contain whitespace; "git" is used.');
    } else {
      config.gitCommand = value;
    }
  }

  config.timeoutMs = positiveInteger(source.timeoutMs, DEFAULT_CONFIG.timeoutMs, 3_600_000);
  config.maxOutputBytes = positiveInteger(source.maxOutputBytes, DEFAULT_CONFIG.maxOutputBytes, 4_194_304);
  config.maxBodyBytes = positiveInteger(source.maxBodyBytes, DEFAULT_CONFIG.maxBodyBytes, 1_048_576);
  config.depth = positiveInteger(source.depth, DEFAULT_CONFIG.depth, 1000);
  if (typeof source.shallow === 'boolean') config.shallow = source.shallow;

  return config;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function success(value) {
  return json({ ok: true, value });
}

function failure(code, message, status = 200) {
  return json({ ok: false, error: { code, message } }, status);
}

/**
 * Read a JSON body, refusing anything larger than `limit` before it is parsed.
 *
 * A malformed body is a 400 with a stable code, never an exception that escapes
 * into the Connection handler.
 *
 * @param {Request} request incoming request.
 * @param {number} limit byte cap.
 * @returns {Promise<{ ok: true, value: Record<string, unknown> } | { ok: false, response: Response }>}
 */
export async function readJsonBody(request, limit) {
  let bytes;
  try {
    bytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return { ok: false, response: failure('git-workspace/body-unreadable', 'The request body could not be read.', 400) };
  }
  if (bytes.byteLength > limit) {
    return {
      ok: false,
      response: failure(
        'git-workspace/body-too-large',
        `The request body is larger than ${limit} bytes.`,
        413,
      ),
    };
  }
  if (bytes.byteLength === 0) return { ok: true, value: {} };
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return { ok: false, response: failure('git-workspace/invalid-json', 'The request body is not valid JSON.', 400) };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, response: failure('git-workspace/invalid-json', 'The request body must be a JSON object.', 400) };
  }
  return { ok: true, value: parsed };
}

/** Optional string field: absent, null and blank all mean "not supplied". */
function optionalText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Build the Host half's request handlers.
 *
 * Separated from `apply()` so the routes can be driven directly in a test
 * without a Cordis context.
 *
 * @param {object} input
 * @param {typeof DEFAULT_CONFIG} input.config effective configuration.
 * @param {() => string | undefined} input.defaultDirectory reads the profile's default workspace directory.
 * @param {() => object | undefined} input.registry reads `ctx.get('workspaceRegistry')`.
 * @param {{warn?: Function, info?: Function, error?: Function}} [input.logger]
 * @param {(dir: string) => Promise<void>} [input.ensureDirectory] directory preparation (injectable for tests).
 * @returns {{ defaults: Function, parse: Function, clone: Function }} handlers returning `Response`.
 */
export function createHandlers(input) {
  const { config } = input;
  const ensureDirectory =
    input.ensureDirectory ??
    (async (directory) => {
      await fs.mkdir(directory, { recursive: true });
      const stat = await fs.stat(directory);
      if (!stat.isDirectory()) throw new Error('not a directory');
    });

  /**
   * The clone root actually in force.
   *
   * `cloneRoot` wins when configured; otherwise the repositories live beside
   * the default workspace directory (`<dirname>/repos`), so they never land
   * inside the workspace the profile is already working in.
   */
  const resolveCloneRoot = () => {
    if (config.cloneRoot !== '') return config.cloneRoot;
    const fallback = input.defaultDirectory();
    if (typeof fallback !== 'string' || fallback === '') return undefined;
    return path.join(path.dirname(fallback), DEFAULT_CLONE_DIR_NAME);
  };

  const defaults = async () => {
    const directory = resolveCloneRoot();
    if (directory === undefined) {
      return failure(
        'git-workspace/no-clone-root',
        'No clone root is configured and the profile has no default workspace directory to derive one from.',
      );
    }
    try {
      await ensureDirectory(directory);
    } catch (error) {
      return failure(
        'git-workspace/clone-root-failed',
        `The clone root ${directory} could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return success({
      parentDirectory: directory,
      separator: path.sep,
      platform: process.platform,
      shallow: config.shallow,
      configured: config.cloneRoot !== '',
    });
  };

  const parse = async (request) => {
    const body = await readJsonBody(request, config.maxBodyBytes);
    if (body.ok !== true) return body.response;
    try {
      return success(parseGitUrl(body.value.url));
    } catch (error) {
      if (error instanceof GitWorkspaceError) return failure(error.code, error.message);
      return failure('git-workspace/invalid-url', 'The address could not be parsed.');
    }
  };

  const clone = async (request) => {
    const body = await readJsonBody(request, config.maxBodyBytes);
    if (body.ok !== true) return body.response;

    const url = optionalText(body.value.url);
    if (url === undefined) {
      return failure('git-workspace/missing-url', 'Enter a Git address.', 400);
    }

    /* The dialog may override the root, but only with an absolute path; a
       relative one would otherwise resolve against the Host's cwd. */
    const requestedParent = optionalText(body.value.parentDirectory);
    let parentDirectory;
    if (requestedParent === undefined) {
      parentDirectory = resolveCloneRoot();
      if (parentDirectory === undefined) {
        return failure(
          'git-workspace/no-clone-root',
          'No clone root is configured and the profile has no default workspace directory to derive one from.',
        );
      }
    } else if (!path.isAbsolute(requestedParent)) {
      return failure('git-workspace/invalid-parent-directory', 'The parent directory must be an absolute path.', 400);
    } else {
      parentDirectory = requestedParent;
    }

    /* The dialog's shallow switch decides this. An explicit boolean wins; a
       numeric `depth` is still honoured for scripted callers; with neither, the
       profile's `shallow` setting applies. */
    const requestedDepth = body.value.depth;
    const requestedShallow = body.value.shallow;
    let depth;
    if (typeof requestedShallow === 'boolean') {
      depth = requestedShallow ? config.depth : undefined;
    } else if (requestedDepth === undefined || requestedDepth === null || requestedDepth === false) {
      depth = config.shallow ? config.depth : undefined;
    } else if (requestedDepth === true) {
      depth = config.depth;
    } else {
      depth = positiveInteger(requestedDepth, config.depth, 1000);
    }

    const cloned = await cloneRepository({
      url,
      branch: optionalText(body.value.branch),
      parentDirectory,
      folderName: optionalText(body.value.folderName),
      depth,
      gitCommand: config.gitCommand,
      timeoutMs: config.timeoutMs,
      maxOutputBytes: config.maxOutputBytes,
      logger: input.logger,
    });
    if (cloned.ok !== true) return failure(cloned.error.code, cloned.error.message);

    const registry = input.registry();
    if (registry === undefined || typeof registry.create !== 'function') {
      /* The clone stays on disk on purpose: it is the user's repository, and
         deleting it would be a worse outcome than an unregistered directory. */
      return failure(
        'git-workspace/no-workspace-registry',
        `The repository was cloned to ${cloned.value.path}, but this profile has no workspace registry to register it with.`,
      );
    }

    let workspace;
    try {
      workspace = await registry.create(cloned.value.path, cloned.value.folderName);
    } catch (error) {
      return failure(
        'git-workspace/register-failed',
        `The repository was cloned to ${cloned.value.path}, but it could not be registered as a workspace: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    input.logger?.info?.(`[git-workspace] registered ${cloned.value.path} as workspace ${String(workspace?.id)}`);
    return success({
      workspace: {
        workspaceId: String(workspace?.id ?? ''),
        path: typeof workspace?.path === 'string' ? workspace.path : cloned.value.path,
        title: typeof workspace?.title === 'string' ? workspace.title : cloned.value.folderName,
      },
      branch: cloned.value.branch,
      folderName: cloned.value.folderName,
      clonedPath: cloned.value.path,
    });
  };

  return { defaults, parse, clone };
}

/**
 * Activate the Host half.
 *
 * @param {object} ctx Cordis Host context.
 * @param {unknown} rawConfig the Loader row's `config`.
 */
export function apply(ctx, rawConfig) {
  const logger = ctx?.logger;
  const config = normalizeConfig(rawConfig, logger);

  const defaultDirectory = () => {
    try {
      const service = ctx.get('workingDirectory');
      const value = service?.defaultDirectory;
      return typeof value === 'string' && value !== '' ? value : undefined;
    } catch {
      return undefined;
    }
  };

  const registry = () => {
    try {
      return ctx.get('workspaceRegistry');
    } catch {
      return undefined;
    }
  };

  const handlers = createHandlers({ config, defaultDirectory, registry, logger });

  const connection = (() => {
    try {
      return ctx.get('connection');
    } catch {
      return undefined;
    }
  })();

  if (connection === undefined || typeof connection?.fetch?.register !== 'function') {
    logger?.warn?.('[git-workspace] the connection service is absent; /api/git-workspace is not served in this profile');
    return;
  }

  const disposers = [];

  const register = (route) => {
    const dispose = connection.fetch.register({ ...route, requestBody: 'buffered' });
    if (typeof dispose === 'function') disposers.push(dispose);
  };

  try {
    register({
      path: `${ROUTE_PREFIX}/defaults`,
      methods: ['GET', 'HEAD'],
      fetch: async () => handlers.defaults(),
    });
    register({
      path: `${ROUTE_PREFIX}/parse`,
      methods: ['POST'],
      fetch: async (request) => handlers.parse(request),
    });
    register({
      path: `${ROUTE_PREFIX}/clone`,
      methods: ['POST'],
      fetch: async (request) => handlers.clone(request),
    });
  } catch (error) {
    logger?.error?.(
      `[git-workspace] route registration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  /* One effect owns every route, so a reloaded instance releases the exact set
     it registered and never a successor's. */
  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        const result = dispose();
        if (result !== null && typeof result === 'object' && typeof result.catch === 'function') {
          result.catch(() => {});
        }
      } catch {
        /* already released */
      }
    }
    disposers.length = 0;
  }, 'git-workspace: routes');
}
