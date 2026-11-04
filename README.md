# dsh-archived-purge

**DSH 归档会话清理：全选删除归档会话，连同本地文件一起清干净。**

[中文](#中文) · [English](#english)

DSH 自带的「归档」只是把会话从侧边栏隐藏，磁盘上的日志、投影缓存、工作区记账都还在，而且没有批量删除入口。这个插件在 **设置 → 归档清理** 里补上一页：按工作区分组列出全部归档会话，支持全选 / 逐条勾选，一次永久删除选中的会话及其本地存储。

## 功能

- **一眼看清**：按工作区分组，显示标题、最后活动时间、占用体积；日志已丢失的会话单独标记。
- **全选 / 多选**：顶部全选，逐行勾选，实时显示已选条数与总体积。
- **永久删除**：一次清掉四类本地痕迹
  - 会话日志目录 `<DSH_HOME>/sessions/--<cwd>--/<session-id>/`
  - 投影缓存行 `<DSH_HOME>/storages/session_projcache/sessions/<session-id>.json`
  - 工作区记账（公开 API `Workspace.detachSession`）
  - 全局归档集合（`workspaceRegistry.unarchiveSession`）
- **子代理级联**：仅删除 `origin: 'subagent'` 且挂在被删会话下的子会话日志；普通 fork 出来的会话不受影响。
- **安全护栏**：运行中的会话直接拒绝；`sessionId` 白名单正则；删除路径必须落在 `sessions/` 与投影缓存根内；POST 校验同源；删除前二次确认并显示条数与体积。

## 安装

```sh
dsh plugin --profile desktop add github:5D-artist/dsh-archived-purge
```

Desktop 也可以在 **设置 → 插件 → 添加插件** 里填仓库地址：

```
https://github.com/5D-artist/dsh-archived-purge
```

装好后刷新页面（Host 端通常已热加载，浏览器端 bundle 需要重新加载）。

## 使用

1. 打开 **设置 → 归档清理**。
2. 点「全选」，或逐条勾选。
3. 点「删除所选」→ 确认。

删除不可撤销，列表不会自动清理任何东西 —— 只有确认后的选中项才会被删。

## 删除范围

| 项目 | 是否删除 | 说明 |
|---|---|---|
| 会话日志目录 | ✅ | `session.vN.jsonl*` 整个会话目录 |
| 投影缓存行 | ✅ | 单会话 JSON，删除后按需重建 |
| 工作区记账 | ✅ | 走 `Workspace.detachSession`，不手改 `workspace.json` |
| 归档集合 | ✅ | 走 `unarchiveSession`，不手改注册表 |
| subagent 子会话日志 | ✅ | 仅 `origin: 'subagent'` 的后代 |
| 附件（`attachments/`） | ❌ | 内容寻址、可能被多个会话共享 |
| 工作区目录 / 文件 | ❌ | 只删会话存储 |
| fork 出来的普通会话 | ❌ | 只按 subagent 血缘级联 |

## 安全设计

- **运行中拒绝**：`ctx.sessions` / `ctx.agents` 里还活着的会话不会被删。
- **入口校验**：`sessionId` 必须匹配 `^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$`；请求必须同源、`application/json`、体大小受限。
- **路径边界**：待删路径必须 `path.relative` 落在 `sessions/` 或投影缓存根内。
- **不重写注册表**：归档集合与工作区记账都通过公开 service 方法修改，避免与运行中的注册表写入竞争。

## 兼容性

- 实测：**DSH 0.2.1-rc.5**（Desktop，Windows）。
- 需要 Host 服务：`webServer`、`workspaceRegistry`、`sessions`、`sessionPersistence`。
- 存储布局：0.2.x 的 v4 会话日志、`workspace.json` schema v2、`session_projcache` 单记录文件。
- 仅 Web 客户端（`dsh.client.platform = web`）。

## Host 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/plugins/archived-purge/state` | 归档列表（标题、工作区、体积、最后活动、是否存在、是否运行中） |
| POST | `/plugins/archived-purge/delete` | `{ "sessionIds": [...] }` 永久删除 |
| POST | `/plugins/archived-purge/client-error` | 客户端挂载失败上报，写入 `<DSH_HOME>/archived-purge-client-errors.log` |

## 开发

```sh
node --test test/host.test.mjs
```

测试在临时目录构造完整存储结构，覆盖列表、删除、运行中拒绝、非法 ID、记账已从投影消失、subagent 级联，不触碰真实数据。

```
index.js            Host 半：列表 / 删除 / 路由 / 边界校验
client.js           Client 半：设置页、全选、确认弹窗
cordis.patch.yml    bundle patch
locale/{zh,en}.json 插件市场展示元数据
test/host.test.mjs  Host 单测
```

## 已知限制

- 只能删除归档集合中的会话；活动会话请先归档。
- 附件不随会话清理（内容寻址，可能共享）。
- 归档时间不是 DSH 的持久字段，列表用最后活动时间排序。

## License

[MIT](LICENSE) © 2026 5D-artist

---

# English

**Select-all cleanup for archived DeepSeek Harness sessions: delete the session log, projection cache, workspace accounting and archive marker together.**

DSH's built-in archive only hides a session from the sidebar; its log, projection cache and workspace accounting stay on disk, and there is no bulk delete. This plugin adds **Settings → Archive Cleanup**: every archived session grouped by workspace, with select-all / per-row selection and one permanent delete for the selection.

## Features

- Grouped by workspace with title, last activity and size; rows whose log is already gone are marked.
- Select all or individual rows, with live count and total size.
- Permanent deletion of the session log directory, the projection-cache row, the workspace accounting slot (`Workspace.detachSession`) and the archive-set entry (`workspaceRegistry.unarchiveSession`).
- Cascades only `origin: 'subagent'` descendants; ordinary forks are left alone.
- Guards: live sessions are refused, ids are allow-listed, every path must stay inside the session/cache roots, POSTs are same-origin, and deletion needs an explicit confirmation.

## Install

```sh
dsh plugin --profile desktop add github:5D-artist/dsh-archived-purge
```

Or use **Settings → Plugins → Add plugin** with `https://github.com/5D-artist/dsh-archived-purge`.

## Usage

Settings → Archive Cleanup → select all → Delete selected → confirm. Nothing is deleted before that confirmation.

## Safety

Live sessions are refused. Attachments are never touched (content-addressed and possibly shared). The workspace registry is never rewritten by hand; archive and accounting go through public service methods.

## Compatibility

Tested on DSH 0.2.1-rc.5 (Desktop, Windows). Requires `webServer`, `workspaceRegistry`, `sessions` and `sessionPersistence`; targets the 0.2.x v4 session layout and workspace schema v2.

## License

MIT © 2026 5D-artist
