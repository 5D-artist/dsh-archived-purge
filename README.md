# dsh-archived-purge

**DSH 归档会话清理：全选删除归档会话，连同本地文件一起清干净。**

[中文](#中文) · [English](#english)

DSH 自带的「归档」只是把会话从侧边栏隐藏，磁盘上的日志、投影缓存、工作区记账都还在，而且没有批量删除入口。这个插件在 **设置 → 归档清理** 里补上一页：按工作区分组列出全部归档会话，支持全选 / 逐条勾选，一次永久删除选中的会话及其本地存储。

## 功能

- **一眼看清**：按工作区分组，显示标题、最后活动时间、占用体积。
- **全选 / 多选**：顶部全选，逐行勾选，实时显示已选条数与总体积。
- **永久删除**：一次清掉四类本地痕迹
  - 会话日志目录 `<DSH_HOME>/sessions/--<cwd>--/<session-id>/`
  - 投影缓存行 `<DSH_HOME>/storages/session_projcache/sessions/<session-id>.json`
  - 工作区记账（公开 API `Workspace.detachSession`）
  - 全局归档集合（`workspaceRegistry.unarchiveSession`）
- **子代理级联**：仅删除 `origin: 'subagent'` 且挂在被删会话下的子会话日志；普通 fork 出来的会话不受影响。
- **深度清理（可选）**：删除对话框会先扫描并勾选式列出
  - **无人引用的附件**：删完这批会话后，`attachments/v1/objects/<sha256>` 里没有任何剩余日志引用的对象（引用感知，先读后删）；
  - **请求图缩放缓存**：`cache/attachments/request-images/`，可重建；
  - **该批会话写出的工作区文件**：只识别 `write` / `edit` / `present` 明确写过的路径，逐个勾选、默认不选。
- **孤儿附件单独入口**：不删会话也能点「清理孤儿附件」，先 dry-run 报数字，再确认执行。
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
3. 点「删除所选」→ 对话框里可选择要不要一并深度清理 → 确认。

删除不可撤销，列表不会自动清理任何东西 —— 只有确认后的选中项才会被删。

## 删除范围

| 项目 | 是否删除 | 说明 |
|---|---|---|
| 会话日志目录 | ✅ | `session.vN.jsonl*` 整个会话目录 |
| 投影缓存行 | ✅ | 单会话 JSON，删除后按需重建 |
| 工作区记账 | ✅ | 走 `Workspace.detachSession`，不手改 `workspace.json` |
| 归档集合 | ✅ | 走 `unarchiveSession`，不手改注册表 |
| subagent 子会话日志 | ✅ | 仅 `origin: 'subagent'` 的后代 |
| 附件（`attachments/v1/objects/`） | ⚙️ 可选 | 只在没有其它日志引用时删除；先读日志收集引用，再删 |
| 请求图缩放缓存（`cache/attachments/request-images/`） | ⚙️ 可选 | 派生文件，可重建 |
| 该批会话写出的工作区文件 | ⚙️ 手动勾选 | 只列 `write` / `edit` / `present` 的路径，默认不选 |
| 其它工作区文件（脚本产出的视频等） | ❌ | 日志里没有可信的「谁产出的」记录 |
| fork 出来的普通会话 | ❌ | 只按 subagent 血缘级联 |

### 引用感知的附件清理怎么做

- DSH 的附件存储是**内容寻址且不可变**的，`dsh-attachment` 的文档写明：恢复或 fork 出来的会话可能共享同一批对象，因此 **reference-aware GC 被明确推迟，不绑定任何单个会话的删除**；上游现状是「附件永不删除」。
- 会话日志里只存 `{"type":"image","attachment":{"attachmentId":"sha256:…"}}` 这类引用，**没有「谁创建了它」的字段**，所以本插件按「先读后删」实现：先读完所有剩余日志收集摘要，再删对象；删单个会话时，它独占的对象自然变成孤儿，一次清扫即可。
- 三条安全规则：**读不全就不删**（任一日志读取失败即整次取消）、**10 分钟宽限期**（新对象可能还没写进日志）、**只删对象与派生缓存**，绝不碰日志之外的索引文件。
- 工作区文件同理：日志只记录 `write` / `edit` / `present` 的目标路径，脚本（pwsh/ffmpeg 等）产出的文件没有归属记录，插件不会靠时间戳猜；能被证明的才逐个列出，供你勾选。

## 安全设计

- **运行中拒绝，但「在内存里」不等于运行中**：归档只是把会话从侧边栏隐藏，并不会销毁它 —— 最近用过的归档会话仍然驻留在 `ctx.sessions` 里。旧版把「存在」当成「运行中」，于是任何还热着的归档会话都删不掉，页面只显示 `部分删除失败: 0 / 4 · HTTP 400`。现在改为询问 Host 的 `workspace/session-activity` 瀑布（Agent 的 `turn`、任务注册表、子代理运行时、定时任务都会在这里应答，`archiveSession` 用的是同一道闸），只有真的有活要干时才拒绝，并说明是哪一类工作。
- **整批前置检查**：删除前先一次性检查这一批（含 subagent 后代），只要有一个还在跑就整批不动，不会出现「一半删了、一半留着」的残局。
- **驻留会话的记账延后回收**：文件可以立刻删（磁盘马上回收），但**不能**在会话还驻留内存时把它从工作区记账里摘掉 —— 那样它仍会被 `sessions.list()` 列出来，只是失去归属，于是掉进侧边栏的「未分组」。所以驻留目标的记账与归档标记会保留到**下次启动**（此时进程不再持有该会话），由 `finalizePending()` 收尾；页面在此期间只显示一行「另有 N 个已删除会话的记账将在下次启动时自动回收」。
- **附件 GC 的安全边界**：只删 `attachments/v1/objects/` 下没有任何日志引用的对象；任一日志读不出来就整次放弃；10 分钟内的新对象一律保留；`request-images` 只清派生缓存。
- **工作区文件的安全边界**：路径必须由 Host 自己扫描得出（浏览器传什么都要重新核对），必须是该批会话日志里 `write` / `edit` / `present` 的目标，必须位于会话 cwd 内，且**永不在 `DSH_HOME`、插件自身目录、`.git` / `node_modules` 内**；默认全部不勾选，逐项确认。
- **入口校验**：`sessionId` 必须匹配 `^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$`；请求必须同源、`application/json`、体大小受限。
- **路径边界**：待删路径必须 `path.relative` 落在 `sessions/` 或投影缓存根内。
- **不重写注册表**：归档集合与工作区记账都通过公开 service 方法修改，避免与运行中的注册表写入竞争。

## 兼容性

- 实测：**DSH 0.2.1-rc.5**（Desktop，Windows）。
- 需要 Host 服务：`webServer`、`workspaceRegistry`、`sessions`、`sessionPersistence`。
- 存储布局：0.2.x 的 v4 会话日志、`workspace.json` schema v2、`session_projcache` 单记录文件、`attachments/v1/objects` 内容寻址对象。
- 仅 Web 客户端（`dsh.client.platform = web`）。

## Host 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/plugins/archived-purge/state` | 归档列表（标题、工作区、体积、最后活动、`active` / `activity` / `resident`） |
| POST | `/plugins/archived-purge/delete` | `{ "sessionIds": [...], "files": [...], "attachments": true, "requestImages": true }`；请求本身合法时恒返回 200，`ok` / `code` / `message` / `results` / `artifacts` / `gc` 描述结果 |
| POST | `/plugins/archived-purge/scan` | `{ "sessionIds": [...] }` 只读预演：删掉这批会释放多少附件、请求图缓存多大、写出的工作区文件清单 |
| POST | `/plugins/archived-purge/gc` | `{ "dryRun": true, "requestImages": false }` 孤儿附件清扫；`dryRun: false` 才真删 |
| POST | `/plugins/archived-purge/client-error` | 客户端挂载失败上报，写入 `<DSH_HOME>/archived-purge-client-errors.log` |

删除接口的状态码约定：`400` 只用于请求体不是合法 JSON，`403` 只用于跨源，`405` / `415` 用于方法与 Content-Type；「没删成」属于业务结果，用 200 + `ok: false` + `message` 表达，页面据此逐条列出原因。

## 更新日志

### 1.1.0

- 新增**深度清理**：删除对话框里可选「无人引用的附件」「请求图缩放缓存」，并勾选该批会话写出的工作区文件；新增独立的「清理孤儿附件」入口（先 dry-run 报数字再确认）。
- 新增引用感知的附件 GC（`lib/clean.js`）：先读完所有剩余日志收集 `sha256` 摘要，再删无人引用的对象；读取失败即整体放弃，10 分钟内的新对象一律保留。
- 工作区文件只按 `write` / `edit` / `present` 的显式路径识别，必须位于会话 cwd 内，且排除 `DSH_HOME`、插件自身目录、`.git` / `node_modules`；服务端重新扫描核对，浏览器传来的路径不能凭空删文件。
- 新增 28 项测试（Host 11 / 路由 8 / 清理 7 / 客户端渲染 2），客户端用最小 React 运行时真实挂载并点击。

### 1.0.2

- 修复 **删除后会话掉进侧边栏「未分组」**：文件删完之后，旧实现立刻摘掉工作区记账并解除归档；但驻留内存的会话仍会被 `sessions.list()` 列出，于是失去归属、以「未分组」重新出现。现在驻留目标的记账与归档标记保留到下次启动，由 `finalizePending()` 收尾（启动时、以及每次删除前都会跑一遍），页面只提示「另有 N 个已删除会话的记账将在下次启动时自动回收」。
- 列表不再显示「日志缺失」的幽灵行：没有日志的归档条目属于待回收记账，收尾时自动消失。
- README 补上「为什么不动附件与工作区文件」：上游 `dsh-attachment` 明确把 reference-aware GC 推迟，附件不可变且可能跨会话共享，工作区文件是用户产出。

### 1.0.1

- 修复 **归档会话永远删不掉、只报 `部分删除失败: 0 / 4 · HTTP 400`**：运行判定从「`ctx.sessions.get` 里还有没有」改为 `workspace/session-activity` 瀑布，驻留内存但空闲的归档会话现在可以正常删除。
- 删除改为**整批前置检查**：任一目标（含 subagent 后代）仍在运行则整批不删，并列出是哪一类工作（对话 / 任务 / 子代理 / 定时任务）。
- 删除接口不再用 `400` 表达业务失败，页面逐条显示失败会话与原因；列表不再把驻留会话标成「运行中」，状态取不到时标「运行状态未知」。
- 新增 `test/http.test.mjs`：直接驱动路由处理函数，锁定「驻留但空闲 → 200 且删除成功」「仍在运行 → 200 + 可读原因」两条契约。

## 开发

```sh
node --test test/host.test.mjs test/http.test.mjs
```

`test/host.test.mjs` 在临时目录构造完整存储结构，覆盖列表、删除、运行中拒绝、驻留但空闲（回归）、整批前置检查、非法 ID、记账已从投影消失、subagent 级联；`test/http.test.mjs` 用假的 `ctx` 驱动真实路由，锁定状态码、扫描与 GC 的响应体；`test/clean.test.mjs` 单测引用扫描、孤儿判定、只读对象删除、产出物识别；`test/client.test.mjs` 用最小 React 运行时真实挂载设置页并点击。全部不触碰真实数据。

```
index.js            Host 半：列表 / 删除 / 路由 / 边界校验
lib/clean.js        引用扫描、附件 GC、产出物识别与删除
client.js           Client 半：设置页、全选、确认弹窗、深度清理
cordis.patch.yml    bundle patch
locale/{zh,en}.json 插件市场展示元数据
test/host.test.mjs  Host 单测
test/http.test.mjs  路由 / 扫描 / GC 集成测试
test/clean.test.mjs 清理模块单测
test/client.test.mjs 客户端渲染与交互测试
```

## 已知限制

- 只能删除归档集合中的会话；活动会话请先归档。
- 附件 GC 是**全量扫描**：会话越多、日志越大，耗时越长（本机 6 个会话/2820 条事件约几十毫秒）。
- 10 分钟宽限期内的附件对象不会被回收。
- 驻留会话的记账在下一次启动时回收（DSH 没有让第三方插件把会话逐出 `ctx.sessions` 的公开接口）。
- 工作区产出物只认 `write` / `edit` / `present` 的显式路径；`pwsh`/`ffmpeg` 等命令产出的文件不在清单里。
- 归档时间不是 DSH 的持久字段，列表用最后活动时间排序。

## License

[MIT](LICENSE) © 2026 5D-artist

---

# English

**Select-all cleanup for archived DeepSeek Harness sessions: delete the session log, projection cache, workspace accounting and archive marker together.**

DSH's built-in archive only hides a session from the sidebar; its log, projection cache and workspace accounting stay on disk, and there is no bulk delete. This plugin adds **Settings → Archive Cleanup**: every archived session grouped by workspace, with select-all / per-row selection and one permanent delete for the selection.

## Features

- Grouped by workspace with title, last activity and size.
- Select all or individual rows, with live count and total size.
- Permanent deletion of the session log directory, the projection-cache row, the workspace accounting slot (`Workspace.detachSession`) and the archive-set entry (`workspaceRegistry.unarchiveSession`).
- Cascades only `origin: 'subagent'` descendants; ordinary forks are left alone.
- Guards: a Session that still reports work is refused (decided by `workspace/session-activity`, not by "it is still in memory"), ids are allow-listed, every path must stay inside the session/cache roots, POSTs are same-origin, and deletion needs an explicit confirmation.
- Readable failures: a refused or failed delete lists each Session with its reason instead of a bare `HTTP 400`.
- **Deep clean (optional)** in the confirmation dialog: unreferenced attachment objects, the request-image downscale cache, and the workspace files those Sessions explicitly wrote (`write` / `edit` / `present`, listed one by one and unticked by default).
- **Standalone orphan sweep**: without deleting anything, dry-run first and then remove attachments no log references.

## Install

```sh
dsh plugin --profile desktop add github:5D-artist/dsh-archived-purge
```

Or use **Settings → Plugins → Add plugin** with `https://github.com/5D-artist/dsh-archived-purge`.

## Usage

Settings → Archive Cleanup → select all → Delete selected → confirm. Nothing is deleted before that confirmation.

## Safety

Archiving hides a Session without disposing it, so a recently used archived Session stays resident in `ctx.sessions` — presence is not liveness. The purge asks the Host's `workspace/session-activity` waterfall (the same admission check `archiveSession` uses) and refuses only Sessions that still report running work, after a whole-batch pre-flight.

Deleting the files of a resident Session is fine; dropping its workspace slot while it is still listed is not — that is what made the Session reappear under the sidebar's *Ungrouped* bucket. So a resident target keeps its slot and archive marker until the process no longer holds it, and `finalizePending()` (on load, and before each batch) clears them on the next start. The page says how many entries are waiting.

Attachments and their derived request-image cache are not deleted by default: objects are content-addressed, may be shared by resumed or forked Sessions, and upstream `dsh-attachment` deliberately defers reference-aware GC. The optional deep clean supplies that missing half by reading every remaining log first: an unreadable log aborts the sweep, objects younger than ten minutes are kept (an attachment is published before the event that references it), and only objects no log mentions are removed. Workspace files are never guessed: only the explicit targets of `write` / `edit` / `present` are offered, they must live inside the Session's cwd, and the server never accepts a path it did not itself list; `DSH_HOME`, this plugin's own package, `.git` and `node_modules` are excluded. The workspace registry is never rewritten by hand; archive and accounting go through public service methods.

## Compatibility

Tested on DSH 0.2.1-rc.5 (Desktop, Windows). Requires `webServer`, `workspaceRegistry`, `sessions` and `sessionPersistence`; targets the 0.2.x v4 session layout, workspace schema v2 and the `attachments/v1/objects` store.

## Changelog

### 1.1.0

- Added the **deep clean**: the confirmation dialog can also remove unreferenced attachment objects, the request-image cache, and the workspace files the Sessions explicitly wrote; a standalone "clean orphan attachments" action dry-runs first.
- Added reference-aware attachment GC (`lib/clean.js`): read every remaining log for `sha256` digests, then delete only objects no log mentions; an unreadable log aborts the sweep and objects younger than ten minutes are kept.
- Workspace artifacts come only from `write` / `edit` / `present` paths inside the Session cwd, excluding `DSH_HOME`, this plugin's package, `.git` and `node_modules`; the server re-derives the allowed set, so a browser-supplied path can never delete a file the scan did not offer.
- 28 tests now cover the host, the routes, the cleaner and a mounted Settings page.

### 1.0.2

- Fixed Sessions falling into the sidebar's **Ungrouped** bucket after a delete: bookkeeping and the archive marker now stay until the Session leaves the store, and `finalizePending()` finishes them on the next start (also before every batch). The list reports how many entries are waiting.
- The list no longer shows ghost rows for archived entries whose log is gone.
- Documented why attachments and workspace files stay out of scope, with the upstream retention decision.

### 1.0.1

- Fixed archived sessions that could never be deleted ("0 / 4 · HTTP 400"): liveness now comes from `workspace/session-activity` instead of `ctx.sessions.get`, so resident-but-idle archived Sessions delete normally.
- The whole batch is pre-flighted: if any target (including a subagent descendant) still reports work, nothing is deleted and the report names the work family.
- The delete route no longer uses `400` for a business refusal; the page lists each failed Session with its reason, and the list stops labelling resident Sessions as running.
- Added `test/http.test.mjs`, which drives the real route handlers to pin the "resident but idle → 200 and deleted" and "still running → 200 with a readable reason" contracts.

## License

MIT © 2026 5D-artist
