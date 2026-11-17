/**
 * Git address parsing for `@wuqiyang312/dsh-git-workspace`.
 *
 * Everything in this file is pure: no filesystem, no child process, no clock.
 * That is deliberate — the browser asks the Host to parse as the user types
 * (`POST /api/git-workspace/parse`), and the same function decides what the
 * clone step is allowed to run, so it is the one place worth unit-testing.
 *
 * Accepted shapes
 * ---------------
 *   https://host/owner/repo
 *   https://host/owner/repo.git
 *   https://host/owner/repo/tree/<ref>[/<sub path>]
 *   https://host/owner/repo/blob/<ref>/<file path>
 *   https://host/owner/repo/-/tree/<ref>         (GitLab's copy-link form, also `/-/blob/…`)
 *   ssh://git@host[:port]/owner/repo.git
 *   git@host:owner/repo.git                      (scp-like, also `user@host:...`)
 *   owner/repo                                   (GitHub shorthand)
 * Nested groups are supported for URL and scp forms (`gitlab.com/group/sub/repo`).
 *
 *   file:///absolute/path/to/repo[.git]         (a local repository or mirror)
 *
 * The `file:` scheme exists for on-disk mirrors and for offline machines, and
 * it is what this bundle's own tests clone. It is accepted only as a URL with
 * an absolute path; a bare `C:\path` or `/path` spelling is refused, so the
 * field always holds an address rather than a filesystem path to some random
 * directory.
 *
 * Rejected on purpose
 * -------------------
 *   - anything that is not a string, empty, or longer than `MAX_URL_LENGTH`;
 *   - a value starting with `-` (git would read it as an option);
 *   - NUL anywhere (argv cannot carry it safely);
 *   - a host with no repository (`https://github.com`).
 *
 * Limitations
 * -----------
 *   - A ref that itself contains `/` cannot be told apart from a sub path in
 *     `/tree/...` URLs, so only the first segment after `tree`/`blob` becomes
 *     the branch. The dialog's branch field is the escape hatch.
 */

/** Longest address accepted. Longer than any real remote, short enough to log. */
export const MAX_URL_LENGTH = 2048;

/** Host assumed by the `owner/repo` shorthand. */
export const DEFAULT_HOST = 'github.com';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'ssh:', 'git:', 'file:']);

/**
 * Path segments a web frontend appends after `owner/repo`.
 *
 * Only `tree` and `blob` carry a ref worth keeping; the rest exist so that a
 * copied "view this commit / this issue" link still resolves to its repository
 * instead of being read as a deeply nested group with a nonsense last segment.
 *
 * Two rules keep nested groups reachable (GitLab allows `group/sub/repo`):
 *
 *   - `tree`/`blob` must be followed by a ref segment. A trailing `tree` is
 *     rejected rather than guessed, because both readings (a view with no ref,
 *     or a repository literally named `tree` under a group) are wrong to
 *     invent; the dialog's own fields are the escape hatch.
 *   - Any other marker counts only when at least one segment follows it
 *     (`commit/<sha>`, `issues/12`, `compare/a...b`). A trailing `/issues`,
 *     `/releases`, `/commit` … is therefore read as a repository name:
 *     `gitlab.com/group/sub/commit` is owner `group/sub`, repo `commit`.
 *     That ambiguity is structural, so the choice is deliberate: a wrong
 *     repository should fail inside `git clone` with git's own message rather
 *     than clone a different repository silently.
 *
 * GitLab's `/-/` separator
 * ------------------------
 * GitLab's "copy link to file/branch" produces `…/<repo>/-/tree/<ref>/…` and
 * `…/<repo>/-/blob/<ref>/<file>`, i.e. a lone `-` segment before the view. That
 * `-` is not part of the repository path (`git clone` would reject it), so a
 * lone `-` that still has segments after it is skipped while looking for the
 * marker: `gitlab.com/group/sub/repo/-/tree/main` is owner `group/sub`, repo
 * `repo`, branch `main`. A *trailing* `-` is not skipped — `gitlab.com/o/-`
 * stays a repository named `-`, which `assertSafeFolderName` refuses.
 */
const VIEW_MARKERS = new Set([
  'tree', 'blob', 'commit', 'commits', 'blame', 'raw', 'issues', 'pull', 'pulls',
  'actions', 'releases', 'tags', 'branches', 'compare', 'wiki', 'discussions',
  'settings', 'projects', 'graphs', 'network', 'edit', 'find', 'archive',
]);

/** Markers that name a ref; the next segment becomes the branch. */
const REF_MARKERS = new Set(['tree', 'blob']);

/**
 * Where the repository part of a web path ends.
 *
 * @param {string[]} segments path segments after the host.
 * @returns {number} index of the view marker, or -1 when the whole path is a repository.
 */
