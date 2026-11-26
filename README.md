# LanceDB 记忆库（dsh-lancedb-memory）

把 LanceDB 嵌进 DSH 进程：一个本地记忆表，加五个智能体工具（写入、检索、浏览、删除、状态）。

Embedded LanceDB memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): hybrid vector + BM25 recall with lifecycle ranking, exposed as five agent tools. No external server, no API key needed.

## 能力

| 工具 | 作用 |
| --- | --- |
| `lancedb_store` | 写入笔记，返回 32 位 id；`kind + text` 相同或向量相似度 ≥ `dedupe.threshold` 时归到已有那条 |
| `lancedb_search` | 混合检索：向量 + BM25 全文（ICU 分词，中文按词典切），加权融合后按时间/重要度微调，返回 `score`、`match` |
| `lancedb_list` | 按写入时间倒序列出记忆，可按 `kind` 过滤 |
| `lancedb_forget` | 按 id 删除 |
| `lancedb_stats` | 目录、行数、各 kind 数量、向量维度、检索模式 |

同时注册 Host 服务 `lancedb`，其他插件可 `inject: ['lancedb']` 后调用 `store / search / list / forget / stats`。

## 排序怎么算

1. 向量检索取 `max(limit*4, 12)` 个候选，BM25 取同样多候选；两路都套 `kind` 过滤。
2. 分数融合：`(w_vec·余弦相似度 + w_bm25·BM25/本批最高BM25) / (w_vec+w_bm25)`；
   BM25 除以本批最高分归一化，只被一路命中的另一路记 0。
3. 生命周期系数：`1 + recencyWeight·(新鲜度-0.5)·2 + importanceWeight·(重要度-0.5)·2`，
   新鲜度按 `lastAccessedAt` 的半衰期算；默认最多 ±20%。
4. `minScore` 过滤后取前 `limit` 条，并把命中的行 `accessCount + 1`、刷新 `lastAccessedAt`
   （访问强化：常被想起的笔记衰减更慢）。

`match` 字段说明命中方式：`both` / `vector` / `bm25`；`similarity` 只在有向量命中时出现。

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
        embedding:
          provider: hash                # hash（默认，离线）或 http（OpenAI 兼容）
          dimension: 384                # hash 维度
          # provider 为 http 时：
          baseUrl: https://api.openai.com/v1
          model: text-embedding-3-small
          apiKeyEnv: OPENAI_API_KEY     # 从该环境变量读 key，默认 DSH_LANCEDB_EMBEDDING_KEY
        search:
          vectorWeight: 0.7             # 向量权重
          bm25Weight: 0.3               # BM25 权重
          minScore: 0                   # 低于它的结果丢掉
          recencyHalfLifeDays: 30       # 新鲜度半衰期
          recencyWeight: 0.1            # 时间系数强度，0 关闭
          importanceWeight: 0.1         # 重要度系数强度，0 关闭
          trackAccess: true             # 检索后累加访问次数
        dedupe:
          enabled: true
          threshold: 0.95               # 同 kind 下余弦相似度达到它就视为重复
```

默认嵌入是本地字符 n-gram 哈希向量：离线可用，中文按字 + 二元组计分，检索偏词面相似。
配 `provider: http` 后换成真正的语义向量，维度以第一次返回为准。

换嵌入维度后旧表不兼容，需要换 `table` 名或清掉旧目录。

## 表结构与迁移

列：`id`、`text`、`kind`、`metadata`、`vector`、`createdAt`、`importance`、`accessCount`、
`lastAccessedAt`、`updatedAt`。

v0.1 的旧表（没有后四列）打开时会自动 `addColumns` 补齐，`importance` 补 5、
`accessCount` 补 0、`lastAccessedAt`/`updatedAt` 从 `createdAt` 推导；随后自动建 BM25 索引。
索引建失败不会让调用失败，会降级成纯向量检索，原因写在 `lancedb_stats` 的 `ftsError`。

## 安装

```bash
git clone https://github.com/tbx709/dsh-lancedb-memory.git
cd dsh-lancedb-memory
pnpm install     # 拉 @lancedb/lancedb@0.41.x，原生包约 205 MB，不进仓库
```

装好后用 DSH 的 `plugin_manager` 安装这个目录（`install_bundle`，target 传绝对路径），
或在 profile 的 patch 里加一条 `insert` 行，`name` 写 `dsh-lancedb-memory`。

升级：`git pull && pnpm install`，然后重启 DSH —— 插件模块只在启动时加载一次，
换版本后要重启才能用上新代码。

## 自测

```bash
node test/smoke.mjs   # 五个工具、混合检索、去重、重要度/时间排序、访问强化、旧表迁移、HTTP 嵌入
```

## 设计来源

- `memory-lancedb-pro`：向量 + BM25 混合、重排、时间衰减与访问强化、多 scope、重要度。
- `cclm-lancedb-memory`：`memory_list`、`importance`、访问计数、RRF 权重 0.7/0.3。
- 本插件只取能在 DSH Host 内闭环的部分，不做自动抽取、跨进程锁和 CLI。
