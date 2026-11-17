/**
 * Cloning for `@wuqiyang312/dsh-git-workspace`.
 *
 * Two layers, deliberately separated:
 *
 *   - `planClone()` is pure. It validates every user-supplied string, resolves
 *     the destination, and builds the argv vector. Tests drive it directly.
 *   - `cloneRepository()` is the only function that touches the filesystem and
 *     a child process. It runs `git clone` in argv form (never a shell string),
 *     into a staging directory beside the destination, and renames only after
 *     git exited successfully.
 *
 * Why staging + rename: a half-finished clone would otherwise sit at the
 * destination path, where the next attempt would collide with it and where the
 * workspace registry could register a broken directory. A staging directory
 * leaves the destination either absent or complete, and a failed or timed-out
 * run deletes its own staging directory.
 *
 * Why git's output goes to files instead of pipes: a piped child process is a
 * named-pipe pair on Windows, which some sandboxes forbid outright, and a pipe
 * also needs draining concurrently to avoid a deadlock. Redirecting stdout and
 * stderr to two temporary files needs neither: the child writes at its own
 * pace, and only the tail is read back afterwards, so `maxOutputBytes` is a
 * real bound on what this process allocates.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { GitWorkspaceError, assertSafeBranch, assertSafeFolderName, parseGitUrl } from './parse.js';

/** Prefix of the staging directory created next to the clone target. */
export const STAGING_PREFIX = '.git-workspace-';

/** How long a stopped clone may keep running before the result is reported anyway. */
const KILL_GRACE_MS = 5_000;

/**
 * Destinations currently being cloned, by normalized path. A second request for
 * the same folder is refused rather than racing the first one's rename.
 * @type {Set<string>}
 */
export const inFlightTargets = new Set();

function normalizeKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function invalid(message, code = 'git-workspace/invalid-request') {
  return new GitWorkspaceError(code, message);
}

/**
 * Read a positive integer option, falling back to the default for anything
 * unusable. Config values arrive from a YAML row, so they are never trusted.
 *
 * @param {unknown} value candidate.
 * @param {number} fallback used when `value` is not a positive integer.
 * @param {number} max upper bound.
 * @returns {number} a usable number.
 */
export function positiveInteger(value, fallback, max) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}

/**
 * Validate the destination side of a clone and build its argv vector.
 *
 * @param {object} input
 * @param {unknown} input.url Git address as typed by the user.
 * @param {unknown} [input.branch] branch, tag or ref; empty means the remote default.
 * @param {unknown} [input.parentDirectory] absolute parent directory.
 * @param {unknown} [input.folderName] single-segment destination folder name.
 * @param {unknown} [input.depth] shallow depth; `undefined` means full history.
 * @param {string} [input.gitCommand] executable name or path.
 * @returns {{
 *   parsed: ReturnType<typeof parseGitUrl>,
 *   parentDirectory: string,
 *   folderName: string,
 *   targetPath: string,
 *   stagingPath: string,
 *   depth: number | null,
 *   argv: string[],
 * }} the resolved plan; throws instead of guessing.
 * @throws {GitWorkspaceError} for every rejected input.
 */
