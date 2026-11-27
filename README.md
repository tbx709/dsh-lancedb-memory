# LanceDB 记忆库（dsh-lancedb-memory）

把 LanceDB 嵌进 DSH 进程：会话默认隔离，有用的内容可以提升进某个 **soul**，再加五个记忆工具。

Embedded LanceDB memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): session-isolated storage plus reusable memory domains called souls, with hybrid vector + BM25 recall. No external server, no API key needed.

## 隔离模型

一条记忆只属于一个 scope：

- `session:<id>`：当前会话的工作记忆，写入默认落这里，别的会话搜不到。
- `soul:<name>`：长期记忆域，由用户显式提升（promote）或直接写入。

会话默认范围 = 自己的 session + 已挂载（attach）的 soul。跨过这条线的唯一动作是 `lancedb_promote`，所以不会出现"某次对话的草稿悄悄进了共享记忆"。

典型流程：

1. 平时正常 `lancedb_store`，笔记留在会话里。
2. 用户说"记住，以后文案都按这个来"：`lancedb_promote` 把那条复制进 `writing` soul。
3. 下个会话：`lancedb_souls list` 看有哪些 soul 和描述 → `lancedb_attach` 挂上 `writing` → 之后的 `lancedb_search` 自动包含它。

## 工具

| 工具 | 作用 |
| --- | --- |
| `lancedb_store` | 写笔记，默认写当前会话；`soul: 'x'` 直接写进某个 soul（要先建） |
| `lancedb_search` | 混合检索：当前会话 + 已挂载的 soul，`souls` 可临时改范围 |
| `lancedb_promote` | 把会话里的 id 复制进 soul；`move: true` 复制后从会话删 |
| `lancedb_souls` | `list` / `create`（要 description）/ `copy`（`name` → `target`）/ `merge`（`sources` → `target`，来源保留；默认语义合并）/ `rename` / `delete`（要 force: true） |
| `lancedb_attach` | 给当前会话挂载或卸下 soul |
| `lancedb_list` | 按写入时间倒序列出当前会话或某个 soul |
| `lancedb_forget` | 删会话里的记忆；删 soul 里的要显式传 `soul` |
| `lancedb_stats` | 目录、行数、kind 分布、会话数、各 soul 数量、检索模式 |

同时注册 Host 服务 `lancedb`，方法显式收 scope：`store(scope, input)`、`search(scopes, input)`、`promote(sessionScope, input)`；soul 级操作有 `createSoul` / `copySoul` / `renameSoul` / `mergeSouls` / `deleteSoul`。

## Web 界面

装好后刷新页面（客户端模块只在页面加载时装配）。入口有两处，取决于会话阶段：

- **新会话、还没发第一条消息**：输入框上方的 hero 行右侧有一个 `Souls` 按钮，点开是同一个选择面板（原生模态框）；选好的 soul 会先挂到这个会话上。
- **已有消息的会话**：输入框下面出现一行 `Souls` 芯片（下文的折叠/展开行为）。

选中方式（两个入口一致）：点一行的名字/描述，或点行右侧的 `use` 按钮，就挂到当前会话；按钮变成 `using`、整行高亮，再点一次取消。已挂载的 soul 会排在列表最前面。

芯片详情：

- 折叠状态只显示当前会话已挂载的 soul 芯片，超过 8 个折成"还有 N 个"，soul 再多也不会撑高输入框。
- 点"选择 (N)"展开挑选面板：soul 超过 6 个时带筛选框，列表最高 320px 可滚动，每行显示描述和条数，点一下挂载/卸载。
- 每行右侧的 "view" 展开这个 soul 的记忆原文（最多 50 条，带 kind 和日期），不用叫 agent 就能核对内容；再点 "hide" 合上。
- 每条原文右上角的"×"点一下就删，删除只影响该 soul（所有会话共享）；紧接着面板里出现"已删除 · 撤销"，撤销会按原文本、kind、重要度重新写入，但 id 和创建时间会变。
- 面板底部的"管理"进入管理态，每行出现复选框，动作按钮统一英文：
  - `copy`：勾 1 个即可，目标名自动取 `<原名>-1`、`-2`…，不用手输。
  - `rename`：勾 1 个，行内出输入框改名字，条目和挂载关系跟着走。
  - `merge`：勾 2 个以上并填目标名；来源 soul 保留。默认先按向量把相近笔记分组，再让当前 profile 的默认模型判断哪些是同一件事、并成一条，输出会保留具体数字、路径和结论；没有可用模型时退回"`kind` + 文本完全相同才跳过"的机械去重。
  - `delete`：勾 1 个，两步确认，连它记住的内容一起删。
- 已挂载的芯片点一下就卸载，效果等同 agent 调 `lancedb_attach`，下一次检索立刻生效。
- 没有 soul 时显示提示，让 agent 先用 `lancedb_souls` 建一个。
- 浏览器只走九个 owner-only 路由：`/api/lancedb/souls`（列表）、`/attach`、`/notes`、`/delete`（删一条）、`/restore`（撤销）、`/souls/copy`、`/souls/rename`、`/souls/merge`、`/souls/delete`，全部挂在已鉴权的 `/api` 通道上。

## 排序怎么算

