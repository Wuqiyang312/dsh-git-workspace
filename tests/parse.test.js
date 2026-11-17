/**
 * `parseGitUrl` truth table. Pure function, no filesystem, no network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { GitWorkspaceError, MAX_URL_LENGTH, assertSafeBranch, assertSafeFolderName, parseGitUrl, tryParseGitUrl } from '../src/parse.js';

/** Assert that a call throws a `GitWorkspaceError` with the given code. */
function rejects(input, code) {
  let caught;
  try {
    parseGitUrl(input);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof GitWorkspaceError, `expected a GitWorkspaceError for ${JSON.stringify(input)}`);
  assert.equal(caught.code, code, `code for ${JSON.stringify(input)}`);
}

test('a plain HTTPS repository URL', () => {
  const parsed = parseGitUrl('https://github.com/o/r');
  assert.deepEqual(
    { kind: parsed.kind, host: parsed.host, owner: parsed.owner, repo: parsed.repo, folderName: parsed.folderName, branch: parsed.branch },
    { kind: 'url', host: 'github.com', owner: 'o', repo: 'r', folderName: 'r', branch: null },
  );
  assert.equal(parsed.cloneUrl, 'https://github.com/o/r');
});

test('a trailing .git is dropped from the folder name but kept in the clone URL', () => {
  const parsed = parseGitUrl('https://github.com/o/r.git');
  assert.equal(parsed.repo, 'r');
  assert.equal(parsed.folderName, 'r');
  assert.equal(parsed.cloneUrl, 'https://github.com/o/r.git');
});

test('a /tree/<branch> link carries the branch and ignores the sub path', () => {
  /* A real public repository, so the fixture is a case anyone can check out:
     `octocat/Hello-World` has a branch literally named `test`. */
  const parsed = parseGitUrl('https://github.com/octocat/Hello-World/tree/test');
  assert.equal(parsed.owner, 'octocat');
  assert.equal(parsed.repo, 'Hello-World');
  assert.equal(parsed.folderName, 'Hello-World');
  assert.equal(parsed.branch, 'test');
  assert.equal(parsed.subPath, null);
  /* The clone URL is the repository, not the tree view. */
  assert.equal(parsed.cloneUrl, 'https://github.com/octocat/Hello-World');
});

test('a /tree/<branch>/<sub path> link records the sub path but still clones the root', () => {
  const parsed = parseGitUrl('https://github.com/o/r/tree/main/firmware/esp32');
  assert.equal(parsed.branch, 'main');
  assert.equal(parsed.subPath, 'firmware/esp32');
  assert.equal(parsed.cloneUrl, 'https://github.com/o/r');
});

test('a /blob/<ref>/<file> link is treated as a branch hint', () => {
  const parsed = parseGitUrl('https://github.com/o/r/blob/main/a/b.ts');
  assert.equal(parsed.branch, 'main');
  assert.equal(parsed.subPath, 'a/b.ts');
  assert.equal(parsed.folderName, 'r');
});

test('other web view links still resolve to their repository', () => {
  for (const [address, folder] of [
    ['https://github.com/o/r/commit/abc123', 'r'],
    ['https://github.com/o/r/issues/7', 'r'],
    ['https://github.com/o/r/', 'r'],
    ['https://github.com/o/r?tab=readme-ov-file', 'r'],
    /* `https://github.com/o/r/releases` used to be here. It is not a view any
       more: a trailing view-page name is indistinguishable from a repository
       name under a nested group, so it is read as `repo = releases`. See the
       "trailing view-page name" test below. */
  ]) {
    const parsed = parseGitUrl(address);
    assert.equal(parsed.folderName, folder, address);
    assert.equal(parsed.cloneUrl, 'https://github.com/o/r', address);
    assert.equal(parsed.branch, null, address);
  }
});