function findViewMarker(segments) {
  for (let index = 2; index < segments.length; index += 1) {
    const segment = segments[index];
    /* GitLab puts a lone `-` between the repository and the view
       (`group/sub/repo/-/tree/main`); it is never part of the repository path.
       Skipping it here keeps the scan rules below unchanged, and a *trailing*
       `-` is not skipped, so `gitlab.com/o/-` still ends up as a repository
       named `-` and is refused by `assertSafeFolderName`. */
    if (segment === '-' && index + 1 < segments.length) continue;
    if (!VIEW_MARKERS.has(segment)) continue;
    /* A ref marker always counts, even at the end of the path: the caller then
       reports "no branch after tree/blob" instead of silently reading `tree` as
       a repository name. */
    if (REF_MARKERS.has(segment)) return index;
    /* Every other marker needs a segment of its own to be a view: a trailing one
       is indistinguishable from a repository name under a nested group. */
    if (index + 1 < segments.length) return index;
  }
  return -1;
}

/**
 * The repository part of the path, without GitLab's `/-/` separator.
 *
 * `findViewMarker` skips a lone `-` on its way to the marker, so the slice up to
 * that marker can end with it (`group/sub/repo/-`). Only a *trailing* `-` of
 * that slice is dropped. Without a marker nothing is trimmed: a path that ends
 * in `-` stays a repository named `-`, which `assertSafeFolderName` refuses.
 *
 * @param {string[]} segments path segments after the host.
 * @param {number} markerIndex index of the view marker, or -1.
 * @returns {string[]} the segments that name owner/repository.
 */
function repoSegmentsOf(segments, markerIndex) {
  if (markerIndex === -1) return [...segments];
  const repoSegments = segments.slice(0, markerIndex);
  while (repoSegments.length > 2 && repoSegments[repoSegments.length - 1] === '-') repoSegments.pop();
  return repoSegments;
}

/** Windows refuses these characters in a file name; the clone target is a directory name. */
const FORBIDDEN_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;