1. 向量检索取 `max(limit*4, 12)` 个候选，BM25 取同样多候选；两路都套 scope 和 `kind` 过滤。
2. 分数融合：`(w_vec·余弦相似度 + w_bm25·BM25/本批最高BM25) / (w_vec+w_bm25)`。
3. 生命周期系数：`1 + recencyWeight·(新鲜度-0.5)·2 + importanceWeight·(重要度-0.5)·2`，
   新鲜度按 `lastAccessedAt` 的半衰期算，默认最多 ±20%。
4. `minScore` 过滤后取前 `limit` 条，命中行 `accessCount + 1`、刷新 `lastAccessedAt`。

`match` 说明命中方式：`both` / `vector` / `bm25`；`similarity` 只在有向量命中时出现。

## 配置

patch 行里的 `config` 全部可选：

```yaml
- insert:
    - id: dsh-lancedb-memory
      name: 'dsh-lancedb-memory'
      config:
        directory: /path/to/data        # 默认 $DSH_HOME/lancedb
        table: memories                 # 表名
        topK: 5                         # search 默认条数
        sessionTtlDays: 0               # >0 时 stats 顺手清掉更久没动过的会话（当前会话除外）
        embedding:
          provider: hash                # hash（默认，离线）或 http（OpenAI 兼容）
          dimension: 384                # hash 维度
          # provider 为 http 时：
          baseUrl: https://api.openai.com/v1
          model: text-embedding-3-small
          apiKeyEnv: OPENAI_API_KEY     # 从该环境变量读 key，默认 DSH_LANCEDB_EMBEDDING_KEY
        search:
          vectorWeight: 0.7
          bm25Weight: 0.3
          minScore: 0
          recencyHalfLifeDays: 30
          recencyWeight: 0.1
          importanceWeight: 0.1
          trackAccess: true
        dedupe:
          enabled: true
          threshold: 0.95               # 同一 scope 下余弦达到它、且忽略空白/标点后文本一致才算重复
        merge:
          similarity: 0.8               # 语义合并时先按这个余弦阈值把笔记分组成候选
```

默认嵌入是本地字符 n-gram 哈希向量：离线可用，中文按字 + 二元组计分，检索偏词面相似。
配 `provider: http` 后换成真正的语义向量，维度以第一次返回为准。

换嵌入维度后旧表不兼容，需要换 `table` 名或清掉旧目录。

## 语义合并怎么工作

`merge` 默认走语义合并，分三步：

1. 从来源 soul 收集笔记，丢掉 `kind` 和文本完全相同的重复项。
2. 候选不超过 40 条时全部交给模型判断；超过 40 条先用向量聚成相似组（`merge.similarity`，默认 0.55 余弦），只把有邻居的组发给模型——不会把整个库塞进一次请求。
3. 模型返回 `{groups:[{ids,text,kind,importance}]}`：合并后的正文写进目标 soul，来源 soul 一条不动；没被分组的笔记原样复制。

约束：模型只输出 JSON，解析失败或没有模型可用时自动回退机械合并，并在返回值里带 `semantic:false` 和 `semanticError`（界面上会显示"模型不可用，按文本合并了 N 条"）。合并结果的 id 按新文本重新算，`createdAt` 重置为合并时间。

## 数据布局

一张 LanceDB 表 `memories`，列：`id`、`text`、`kind`、`metadata`、`vector`、`scope`、
`createdAt`、`importance`、`accessCount`、`lastAccessedAt`、`updatedAt`。

同目录还有两个小 JSON：

- `souls.json`：soul 注册表（描述、创建/更新时间）。
- `sessions.json`：会话挂了哪些 soul。

**迁移**：v0.2 的旧表没有 `scope`，打开时补列并把旧行归进 `imported` soul（注册表里自动建），
生命周期列也一并补齐；随后自动建 BM25 索引，建失败会降级成纯向量检索，原因写在 `lancedb_stats` 的 `ftsError`。

## 安装

```bash
git clone https://github.com/tbx709/dsh-lancedb-memory.git
cd dsh-lancedb-memory
pnpm install     # 拉 @lancedb/lancedb@0.41.x，原生包约 205 MB，不进仓库
```

装好后用 DSH 的 `plugin_manager` 安装这个目录（`install_bundle`，target 传绝对路径），
或在 profile 的 patch 里加一条 `insert` 行，`name` 写 `dsh-lancedb-memory`。

升级：`git pull && pnpm install`，然后重启 DSH —— 服务端模块只在启动时加载一次；只改了 `client.js` 的话刷新页面即可。

## 自测

```bash
node test/smoke.mjs        # 会话隔离、soul 增删挂载、promote、语义合并、排序、迁移、HTTP 嵌入
node test/edges.mjs        # 校验错误、复制/合并竞态、维度不匹配、TTL 清理、路由参数校验
node test/fuzz.mjs         # 120 步随机操作，检查 id 唯一、统计一致、无孤儿 scope
node test/concurrency.mjs  # 并发 store/promote/copy/rename/merge/delete 的竞态
npm run test:all           # 以上全部
```

## 设计来源

- `memory-lancedb-pro`：向量 + BM25 混合、时间衰减与访问强化、多 scope 隔离、重要度。
- `cclm-lancedb-memory`：`memory_list`、`importance`、访问计数。
- 本插件只取能在 DSH Host 内闭环的部分，不做自动抽取、跨进程锁和 CLI。
