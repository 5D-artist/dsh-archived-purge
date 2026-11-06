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
- **安全护栏**：仍在运行工作的会话拒绝删除（按 `workspace/session-activity` 判定，不是「在内存里就算运行中」）；`sessionId` 白名单正则；删除路径必须落在 `sessions/` 与投影缓存根内；POST 校验同源；删除前二次确认并显示条数与体积。
- **失败可读**：被拒绝或失败时逐条列出会话与原因，不再只弹一句 `HTTP 400`。

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

- **运行中拒绝，但「在内存里」不等于运行中**：归档只是把会话从侧边栏隐藏，并不会销毁它 —— 最近用过的归档会话仍然驻留在 `ctx.sessions` 里。旧版把「存在」当成「运行中」，于是任何还热着的归档会话都删不掉，页面只显示 `部分删除失败: 0 / 4 · HTTP 400`。现在改为询问 Host 的 `workspace/session-activity` 瀑布（Agent 的 `turn`、任务注册表、子代理运行时、定时任务都会在这里应答，`archiveSession` 用的是同一道闸），只有真的有活要干时才拒绝，并说明是哪一类工作。
- **整批前置检查**：删除前先一次性检查这一批（含 subagent 后代），只要有一个还在跑就整批不动，不会出现「一半删了、一半留着」的残局。
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
| GET | `/plugins/archived-purge/state` | 归档列表（标题、工作区、体积、最后活动、是否存在、`active` / `activity` / `resident`） |
| POST | `/plugins/archived-purge/delete` | `{ "sessionIds": [...] }` 永久删除；请求本身合法时恒返回 200，`ok` / `code` / `message` / `results` 描述结果 |
| POST | `/plugins/archived-purge/client-error` | 客户端挂载失败上报，写入 `<DSH_HOME>/archived-purge-client-errors.log` |

删除接口的状态码约定：`400` 只用于请求体不是合法 JSON，`403` 只用于跨源，`405` / `415` 用于方法与 Content-Type；「没删成」属于业务结果，用 200 + `ok: false` + `message` 表达，页面据此逐条列出原因。

## 更新日志

### 1.0.1

- 修复 **归档会话永远删不掉、只报 `部分删除失败: 0 / 4 · HTTP 400`**：运行判定从「`ctx.sessions.get` 里还有没有」改为 `workspace/session-activity` 瀑布，驻留内存但空闲的归档会话现在可以正常删除。
- 删除改为**整批前置检查**：任一目标（含 subagent 后代）仍在运行则整批不删，并列出是哪一类工作（对话 / 任务 / 子代理 / 定时任务）。
- 删除接口不再用 `400` 表达业务失败，页面逐条显示失败会话与原因；列表不再把驻留会话标成「运行中」，状态取不到时标「运行状态未知」。
- 新增 `test/http.test.mjs`：直接驱动路由处理函数，锁定「驻留但空闲 → 200 且删除成功」「仍在运行 → 200 + 可读原因」两条契约。

## 开发

```sh
node --test test/host.test.mjs test/http.test.mjs
```

`test/host.test.mjs` 在临时目录构造完整存储结构，覆盖列表、删除、运行中拒绝、驻留但空闲（回归）、整批前置检查、非法 ID、记账已从投影消失、subagent 级联，不触碰真实数据；`test/http.test.mjs` 用假的 `ctx` 驱动真实路由，锁定状态码与响应体契约。

```
index.js            Host 半：列表 / 删除 / 路由 / 边界校验
client.js           Client 半：设置页、全选、确认弹窗
cordis.patch.yml    bundle patch
locale/{zh,en}.json 插件市场展示元数据
test/host.test.mjs  Host 单测
test/http.test.mjs  路由 / 响应体集成测试
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
- Guards: a Session that still reports work is refused (decided by `workspace/session-activity`, not by "it is still in memory"), ids are allow-listed, every path must stay inside the session/cache roots, POSTs are same-origin, and deletion needs an explicit confirmation.
- Readable failures: a refused or failed delete lists each Session with its reason instead of a bare `HTTP 400`.

## Install

```sh
dsh plugin --profile desktop add github:5D-artist/dsh-archived-purge
```

Or use **Settings → Plugins → Add plugin** with `https://github.com/5D-artist/dsh-archived-purge`.

## Usage

Settings → Archive Cleanup → select all → Delete selected → confirm. Nothing is deleted before that confirmation.

## Safety

Archiving hides a Session without disposing it, so a recently used archived Session stays resident in `ctx.sessions` — presence is not liveness. The purge asks the Host's `workspace/session-activity` waterfall (the same admission check `archiveSession` uses) and refuses only Sessions that still report running work, after a whole-batch pre-flight. Attachments are never touched (content-addressed and possibly shared). The workspace registry is never rewritten by hand; archive and accounting go through public service methods.

## Compatibility

Tested on DSH 0.2.1-rc.5 (Desktop, Windows). Requires `webServer`, `workspaceRegistry`, `sessions` and `sessionPersistence`; targets the 0.2.x v4 session layout and workspace schema v2.

## Changelog

### 1.0.1

- Fixed archived sessions that could never be deleted ("0 / 4 · HTTP 400"): liveness now comes from `workspace/session-activity` instead of `ctx.sessions.get`, so resident-but-idle archived Sessions delete normally.
- The whole batch is pre-flighted: if any target (including a subagent descendant) still reports work, nothing is deleted and the report names the work family.
- The delete route no longer uses `400` for a business refusal; the page lists each failed Session with its reason, and the list stops labelling resident Sessions as running.
- Added `test/http.test.mjs`, which drives the real route handlers to pin the "resident but idle → 200 and deleted" and "still running → 200 with a readable reason" contracts.

## License

MIT © 2026 5D-artist
