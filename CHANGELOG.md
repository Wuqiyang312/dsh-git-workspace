# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-17

First public release.

### Added

- **「添加 Git 工作区」按钮**：出现在新建会话那一行、工作区选择器右侧（`conversation.hero.options` slot，`order: 100`），点击打开对话框。
- **对话框**：Git 地址 / 存放父目录（带宿主目录选择器）/ 文件夹名 / 分支 / 浅克隆开关；地址解析成功后自动预填分支与文件夹名，用户手改过的字段不再被覆盖。
- **Host 三条路由**：`GET /api/git-workspace/defaults`、`POST /api/git-workspace/parse`、`POST /api/git-workspace/clone`，经 `ctx.connection.fetch.register` 注册。
- **地址解析**：HTTPS、SSH（`ssh://` 与 scp 风格）、`file://`、`owner/repo` 简写；`/tree/<branch>`、`/blob/<ref>/<path>`、GitLab `/-/tree/<branch>` 与 `/-/blob/...` 复制链接都只取仓库根 + 分支。
- **克隆管线**：staging 目录 + `rename` 落盘、`workspaceRegistry.create()` 登记、成功后自动 `startSession` 进入新会话。
- **配置项**：`cloneRoot`、`gitCommand`、`timeoutMs`、`maxOutputBytes`、`shallow`、`depth`、`maxBodyBytes`，全部在 `apply()` 做运行时校验。
- **73 条测试**：URL 解析真值表、真实本地仓库克隆、路由、Client 注册结构、动态 ctx guard、CSS 规则与括号平衡、遮罩 token、超时措辞与进程树回退、对话框旧响应竞态。

### Security

- 从不拼接 shell：`spawn(gitCommand, argv)` + `shell: false`，URL 与目标路径各自成一个 argv 元素。
- 地址与分支名有白名单式校验（协议白名单、不得以 `-` 开头、不含 NUL/空白/ref 元字符）；目标目录必须是绝对路径下的单段文件夹名，且**已存在就报错，绝不覆盖或删除**。
- 克隆时关闭凭据交互（`GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=echo`、`GCM_INTERACTIVE=never`），没有终端可用时直接失败而不是挂住。

### Known limitations

- 克隆中途关闭对话框不会中止 Host 端的 git 进程（会在超时后自行结束）；关闭只会作废正在飞的响应。
- 分支名里带 `/` 时，`/tree/feature/x` 只会取到 `feature`，需要在「分支」字段里填完整名字。
- `/tree/<branch>/<sub path>` 只克隆仓库根，子目录不作为工作区根。

[0.1.0]: https://github.com/Wuqiyang312/dsh-git-workspace/releases/tag/v0.1.0