/** Characters git refuses in a ref, plus the ones that would need shell quoting. */
const FORBIDDEN_REF_CHARS = /[\u0000-\u0020~^:?*[\\]/;

const WINDOWS_RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** Error carrying a stable, localizable code for the Client half. */
export class GitWorkspaceError extends Error {
  /**
   * @param {string} code stable `git-workspace/...` code.
   * @param {string} message human-readable English text; the Client localizes by code.
   * @param {Record<string, unknown>} [details] extra structured data.
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'GitWorkspaceError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invalid(message) {
  return new GitWorkspaceError('git-workspace/invalid-url', message);
}

function unsafe(message) {
  return new GitWorkspaceError('git-workspace/unsafe-url', message);
}

/**
 * A repository folder name: one directory segment, no separators, nothing that
 * Windows or `path.join` would reinterpret.
 *
 * @param {string} name candidate folder name.
 * @returns {string} the accepted name.
 * @throws {GitWorkspaceError} `git-workspace/invalid-folder-name`.
 */
export function assertSafeFolderName(name) {
  const fail = (reason) =>
    new GitWorkspaceError('git-workspace/invalid-folder-name', `Not a usable folder name: ${reason}.`);

  if (typeof name !== 'string') throw fail('it must be text');
  if (name === '') throw fail('it is empty');
  if (name.length > 128) throw fail('it is longer than 128 characters');
  if (name === '.' || name === '..') throw fail('"." and ".." are not folder names');
  if (name.startsWith('.')) throw fail('it cannot start with "."');
  if (name.startsWith('-')) throw fail('it cannot start with "-"');
  if (name.endsWith('.') || name.endsWith(' ')) throw fail('it cannot end with "." or a space');
  if (FORBIDDEN_NAME_CHARS.test(name)) throw fail('it contains a path separator or a reserved character');
  if (WINDOWS_RESERVED_NAMES.has(name.toLowerCase())) throw fail('it is a reserved device name');
  if (name.startsWith('.git-workspace-')) throw fail('it is reserved for a staging directory');
  return name;
}

/**
 * A branch name git will accept as an argument: no NUL, no whitespace, no ref
 * metacharacters, no leading `-` (which git would read as an option).
 *
 * @param {string} branch candidate branch.
 * @returns {string} the accepted branch.
 * @throws {GitWorkspaceError} `git-workspace/invalid-branch`.
 */
export function assertSafeBranch(branch) {
  const fail = (reason) =>
    new GitWorkspaceError('git-workspace/invalid-branch', `Not a usable branch name: ${reason}.`);

  if (typeof branch !== 'string') throw fail('it must be text');
  const value = branch.trim();
  if (value === '') throw fail('it is empty');
  if (value.length > 255) throw fail('it is longer than 255 characters');
  if (value.startsWith('-')) throw fail('it cannot start with "-"');
  if (FORBIDDEN_REF_CHARS.test(value)) throw fail('it contains a character git does not allow in a ref');
  if (value.includes('..') || value.includes('@{')) throw fail('it contains a reserved sequence');
  if (value.startsWith('/') || value.endsWith('/') || value.includes('//')) throw fail('it has an empty path segment');
  if (value.endsWith('.lock')) throw fail('it ends with ".lock"');
  if (value === '@') throw fail('"@" is not a branch name');
  return value;
}

function decodeSegment(segment) {
  let value = segment;
  if (segment.includes('%')) {
    try {
      value = decodeURIComponent(segment);
    } catch {
      throw invalid('The address contains an invalid percent escape.');
    }
  }
  if (value.includes('\u0000')) throw unsafe('The address contains NUL.');
  if (FORBIDDEN_NAME_CHARS.test(value)) throw invalid('The address contains an unusable path segment.');
  return value;
}

/** `repo.git` -> `repo`; `.git` alone is not a repository name. */
function stripGitSuffix(repo) {
  const value = repo.toLowerCase().endsWith('.git') ? repo.slice(0, -4) : repo;
  if (value === '' || value === '.') throw invalid('The address has no repository name.');
  return value;
}

function validateOwner(owner) {
  for (const segment of owner.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw invalid('The address has an unusable owner segment.');
    }
    if (FORBIDDEN_NAME_CHARS.test(segment)) throw invalid('The address has an unusable owner segment.');
  }
  return owner;
}

function result(fields) {
  return {
    kind: fields.kind,
    host: fields.host,
    owner: fields.owner,
    repo: fields.repo,
    folderName: fields.folderName,
    cloneUrl: fields.cloneUrl,
    branch: fields.branch ?? null,
    subPath: fields.subPath ?? null,
  };
}

function assertAddressString(input) {
  if (typeof input !== 'string') throw invalid('A Git address must be text.');
  const raw = input.trim();
  if (raw === '') throw invalid('Enter a Git address.');
  if (raw.length > MAX_URL_LENGTH) {
    throw new GitWorkspaceError(
      'git-workspace/url-too-long',
      `The address is longer than ${MAX_URL_LENGTH} characters.`,
    );
  }
  if (raw.startsWith('-')) throw unsafe('A Git address cannot start with "-".');
  if (raw.includes('\u0000')) throw unsafe('A Git address cannot contain NUL.');
  return raw;
}

/** Percent-decode one path segment of a `file://` address; a drive letter is legitimate here. */
function decodePathSegment(segment) {
  if (!segment.includes('%')) {
    if (segment.includes('\u0000')) throw unsafe('The address contains NUL.');
    return segment;
  }
  try {
    const value = decodeURIComponent(segment);
    if (value.includes('\u0000')) throw unsafe('The address contains NUL.');
    return value;
  } catch (error) {
    if (error instanceof GitWorkspaceError) throw error;
    throw invalid('The address contains an invalid percent escape.');
  }
}

function parseFileUrl(raw, url) {
  /* `file://host/...` with a real host would name a UNC share, which git can
     already clone through `//host/share` semantics; only the local form (empty
     host or `localhost`) is accepted here. */
  if (url.hostname !== '' && url.hostname.toLowerCase() !== 'localhost') {
    throw invalid('A file:// address must point at this machine.');
  }
  if (!url.pathname.startsWith('/')) throw invalid('A file:// address must use an absolute path.');

  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) throw invalid('A file:// address needs a repository directory.');

  const decoded = segments.map(decodePathSegment);
  const repo = stripGitSuffix(decoded[decoded.length - 1]);
  const folderName = assertSafeFolderName(repo);

  return result({
    kind: 'file',
    host: '',
    owner: decoded.slice(0, -1).join('/'),
    repo,
    folderName,
    /* The spelling as typed: git understands `file:///C:/a/b` on Windows. */
    cloneUrl: raw,
  });
}