test('a GitLab /-/tree/<branch> copy link resolves to owner/repo/branch', () => {
  /* GitLab's "copy link to branch" is `…/<repo>/-/tree/<branch>`. The lone `-`
     is a separator, not a path segment: without skipping it the last segment is
     `-` and the address fails with `invalid-folder-name`. */
  const parsed = parseGitUrl('https://gitlab.com/group/sub/repo/-/tree/main');
  assert.equal(parsed.kind, 'url');
  assert.equal(parsed.host, 'gitlab.com');
  assert.equal(parsed.owner, 'group/sub');
  assert.equal(parsed.repo, 'repo');
  assert.equal(parsed.folderName, 'repo');
  assert.equal(parsed.branch, 'main');
  assert.equal(parsed.subPath, null);
  assert.equal(parsed.cloneUrl, 'https://gitlab.com/group/sub/repo');
});

test('a GitLab /-/blob/<branch>/<file> copy link keeps the branch and the sub path', () => {
  /* "Copy link to file" has the same separator plus a file path after the ref. */
  const parsed = parseGitUrl('https://gitlab.com/group/sub/repo/-/blob/main/a.ts');
  assert.equal(parsed.owner, 'group/sub');
  assert.equal(parsed.repo, 'repo');
  assert.equal(parsed.folderName, 'repo');
  assert.equal(parsed.branch, 'main');
  assert.equal(parsed.subPath, 'a.ts');
  assert.equal(parsed.cloneUrl, 'https://gitlab.com/group/sub/repo');
});

test('a repository really named "-" is still refused', () => {
  /* The skip rule only applies to a `-` that has segments after it. A trailing
     one stays the repository name, and a folder name cannot start with `-`. */
  rejects('https://gitlab.com/o/-', 'git-workspace/invalid-folder-name');
  rejects('https://gitlab.com/o/-/', 'git-workspace/invalid-folder-name');
});

test('a trailing view-page name under a nested group is read as the repository', () => {
  /* The structural ambiguity: `gitlab.com/group/sub/commit` is either a repo
     `sub/commit` of a group `group`, or the commit view of `group/sub`. Only a
     marker with a segment after it proves a view, so this is a repository —
     deliberately, so that a wrong guess fails inside `git clone` instead of
     cloning a *different* repository silently. */
  const commit = parseGitUrl('https://gitlab.com/group/sub/commit');
  assert.equal(commit.owner, 'group/sub');
  assert.equal(commit.repo, 'commit');
  assert.equal(commit.folderName, 'commit');
  assert.equal(commit.branch, null);
  assert.equal(commit.cloneUrl, 'https://gitlab.com/group/sub/commit');

  const releases = parseGitUrl('https://gitlab.com/group/sub/releases');
  assert.equal(releases.owner, 'group/sub');
  assert.equal(releases.repo, 'releases');
  assert.equal(releases.folderName, 'releases');
  assert.equal(releases.cloneUrl, 'https://gitlab.com/group/sub/releases');

  /* The flat spelling behaves the same way: the last segment is the repository,
     everything before it is the owner. That is why it left the loop above. */
  const flat = parseGitUrl('https://github.com/o/r/releases');
  assert.equal(flat.owner, 'o/r');
  assert.equal(flat.repo, 'releases');
  assert.equal(flat.folderName, 'releases');
});

test('a ref marker with no ref segment is refused, a marker with a segment is a view', () => {
  /* `tree`/`blob` always count as views, even at the end of the path: a
     repository literally named `tree` would otherwise be guessed, and a view
     without a ref cannot be cloned. Both readings are refused instead. */
  rejects('https://github.com/o/r/tree', 'git-workspace/invalid-url');
  rejects('https://github.com/o/r/blob', 'git-workspace/invalid-url');

  /* The same marker *with* a segment after it is an ordinary view. */
  const commit = parseGitUrl('https://github.com/o/r/commit/abc123');
  assert.equal(commit.owner, 'o');
  assert.equal(commit.repo, 'r');
  assert.equal(commit.folderName, 'r');
  assert.equal(commit.cloneUrl, 'https://github.com/o/r');
});

test('the scp-like form keeps its spelling for git', () => {
  const parsed = parseGitUrl('git@github.com:o/r.git');
  assert.equal(parsed.kind, 'scp');
  assert.equal(parsed.host, 'github.com');
  assert.equal(parsed.owner, 'o');
  assert.equal(parsed.folderName, 'r');
  assert.equal(parsed.cloneUrl, 'git@github.com:o/r.git');
});

