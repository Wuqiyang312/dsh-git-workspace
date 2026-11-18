# dsh-git-workspace

[![npm version](https://img.shields.io/npm/v/@wuqiyang312/dsh-git-workspace?color=blue&label=npm)](https://www.npmjs.com/package/@wuqiyang312/dsh-git-workspace)
[![npm downloads](https://img.shields.io/npm/dw/@wuqiyang312/dsh-git-workspace)](https://www.npmjs.com/package/@wuqiyang312/dsh-git-workspace)
[![test](https://github.com/Wuqiyang312/dsh-git-workspace/actions/workflows/test.yml/badge.svg)](https://github.com/Wuqiyang312/dsh-git-workspace/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**从 Git 地址直接开一个工作区。** 在 DeepSeek Harness 新建会话那一行，粘贴仓库地址，Host 端克隆到本地、登记为工作区，并自动切到该仓库的新会话。

> DeepSeek Harness（DSH）插件 · Cordis bundle · MIT · 无 npm 运行时依赖
>
> A DeepSeek Harness plugin: paste a Git address, get a cloned repository registered as a workspace with a fresh session in it.
>
> `npm i @wuqiyang312/dsh-git-workspace`

---

## 它解决什么

DSH 的工作区需要先有一个本地目录。想拿一个 GitHub/GitLab 仓库开工，标准流程是：手动 `git clone` → 回设置里添加工件区 → 新建会话。这个插件把它压成一步：

```
新建会话 → 点「添加 Git 工作区」→ 粘贴 https://github.com/octocat/Spoon-Knife/tree/main → 克隆并打开
```

地址里的分支信息会被识别（`/tree/<branch>`、`/blob/<ref>/<path>`、GitLab 的 `/-/tree/<branch>`），解析成功后自动预填「分支」与「文件夹名」，也可以手改。

## 安装

### 从 npm（推荐）

```bash
npm i @wuqiyang312/dsh-git-workspace
```

装完把包名加进 profile 的 `dsh.profile.bundles`，DSH 启动时会读它自带的 `cordis.patch.yml`：

```jsonc
{
  "dsh": { "profile": { "bundles": ["...", "@wuqiyang312/dsh-git-workspace"] } },
  "dependencies": { "@wuqiyang312/dsh-git-workspace": "^0.1.0" }
}
```

### 用 DSH 的 plugin_manager

`plugin_manager` 的 `install_bundle` 既可以给 npm spec，也可以给本地目录：

```
plugin_manager({ action: "install_bundle", target: "@wuqiyang312/dsh-git-workspace" })
plugin_manager({ action: "install_bundle", target: "/absolute/path/to/dsh-git-workspace" })
```

它会把包装进 profile、把 `cordis.patch.yml` 合并进 profile 的 patch 层。

### 从源码（开发）

```bash
git clone https://github.com/Wuqiyang312/dsh-git-workspace.git
```

然后按上面的本地目录方式安装；profile 里会写成 `"link:/absolute/path"`，改源码即时生效。

**装完都要刷新页面**——Client half 会被 Renderer 缓存，不刷新看不到按钮。

## 配置

`cordis.patch.yml` 给出默认值，装完后可在 profile 的 patch 层按 `id: git-workspace` 覆盖：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `cloneRoot` | `''` | 克隆根目录。空字符串表示**自动推断**：`<dirname(workingDirectory.defaultDirectory)>/repos`。非空时必须是绝对路径，相对路径会被忽略并打一条警告。 |
| `gitCommand` | `'git'` | git 可执行文件。只按 argv 调用；含空白的值会被拒绝（那只能靠 shell 才「能用」，而本插件从不使用 shell）。 |
| `timeoutMs` | `600000` | 单次克隆的墙钟上限。超时后**请求**停止（Windows 走 `taskkill /T /F`，被拒绝则回退 `child.kill('SIGKILL')`），并等待退出的**证据**；5 秒内未确认退出就如实报告「已请求停止、进程可能仍在运行」。上限 1 小时。 |
| `maxOutputBytes` | `65536` | 保留 git stdout/stderr 尾部的字节上限；错误信息里带的就是这段尾部，超出部分标注 `… (output truncated)`。上限 4 MiB。 |
| `shallow` | `false` | 对话框里浅克隆开关的初始值。 |
| `depth` | `1` | 浅克隆的深度。 |
| `maxBodyBytes` | `65536` | `POST /api/git-workspace/*` 的请求体上限，超过返回 413。 |

配置在 `apply()` 时做**运行时校验**（没有导出 `Config`，因此不依赖 schemastery）：非法值不会让插件加载失败，而是打一条 `[git-workspace] …` 警告并使用默认值。

## 支持的 Git 地址

| 形态 | 例子 |
| --- | --- |
| HTTPS | `https://github.com/o/r`、`https://github.com/o/r.git` |
| HTTPS 带分支/文件路径 | `https://github.com/o/r/tree/dev`、`https://github.com/o/r/tree/main/firmware/esp32`、`https://github.com/o/r/blob/main/a/b.ts` |
| GitLab 复制链接（`/-/` 分隔符） | `https://gitlab.com/group/sub/repo/-/tree/main`、`https://gitlab.com/group/sub/repo/-/blob/main/a.ts` |
| SSH（URL） | `ssh://git@example.com:2222/team/sub/repo.git` |
| SSH（scp 风格） | `git@github.com:o/r.git` |
| `file://` | `file:///C:/mirrors/repo.git`（离线镜像） |
| 简写 | `o/r` → `https://github.com/o/r` |

`/tree/<ref>` 与 `/blob/<ref>/<path>` 只取**分支**信息：工作区永远指向仓库根，子目录不作为工作区根。`tree`/`blob` 之后的第一段就是分支名，所以**分支名本身带 `/` 时**（如 `feature/x`）会被截成 `feature`；这种情况请直接在「分支」字段里填完整名字。

从 `owner/repo` 之后的第三段起，这些网页视图段才可能被当作视图标记：`tree` `blob` `commit` `commits` `blame` `raw` `issues` `pull` `pulls` `actions` `releases` `tags` `branches` `compare` `wiki` `discussions` `settings` `projects` `graphs` `network` `edit` `find` `archive`。

当前规则（两层）：

1. **`tree` / `blob` 后面必须有 ref 段**：`https://github.com/o/r/tree/main` 解析成仓库 `o/r`、分支 `main`；而 `https://github.com/o/r/tree`（结尾没有 ref）直接报 `git-workspace/invalid-url`，不去猜它是「没有 ref 的视图」还是「叫 tree 的仓库」——两种猜法都可能错，这种情况请直接填字段。
2. **其他标记必须有后续段才算视图**：`/commit/abc123`、`/issues/12`、`/compare/a...b` 会解析成仓库本身；**结尾的单段视图页**（`/releases`、`/issues`、`/commit` …）**与嵌套 group 下的仓库同名时按仓库名处理**。

第 2 条是结构上无法消歧的：`https://gitlab.com/group/sub/commit` 既可以是 `group` 组里 `sub` 的 `commit` 视图，也可以是 group `group/sub` 下叫 `commit` 的仓库。本插件选择后者——`owner=group/sub`、`repo=commit`、`folderName=commit`。理由是：宁可让 `git clone` 因为仓库不存在而**报错**（用户看到 git 自己的错误信息后改填空格），也不要在没有任何提示的情况下克隆了一个**不同的仓库**。同理 `https://gitlab.com/group/sub/releases` → `owner=group/sub`、`repo=releases`；`https://github.com/o/r/releases` → `owner=o/r`、`repo=releases`。

仓库名本身叫 `commit`、`issues` 等也不受影响——这些段只在第三段之后才生效。

**GitLab 的 `/-/` 分隔符**：GitLab「复制文件链接 / 复制分支链接」给出的地址形如 `…/<repo>/-/tree/<branch>` 与 `…/<repo>/-/blob/<branch>/<file>`，其中单独一段 `-` 不是仓库路径的一部分（`git clone` 也不会接受它），所以扫描视图标记时跳过「后面还有段的单段 `-`」：`https://gitlab.com/group/sub/repo/-/tree/main` → `owner=group/sub`、`repo=repo`、`branch=main`；`…/-/blob/main/a.ts` → 同上并带 `subPath=a.ts`。结尾的 `-` 不跳过：`https://gitlab.com/o/-` 仍然是仓库名 `-`，由文件夹名校验报 `invalid-folder-name`。其余规则不变——`https://gitlab.com/group/sub/commit`（没有 `/-/`）依然是 `owner=group/sub`、`repo=commit`。

## Host 接口

前缀 `/api/git-workspace`，通过 `ctx.connection.fetch.register` 注册（同源、经 Connection 的 Host/Origin 与浏览器鉴权检查），不使用本插件自己的 web server。

| 端点 | 说明 |
| --- | --- |
| `GET /defaults`（也接受 HEAD） | `{ ok: true, value: { parentDirectory, separator, platform, shallow, configured } }`，必要时 `mkdir -p`。 |
| `POST /parse` | body `{ url }` → `{ ok: true, value: parseGitUrl(url) }`。 |
| `POST /clone` | body `{ url, branch?, parentDirectory?, folderName?, depth?, shallow? }` → 成功 `{ ok: true, value: { workspace: { workspaceId, path, title }, branch, folderName, clonedPath } }`；失败 `{ ok: false, error: { code, message } }`。 |

失败一律带**稳定 code**，由前端本地化（`error.<code>`，en/zh 两套都齐）：

`git-workspace/invalid-url`、`unsafe-url`、`url-too-long`、`invalid-branch`、`invalid-folder-name`、`invalid-parent-directory`、`invalid-json`、`body-too-large`、`missing-url`、`target-exists`、`target-check-failed`、`clone-busy`、`clone-timeout`、`clone-failed`、`spawn-failed`、`move-failed`、`register-failed`、`no-workspace-registry`、`no-clone-root`、`clone-root-failed`、`network`（前端专用）。

## 安全与健壮性

- **不做 shell 拼接**：只用 `spawn(gitCommand, argv)`，`shell: false`；URL 与目标路径各自是一个 argv 元素，`--` 结尾选项解析。
- `git` 运行时带 `GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=echo`、`GCM_INTERACTIVE=never`，`windowsHide: true`；没有终端可用，凭据提示直接失败而不是挂住。
- **参数注入面**：地址不得以 `-` 开头、不得含 NUL、长度 ≤ 2048；协议白名单 `http/https/ssh/git/file`；分支名不得以 `-` 开头、不含空白与 ref 元字符。本地裸路径（`C:\x`、`/x`、`./x`、`~/x`）被拒绝——只有显式的 `file://` URL 才算地址。
- **目标目录**：`parentDirectory` 必须是绝对路径（可创建）；`folderName` 必须是单段目录名（不含 `/` `\`、不是 `.`/`..`、不以 `.` 开头、不是 Windows 保留名），并再校验一次 `path.dirname(dest) === parent`。
- **目标已存在 → 报错，绝不覆盖、绝不删除。**
- **staging + rename**：先克隆到父目录下的 `.git-workspace-<uuid>`，成功后才 `rename` 到目标；失败/超时/移动失败都会删掉 staging，**删除失败会写进 `message`**（同时记一条 `[git-workspace] staging cleanup failed` 警告），因为残留目录是结果的一部分，不能只写在日志里。
- **超时**：到期后先**请求**停止（Windows `taskkill /pid <pid> /T /F`，被拒绝或启动失败则回退 `child.kill('SIGKILL')`），然后等**退出的证据**（子进程的 `exit`/`close` 事件），最多再等 5 秒。停止只是「请求」：在 Windows 上实测 `taskkill /T /F` 对子进程会以 code 1（Access denied）退出、子进程继续活着，所以命令的退出码会被观察并触发回退信号。**没观察到退出就不声称已停止**——此时错误信息是「A stop was requested … may still be running」，同时仍会尝试删掉 staging（删除失败同样写进 `message`）。超时时长按秒显示，保留一位小数（`timeoutMs: 1200` → `within 1.2s`，`600000` → `within 600s`）。
- **输出上限**真的生效：git 的 stdout/stderr 重定向到两个临时文件（不是管道），事后只按 `maxOutputBytes` 读**尾部**，所以再吵的克隆也不会把输出全读进内存。用文件而不是管道还有两个好处：Windows 上管道是一对命名管道，某些沙箱直接禁止；也不需要在运行中持续 drain 以避免死锁。
- **请求体**上限 64 KiB，非法 JSON 返回 400（不是崩），非对象 body 也是 400。
- **并发**：同一个目标目录用 in-flight `Set` 挡住第二个请求（`clone-busy`），不会互相踩 rename。
- 一切失败都把 git stderr 的尾部带回 `message`（受 `maxOutputBytes` 限制），所以对话框里能看到真正的原因。

## 已知限制

- **不代管凭据**：私有仓库依赖本机已有的 SSH agent / credential helper；需要交互输入的克隆一定失败（并如实报错）。
- **不解析分支名里的 `/`**：见上文 `tree`/`blob` 的说明。
- **子目录不是工作区**：`/tree/dev/firmware` 这种地址只克隆仓库根。
- **没有取消按钮**：克隆中途关闭对话框不会中止 Host 端的 git 进程；它会在超时后自行结束。关闭本身是允许的（Esc、点遮罩、右上角 ×、取消），但**关闭会立刻作废正在飞的克隆请求**：对话框用 `submitSeq` 令牌判定「这个响应还属于当前这次打开吗」，关闭 / 重新打开 / 再次提交都会让令牌 +1。旧响应到达时既不 `setBusy`、也不关对话框、更不会 `startSession` 把用户带走；下次打开会显示一条提示，说明上次克隆仍在 Host 端继续。之所以需要令牌：对话框关闭时只是 `return null`，组件并没有卸载，`disposed` 分辨不出「关了又开」。
- **不会自动删除**：克隆成功但登记失败（例如 profile 没有 `workspaceRegistry`）时，目录留在磁盘上——删掉用户的仓库是更糟的结果。
- `cloneRoot` 不做「必须在某个白名单目录下」的限制：对话框本来就允许改父目录，真正的防线是「绝对路径 + 单段文件夹名 + 不覆盖」。
- **UI 验证到什么程度**：已在 Windows 桌面端安装并实际打开过——按钮确实出现在新建会话那一行、在「选择工作区」右侧，点开后对话框正常渲染，遮罩踩过的颜色 bug 也是这样发现的（见下一条）。**仍未验证**：其他分辨率/缩放下的对齐、浅色主题下的观感、焦点陷阱在真实键盘操作下的表现、`shell.overlay` 容器若加 `transform`/`overflow:hidden` 时的表现。
- **样式取自 token**：按钮与对话框所有颜色都来自 `--dsw-alias-*`；主按钮用 brand 色作文本与描边、`bg-layer-2` 作底，而不是整块 brand 填充——因为可用于文字的 token 只有 label 系列，遇到自定义 brand 色时纯色填充的对比度没有保证。
- **`shell.overlay` 的定位**：对话框自己画的是 `position:fixed; inset:0` 的遮罩，假定宿主把该 slot 渲染在一个不裁剪的浮层容器里；若宿主给该容器加了 `transform` 或 `overflow:hidden`，遮罩会被限制在容器内——这一点未在真实页面验证。
- **遮罩用 mask 而不是 overlay token**：`.dshgw-backdrop` 的背景是 `--dsw-alias-bg-mask-1` + `--dsw-mask-blur`（与 `ui-settings-general` 的 Modal、`ui-layout` 的抽屉遮罩同一套），**不是** `--dsw-alias-bg-overlay`。后者是「面板」底色——light 是 `rgb(233,236,242)`、dark 是 `rgb(97,102,107)`，都不透明；铺到 `inset:0` 上会把整个界面刷成一块灰板，而不是压暗背景。第一版就是踩了这个坑（截图上遮罩呈灰白色），已在真实界面复现并修正，`tests/client.test.js` 有一条守护测试：`.dshgw-backdrop` 必须引用 `--dsw-alias-bg-mask-1`、必须带 `backdrop-filter:var(--dsw-mask-blur…)`、且不得出现 `--dsw-alias-bg-overlay`。
- **样式注入是 `<style>` 兜底**：仓库里没有任何 `provide('styles')`；动态 Client half 的 `styles` 是 `factory` 求值时传入的闭包参数（见 `cordis-refs/pkg/client-runner/lib/client.js` 的 `evaluateClientHalf`），而本插件的 `factory(require)` 只拿到 `require`，所以 `ctx.get('styles')` 当前取不到注册器，实际走的是插一个带 `data-dsh-git-workspace` 的 `<style>`。代码保留了「若将来宿主以服务形式提供 `styles.insert(css)` 则复用（返回值不是 disposer 时退化为 no-op）」的分支；两条路径都由 `ctx.effect` 释放。注意只能用 `ctx.get('styles')`，写成 `ctx.styles` 会被动态上下文的 guard proxy 拒绝（`dynamic ctx does not expose "styles"`），`tests/client.test.js` 用模拟 guard 的 Proxy 守着这一点。

## 文件

| 文件 | 作用 |
| --- | --- |
| `package.json` | bundle 清单：`exports`、`files`、`dsh.bundle.patch`、`dsh.client`。无 npm 依赖。 |
| `cordis.patch.yml` | `- insert:` 一行 `id: git-workspace` 与默认配置。 |
| `index.js` | Host 半：`apply()`、`inject`、配置校验、三条路由、`createHandlers()`（可单独测试）。 |
| `src/parse.js` | `parseGitUrl()` 等纯函数（无 IO）。 |
| `src/clone.js` | `planClone()`（纯）+ `cloneRepository()`（文件系统与子进程）。 |
| `client.js` | 浏览器半：按钮、对话框、locale、样式。 |
| `locale/en.json`、`locale/zh.json` | 插件管理页的 `meta.title` / `meta.description`。 |
| `icon.svg` | 24×24、`currentColor` 的原创图标。 |
| `tests/*.test.js` | `node --test` 测试（当前 73 条）：URL 解析（含 GitLab `/-/` 复制链接）、真实本地仓库克隆、路由、Client 注册结构、动态 ctx guard、必需 CSS 规则、CSS 括号平衡、遮罩必须用 mask token（不是面板底色）、超时措辞/进程树回退、对话框旧响应竞态。 |

## 测试

```bash
npm test          # 等价于 node --test（Node 20+ 自动发现 tests/*.test.js）
npm run check     # 只做 node --check 语法检查
```

如果在受限沙箱里默认的 per-file 子进程隔离起不来（`spawn EPERM`——Windows 上带管道的子进程是一对命名管道，某些沙箱直接禁止），换用 `npm run test:no-isolation`：它在同一个进程里跑完所有文件，需要 Node 22+（`--experimental-test-isolation=none` 在 Node 20 上是 `bad option`）。

测试**不联网、不碰用户仓库**：源仓库是在 `os.tmpdir()` 下用 `git init` + 一次提交现建的，克隆目标也在同一临时目录，测试结束自行清理。断言里比较文件内容时会把 CRLF 归一成 LF——克隆会继承机器的 `core.autocrlf`，GitHub 的 Windows runner 上是 `true`，这是 runner 的事、不是插件的事。

CI 在 `.github/workflows/test.yml`：ubuntu + windows × Node 20 + 22，跑 `npm run check` 和 `npm test`。

## npm 包里有什么

`files` 只发布运行所需的东西：`index.js`、`client.js`、`src/*.js`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`、`README.md`、`LICENSE`（约 40 KB tarball / 125 KB 解包，11 个文件）。`tests/`、`.github/`、`CHANGELOG.md` 留在仓库里不发布。

```bash
npm pack --dry-run    # 发布前看一眼清单
```

## 发布（维护者）

```bash
npm version patch|minor|major   # 改 package.json 与 tag
git push --follow-tags
npm publish                     # 需要 @wuqiyang312 scope 的 package:write token
gh release create v<版本> --notes-file <(sed -n '/^## \[<版本>\]/,$p' CHANGELOG.md)
```

`CHANGELOG.md` 是发布说明的来源，发版前先写它。

## 许可

[MIT](LICENSE) © 2026 Wuqiyang312