function parseUrlForm(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw invalid('The address is not a valid URL.');
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw unsafe(`The ${url.protocol.replace(':', '')} protocol is not supported.`);
  }
  if (url.protocol === 'file:') return parseFileUrl(raw, url);
  if (url.hostname === '') throw invalid('The address has no host.');

  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  if (segments.length < 2) throw invalid('The address needs an owner and a repository.');

  /* A web frontend's view marker only counts after owner/repo; a repository
     legitimately named "tree" therefore still parses when it comes second.
     See `findViewMarker` for the trailing-marker rule that keeps nested groups
     (`gitlab.com/group/sub/repo`) intact. */
  const markerIndex = findViewMarker(segments);

  const repoSegments = repoSegmentsOf(segments, markerIndex);
  if (repoSegments.length < 2) throw invalid('The address needs an owner and a repository.');

  let branch = null;
  let subPath = null;
  if (markerIndex !== -1 && REF_MARKERS.has(segments[markerIndex])) {
    const refSegment = segments[markerIndex + 1];
    if (refSegment === undefined) throw invalid('The address has no branch after "tree"/"blob".');
    branch = assertSafeBranch(decodeSegment(refSegment));
    const rest = segments.slice(markerIndex + 2).map(decodeSegment);
    subPath = rest.length === 0 ? null : rest.join('/');
  }

  const repoSegmentsDecoded = repoSegments.map(decodeSegment);
  const repo = stripGitSuffix(repoSegmentsDecoded[repoSegmentsDecoded.length - 1]);
  const owner = validateOwner(repoSegmentsDecoded.slice(0, -1).join('/'));
  const folderName = assertSafeFolderName(repo);

  const userinfo =
    url.username === ''
      ? ''
      : `${url.username}${url.password === '' ? '' : `:${url.password}`}@`;
  const cloneUrl = `${url.protocol}//${userinfo}${url.host}/${repoSegments.join('/')}`;

  return result({ kind: 'url', host: url.hostname.toLowerCase(), owner, repo, folderName, cloneUrl, branch, subPath });
}

function parseScpForm(raw, match) {
  const host = match[2];
  const pathPart = match[3];
  const segments = pathPart.split('/').filter((segment) => segment !== '');
  if (segments.length < 2) throw invalid('The address needs an owner and a repository.');
  if (pathPart.includes(':')) throw invalid('The address has more than one ":" separator.');

  const decoded = segments.map(decodeSegment);
  const repo = stripGitSuffix(decoded[decoded.length - 1]);
  const owner = validateOwner(decoded.slice(0, -1).join('/'));
  const folderName = assertSafeFolderName(repo);

  return result({
    kind: 'scp',
    host: host.toLowerCase(),
    owner,
    repo,
    folderName,
    /* The scp spelling is the clone URL; git needs the colon form, not an ssh:// rewrite. */
    cloneUrl: raw,
  });
}

function parseShorthand(raw) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(raw);
  if (match === null) throw invalid('The address is neither a Git URL nor an "owner/repo" shorthand.');
  const owner = validateOwner(match[1]);
  const repo = stripGitSuffix(match[2]);
  const folderName = assertSafeFolderName(repo);

  return result({
    kind: 'shorthand',
    host: DEFAULT_HOST,
    owner,
    repo,
    folderName,
    cloneUrl: `https://${DEFAULT_HOST}/${owner}/${repo}`,
  });
}

/**
 * Parse one user-supplied Git address.
 *
 * @param {unknown} input the address as typed in the dialog.
 * @returns {{
 *   kind: 'url' | 'scp' | 'shorthand' | 'file',
 *   host: string,
 *   owner: string,
 *   repo: string,
 *   folderName: string,
 *   cloneUrl: string,
 *   branch: string | null,
 *   subPath: string | null,
 * }} the normalized address; `branch` is only set by `tree`/`blob` URLs.
 * @throws {GitWorkspaceError} with `git-workspace/invalid-url`, `-unsafe-url`,
 *   `-url-too-long`, `-invalid-branch` or `-invalid-folder-name`.
 */
export function parseGitUrl(input) {
  const raw = assertAddressString(input);

  /* A local path is never a Git address here: accepting one would let the
     dialog aim `git clone` at any directory on the machine. Checked before the
     scp-like form, whose `host:` prefix also matches `C:\`. */
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('\\') || raw.startsWith('~') || raw.startsWith('.')) {
    throw invalid('That is a local path, not a Git address.');
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return parseUrlForm(raw);

  const scp = /^(?:([A-Za-z0-9_.-]+)@)?([A-Za-z0-9_.-]+):(.+)$/.exec(raw);
  if (scp !== null && !scp[3].startsWith('//')) return parseScpForm(raw, scp);

  return parseShorthand(raw);
}

/**
 * Non-throwing wrapper for callers that only need to know "usable or not".
 *
 * @param {unknown} input candidate address.
 * @returns {{ ok: true, value: ReturnType<typeof parseGitUrl> } | { ok: false, error: { code: string, message: string } }}
 */
export function tryParseGitUrl(input) {
  try {
    return { ok: true, value: parseGitUrl(input) };
  } catch (error) {
    if (error instanceof GitWorkspaceError) {
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    return { ok: false, error: { code: 'git-workspace/invalid-url', message: 'The address could not be parsed.' } };
  }
}