export function planClone(input) {
  const options = input !== null && typeof input === 'object' ? input : {};
  const parsed = parseGitUrl(options.url);

  const rawParent = options.parentDirectory;
  if (typeof rawParent !== 'string' || rawParent.trim() === '') {
    throw invalid('A parent directory is required.', 'git-workspace/invalid-parent-directory');
  }
  const parentText = rawParent.trim();
  if (parentText.includes('\u0000')) {
    throw invalid('The parent directory contains NUL.', 'git-workspace/invalid-parent-directory');
  }
  if (!path.isAbsolute(parentText)) {
    throw invalid('The parent directory must be an absolute path.', 'git-workspace/invalid-parent-directory');
  }
  const parentDirectory = path.resolve(parentText);

  /* An explicit folder name wins; otherwise the repository name is used. */
  const folderName =
    typeof options.folderName === 'string' && options.folderName.trim() !== ''
      ? assertSafeFolderName(options.folderName.trim())
      : parsed.folderName;

  const targetPath = path.join(parentDirectory, folderName);
  /* Belt and braces: `assertSafeFolderName` already forbids separators, so a
     disagreement here means the join was reinterpreted. Refuse rather than
     clone outside the chosen directory. */
  if (normalizeKey(path.dirname(targetPath)) !== normalizeKey(parentDirectory)) {
    throw invalid('The folder name escapes the parent directory.', 'git-workspace/invalid-folder-name');
  }

  const branch =
    typeof options.branch === 'string' && options.branch.trim() !== ''
      ? assertSafeBranch(options.branch)
      : parsed.branch;

  const rawDepth = options.depth;
  let depth = null;
  if (rawDepth !== undefined && rawDepth !== null && rawDepth !== '' && rawDepth !== false) {
    depth = positiveInteger(rawDepth, 1, 1000);
  }

  const stagingPath = path.join(parentDirectory, `${STAGING_PREFIX}${randomUUID()}`);
  const argv = buildCloneArgs({
    cloneUrl: parsed.cloneUrl,
    branch,
    depth,
    targetPath: stagingPath,
  });

  return {
    parsed,
    parentDirectory,
    folderName,
    targetPath,
    stagingPath,
    depth,
    argv,
  };
}

/**
 * Build the argument vector for one clone.
 *
 * `--` ends option parsing, so even a repository name that starts with `-`
 * cannot become an option; the URL check in `parse.js` rejects that anyway.
 *
 * @param {{ cloneUrl: string, branch?: string | null, depth?: number | null, targetPath: string }} input
 * @returns {string[]} argv for the configured git executable.
 */
export function buildCloneArgs(input) {
  const argv = ['clone', '--progress'];
  if (typeof input.branch === 'string' && input.branch !== '') {
    argv.push('--branch', input.branch, '--single-branch');
  }
  if (typeof input.depth === 'number' && input.depth > 0) {
    argv.push(`--depth=${input.depth}`);
  }
  argv.push('--', input.cloneUrl, input.targetPath);
  return argv;
}

/**
 * Ask one process and, on Windows, its children to stop.
 *
 * This only *requests* a stop; it never claims that anything exited. The caller
 * waits for an observed `exit`/`close` afterwards, because a request can be
 * refused: measured on this workspace's Windows host, `taskkill /T /F` on a
 * child of this process exits with code 1 ("Access denied") and leaves the
 * child running. Its exit code is therefore observed, and any non-zero exit —
 * like a spawn error — falls back to signalling the direct child, which is
 * what actually terminates it (`child.kill('SIGKILL')` exits within ~500 ms).
 * The grandchild tree may still survive that fallback; nothing here can promise
 * otherwise.
 *
 * @param {object | null | undefined} child the child process handle.
 * @param {{ spawnKiller?: Function, platform?: string }} [options] overrides, used by the tests.
 * @returns {Promise<void>} resolves once the stop was requested, never rejects.
 */
export function killProcessTree(child, options) {
  if (child === null || child === undefined) return Promise.resolve();
  const spawnKiller = typeof options?.spawnKiller === 'function' ? options.spawnKiller : spawn;
  const platform = typeof options?.platform === 'string' ? options.platform : process.platform;

  const killDirect = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  };

  if (platform !== 'win32' || child.pid === undefined) {
    killDirect();
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    let killer;
    try {
      killer = spawnKiller('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      killDirect();
      done();
      return;
    }

    /* `runGit` does not await this before its deadline, so the fallback must run
       here rather than in the caller: a refused taskkill is the common case on
       the measured Windows host, and the direct signal is what ends the child. */
    killer.on('error', () => {
      killDirect();
      done();
    });
    killer.on('exit', (code) => {
      if (code !== 0) killDirect();
      done();
    });
  });
}