test('the owner/repo shorthand expands to GitHub', () => {
  const parsed = parseGitUrl('o/r');
  assert.equal(parsed.kind, 'shorthand');
  assert.equal(parsed.cloneUrl, 'https://github.com/o/r');
  assert.equal(parsed.folderName, 'r');
});

test('an ssh:// URL keeps its port and user', () => {
  const parsed = parseGitUrl('ssh://git@example.com:2222/team/sub/repo.git');
  assert.equal(parsed.host, 'example.com');
  assert.equal(parsed.owner, 'team/sub');
  assert.equal(parsed.folderName, 'repo');
  assert.equal(parsed.cloneUrl, 'ssh://git@example.com:2222/team/sub/repo.git');
});

test('a file:// URL points at a local repository', () => {
  const parsed = parseGitUrl('file:///C:/tmp/repo.git');
  assert.equal(parsed.kind, 'file');
  assert.equal(parsed.folderName, 'repo');
  assert.equal(parsed.cloneUrl, 'file:///C:/tmp/repo.git');
});

test('an empty address is rejected', () => {
  rejects('', 'git-workspace/invalid-url');
  rejects('   ', 'git-workspace/invalid-url');
  rejects(undefined, 'git-workspace/invalid-url');
  rejects(null, 'git-workspace/invalid-url');
  rejects(42, 'git-workspace/invalid-url');
});

test('an option-looking address is rejected before git ever sees it', () => {
  rejects('-u', 'git-workspace/unsafe-url');
  rejects('--upload-pack=calc', 'git-workspace/unsafe-url');
  rejects('  -oProxyCommand=x', 'git-workspace/unsafe-url');
});

test('NUL anywhere is rejected', () => {
  rejects('https://github.com/o/r\u0000', 'git-workspace/unsafe-url');
  rejects('o\u0000/r', 'git-workspace/unsafe-url');
});

test('an over-long address is rejected', () => {
  rejects(`https://github.com/o/${'r'.repeat(MAX_URL_LENGTH)}`, 'git-workspace/url-too-long');
});

test('a bare host has no repository', () => {
  rejects('https://github.com', 'git-workspace/invalid-url');
  rejects('https://github.com/onlyowner', 'git-workspace/invalid-url');
  rejects('https://github.com/o/r/tree', 'git-workspace/invalid-url');
});

test('local path spellings are rejected', () => {
  rejects('C:\\Users\\someone\\repo', 'git-workspace/invalid-url');
  rejects('/home/someone/repo', 'git-workspace/invalid-url');
  rejects('./repo', 'git-workspace/invalid-url');
  rejects('~/repo', 'git-workspace/invalid-url');
});

test('unsupported protocols are rejected', () => {
  rejects('ftp://github.com/o/r', 'git-workspace/unsafe-url');
  rejects('javascript://github.com/o/r', 'git-workspace/unsafe-url');
});

test('tryParseGitUrl never throws', () => {
  assert.deepEqual(tryParseGitUrl('o/r').ok, true);
  const failed = tryParseGitUrl('-u');
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'git-workspace/unsafe-url');
});

test('folder names are a single safe segment', () => {
  assert.equal(assertSafeFolderName('hello-world_2.0'), 'hello-world_2.0');
  assert.equal(assertSafeFolderName('my repo'), 'my repo');
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', '-rf', '.hidden', '.git-workspace-x', 'con', 'name.', 'a:b', 'a*b']) {
    assert.throws(() => assertSafeFolderName(bad), /GitWorkspaceError|folder name/, `expected ${bad} to be rejected`);
  }
});

test('branch names are safe argv tokens', () => {
  assert.equal(assertSafeBranch('octocat-patch-1'), 'octocat-patch-1');
  assert.equal(assertSafeBranch('feature/foo-1'), 'feature/foo-1');
  for (const bad of ['', '-f', 'a b', 'a\u0000b', 'a..b', 'a@{b}', 'a//b', 'main.lock']) {
    assert.throws(() => assertSafeBranch(bad), /branch/, `expected ${bad} to be rejected`);
  }
});