/**
 * Milliseconds as seconds for the wording, to one decimal place.
 *
 * `Math.round(ms / 1000)` reported a 1200 ms limit as "within 1s", which is
 * simply not the limit that expired. One decimal keeps small limits honest
 * (1200 → `1.2`) while whole minutes stay whole numbers (600000 → `600`).
 *
 * @param {number} timeoutMs the limit that expired.
 * @returns {string} seconds, ready to be followed by `s`.
 */
function roundSeconds(timeoutMs) {
  const seconds = Math.round(Number(timeoutMs) / 100) / 10;
  if (!Number.isFinite(seconds)) return '0';
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
}

/**
 * The sentence reported for a clone that ran out of time.
 *
 * `exited` is evidence, not optimism: only a process whose `exit`/`close` was
 * observed is described as stopped. Without that evidence the message says the
 * stop was requested and that the process may still be running — the outcome
 * the old text silently misreported.
 *
 * @param {object} input
 * @param {number} input.timeoutMs the limit that expired.
 * @param {boolean} input.exited whether the child's exit was observed.
 * @param {number} [input.graceMs] the deadline that was waited for, for the wording.
 * @returns {string} one English sentence, ready to become an error message.
 */
export function timeoutMessage(input) {
  const seconds = roundSeconds(input.timeoutMs);
  if (input.exited === true) {
    return `git clone did not finish within ${seconds}s; the process was stopped (exit observed).`;
  }
  const graceSeconds = Math.round((input.graceMs ?? KILL_GRACE_MS) / 100) / 10;
  return `git clone did not finish within ${seconds}s. A stop was requested, but the process exit was not confirmed within ${graceSeconds}s — it may still be running and may still hold files in the staging directory.`;
}

/** True when a path exists at all, without following the final component's type. */
async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Read at most the last `limit` bytes of a file.
 *
 * The size is checked first, so a huge log never enters memory: only the tail
 * that will be shown is read.
 *
 * @param {string} file path to read.
 * @param {number} limit byte cap.
 * @returns {Promise<{ text: string, truncated: boolean }>} the tail and whether anything was dropped.
 */
export async function readTail(file, limit) {
  let size = 0;
  try {
    size = (await fs.stat(file)).size;
  } catch {
    return { text: '', truncated: false };
  }
  if (size === 0) return { text: '', truncated: false };
  const start = Math.max(0, size - limit);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  let handle;
  try {
    handle = await fs.open(file, 'r');
    await handle.read(buffer, 0, length, start);
  } catch {
    return { text: '', truncated: false };
  } finally {
    await handle?.close().catch(() => {});
  }
  /* A tail cut at a byte boundary can split a multi-byte character; the
     replacement character that produces is trimmed off the front. */
  const text = buffer.toString('utf8').replace(/^\uFFFD+/, '').trim();
  return { text, truncated: start > 0 };
}

/** Remove a staging directory; a failure here is reported, never hidden. */
async function removeStaging(stagingPath) {
  try {
    await fs.rm(stagingPath, { recursive: true, force: true, maxRetries: 3 });
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Run one git command with its output redirected to temporary files.
 *
 * @param {object} input
 * @param {Function} input.spawnProcess the child-process factory.
 * @param {Function} input.killTree the process-tree killer.
 * @param {string} input.gitCommand executable.
 * @param {string[]} input.argv arguments.
 * @param {string} input.cwd working directory.
 * @param {number} input.timeoutMs wall-clock limit.
 * @param {number} input.maxOutputBytes retained tail per stream.
 * @param {number} [input.killGraceMs] hard deadline for an observed exit after the stop request.
 * @returns {Promise<{ ok: true } | { ok: false, error: { code: string, message: string } }>}
 */
async function runGit(input) {
  const token = randomUUID();
  const outPath = path.join(os.tmpdir(), `dsh-git-workspace-${token}.out`);
  const errPath = path.join(os.tmpdir(), `dsh-git-workspace-${token}.err`);
  let outFd;
  let errFd;
  try {
    outFd = fsSync.openSync(outPath, 'w');
    errFd = fsSync.openSync(errPath, 'w');
  } catch (error) {
    if (outFd !== undefined) fsSync.closeSync(outFd);
    return {
      ok: false,
      error: {
        code: 'git-workspace/spawn-failed',
        message: `A temporary log file could not be created: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }

  let child = null;
  let timer = null;
  let graceTimer = null;
  let timedOut = false;
  /* Evidence, not intent: set only by the child's own `exit`/`close` events. */
  let exitObserved = false;

  try {
    const completed = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      try {
        child = input.spawnProcess(input.gitCommand, input.argv, {
          cwd: input.cwd,
          windowsHide: true,
          /* argv only: no shell, so no prompt and no quoting rules. */
          shell: false,
          env: {
            ...process.env,
            /* Never wait for a credential prompt: there is no terminal to answer it. */
            GIT_TERMINAL_PROMPT: '0',
            GIT_ASKPASS: 'echo',
            GCM_INTERACTIVE: 'never',
            GIT_OPTIONAL_LOCKS: '0',
          },
          stdio: ['ignore', outFd, errFd],
        });
      } catch (error) {
        finish({
          ok: false,
          error: {
            code: 'git-workspace/spawn-failed',
            message: `git could not be started (${input.gitCommand}): ${error instanceof Error ? error.message : String(error)}`,
          },
        });
        return;
      }

      child.on('error', (error) => {
        finish({
          ok: false,
          error: {
            code: 'git-workspace/spawn-failed',
            message: `git could not be started (${input.gitCommand}): ${error.message}`,
          },
        });
      });

      child.on('close', (code, signal) => {
        /* This event is observed termination, so it is evidence in its own right. */
        exitObserved = true;
        if (timedOut) {
          finish({ ok: false, timedOut: true, exited: true, signal });
          return;
        }
        if (code === 0) {
          finish({ ok: true });
          return;
        }
        finish({
          ok: false,
          exitCode: code,
          signal,
          timedOut: false,
        });
      });

      /* On Windows a stopped child can report `exit` while `close` still waits
         for stdio; either event proves the process itself is gone. */
      child.on('exit', () => {
        exitObserved = true;
        if (timedOut) finish({ ok: false, timedOut: true, exited: true });
      });

      /* Armed after spawn, so a slow start still counts. Neither timer is
         unref'd: the timeout is the guarantee that this call settles, so it must
         keep the event loop alive on its own.
         The stop request is *not* awaited before the deadline: the Windows path
         (taskkill, then a fallback signal when it is refused) is itself
         asynchronous and a broken killer must not be able to hang the clone.
         The deadline therefore runs from the moment of the request, and it
         reports what was actually observed (`exitObserved`), not what was
         requested. */
      timer = setTimeout(() => {
        timedOut = true;
        graceTimer = setTimeout(() => {
          finish({ ok: false, timedOut: true, exited: exitObserved });
        }, input.killGraceMs ?? KILL_GRACE_MS);
        Promise.resolve()
          .then(() => input.killTree(child))
          .catch(() => {});
      }, input.timeoutMs);
    });

    if (completed.ok === true) return { ok: true };
    /* A pre-formed failure (the process never started) already carries its own
       stable code; do not rewrite it as a clone failure. */
    if (completed.error !== undefined) return { ok: false, error: completed.error };

    const stderr = await readTail(errPath, input.maxOutputBytes);
    const stdout = completed.timedOut === true ? { text: '', truncated: false } : await readTail(outPath, input.maxOutputBytes);
    const detail = stderr.text !== '' ? stderr : stdout;
    const suffix = detail.text === '' ? '' : `\n${detail.text}${detail.truncated ? '\n… (output truncated)' : ''}`;

    if (completed.timedOut === true) {
      return {
        ok: false,
        error: {
          code: 'git-workspace/clone-timeout',
          /* The caller finishes this sentence: only it knows whether the
             staging cleanup succeeded. */
          message: timeoutMessage({
            timeoutMs: input.timeoutMs,
            exited: completed.exited === true,
            graceMs: input.killGraceMs ?? KILL_GRACE_MS,
          }),
        },
        /* Evidence for the caller: whether the child's exit was observed, and
           git's tail, so the final message can be assembled in one place. */
        timeout: {
          timeoutMs: input.timeoutMs,
          exited: completed.exited === true,
          graceMs: input.killGraceMs ?? KILL_GRACE_MS,
          suffix,
        },
      };
    }

    const how =
      completed.signal === null || completed.signal === undefined
        ? `exit ${String(completed.exitCode)}`
        : `signal ${String(completed.signal)}`;
    return {
      ok: false,
      error: {
        code: 'git-workspace/clone-failed',
        message: `git clone failed (${how}).${suffix}`,
      },
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (graceTimer !== null) clearTimeout(graceTimer);
    /* The child may still hold the descriptors on a hard kill; closing a file
       descriptor twice would throw, so each close is guarded. */
    try {
      fsSync.closeSync(outFd);
    } catch {
      /* already closed */
    }
    try {
      fsSync.closeSync(errFd);
    } catch {
      /* already closed */
    }
    await fs.rm(outPath, { force: true }).catch(() => {});
    await fs.rm(errPath, { force: true }).catch(() => {});
  }
}

/**
 * Clone one repository and hand back the finished directory.
 *
 * Never throws: the resolved value carries either the clone or a stable error
 * code plus the tail of git's own diagnostics, which is what the dialog shows.
 *
 * @param {object} input
 * @param {unknown} input.url Git address.
 * @param {unknown} [input.branch] branch, tag or ref.
 * @param {string} input.parentDirectory absolute parent directory; created when missing.
 * @param {unknown} [input.folderName] destination folder name; defaults to the repository name.
 * @param {unknown} [input.depth] shallow depth; omitted means full history.
 * @param {string} [input.gitCommand] git executable, argv only.
 * @param {number} [input.timeoutMs] wall clock limit for the clone.
 * @param {number} [input.maxOutputBytes] retained stdout/stderr tail.
 * @param {{warn?: (text: string) => void}} [input.logger] optional Host logger.
 * @param {Function} [input.spawn] child-process factory; the default is `node:child_process`'s `spawn`.
 *   It exists so the timeout path can be driven without waiting on a real process.
 * @param {(child: object) => void | Promise<void>} [input.kill] process-tree killer; the default is the
 *   platform's own (SIGKILL, or `taskkill /T /F` on Windows with a direct-signal fallback).
 * @param {number} [input.killGraceMs] how long to wait for an observed exit after the stop request
 *   before reporting the timeout anyway (default 5s, capped at 30s). Tests shorten it.
 * @returns {Promise<
 *   | { ok: true, value: { path: string, folderName: string, branch: string | null, parsed: object } }
 *   | { ok: false, error: { code: string, message: string } }
 * >}
 */
export async function cloneRepository(input) {
  const options = input !== null && typeof input === 'object' ? input : {};
  const gitCommand = typeof options.gitCommand === 'string' && options.gitCommand !== '' ? options.gitCommand : 'git';
  const timeoutMs = positiveInteger(options.timeoutMs, 600_000, 3_600_000);
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, 65_536, 4_194_304);
  const killGraceMs = positiveInteger(options.killGraceMs, KILL_GRACE_MS, 30_000);
  /* Injectable so the tests can exercise the timeout path without a real
     remote and without waiting a real ten minutes. */
  const spawnProcess = typeof options.spawn === 'function' ? options.spawn : spawn;
  const killTree = typeof options.kill === 'function' ? options.kill : killProcessTree;

  let plan;
  try {
    plan = planClone(options);
  } catch (error) {
    if (error instanceof GitWorkspaceError) {
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    return { ok: false, error: { code: 'git-workspace/invalid-request', message: 'The clone request could not be read.' } };
  }

  const key = normalizeKey(plan.targetPath);

  /* The parent directory is created here, not in the plan: the plan stays pure. */
  try {
    await fs.mkdir(plan.parentDirectory, { recursive: true });
    const stat = await fs.stat(plan.parentDirectory);
    if (!stat.isDirectory()) {
      return {
        ok: false,
        error: {
          code: 'git-workspace/invalid-parent-directory',
          message: 'The parent directory is not a directory.',
        },
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'git-workspace/invalid-parent-directory',
        message: `The parent directory could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }

  /* Refuse an occupied destination up front; never overwrite, never delete. */
  try {
    if (await pathExists(plan.targetPath)) {
      return {
        ok: false,
        error: {
          code: 'git-workspace/target-exists',
          message: `${plan.targetPath} already exists. Choose another folder name or parent directory.`,
        },
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'git-workspace/target-check-failed',
        message: `The destination could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }

  if (inFlightTargets.has(key)) {
    return {
      ok: false,
      error: {
        code: 'git-workspace/clone-busy',
        message: `Another clone is already writing ${plan.folderName} in that directory.`,
      },
    };
  }
  inFlightTargets.add(key);

  try {
    const completed = await runGit({
      spawnProcess,
      killTree,
      gitCommand,
      argv: plan.argv,
      cwd: plan.parentDirectory,
      timeoutMs,
      maxOutputBytes,
      killGraceMs,
    });

    if (completed.ok !== true) {
      const cleanupError = await removeStaging(plan.stagingPath);
      if (cleanupError !== null) {
        options.logger?.warn?.(`[git-workspace] staging cleanup failed: ${cleanupError.message}`);
      }
      /* A failed cleanup is part of the outcome, not a log-only detail: the
         message must say that the staging directory survived. */
      const cleanupNote =
        cleanupError === null
          ? ''
          : `\nThe staging directory ${plan.stagingPath} could not be removed: ${cleanupError.message}`;

      let message = completed.error.message;
      if (completed.timeout !== undefined) {
        const tail = completed.timeout.suffix;
        message = `${timeoutMessage({
          timeoutMs: completed.timeout.timeoutMs,
          exited: completed.timeout.exited === true,
          graceMs: completed.timeout.graceMs,
        })}${tail}`;
      }
      return { ok: false, error: { code: completed.error.code, message: `${message}${cleanupNote}` } };
    }

    try {
      await fs.rename(plan.stagingPath, plan.targetPath);
    } catch (error) {
      const cleanupError = await removeStaging(plan.stagingPath);
      if (cleanupError !== null) {
        options.logger?.warn?.(`[git-workspace] staging cleanup failed: ${cleanupError.message}`);
      }
      /* Same rule as the clone-failed branch above: a staging directory that
         survived cleanup is part of the outcome, not a log-only detail. The
         caller shows `message`, so the leftover path has to be in it. */
      const cleanupNote =
        cleanupError === null
          ? ''
          : `\nThe staging directory ${plan.stagingPath} could not be removed: ${cleanupError.message}`;
      return {
        ok: false,
        error: {
          code: 'git-workspace/move-failed',
          message: `The clone finished but could not be moved to ${plan.targetPath}: ${
            error instanceof Error ? error.message : String(error)
          }${cleanupNote}`,
        },
      };
    }

    return {
      ok: true,
      value: {
        path: plan.targetPath,
        folderName: plan.folderName,
        branch: typeof options.branch === 'string' && options.branch.trim() !== '' ? options.branch.trim() : plan.parsed.branch,
        parsed: plan.parsed,
      },
    };
  } finally {
    inFlightTargets.delete(key);
  }
}
