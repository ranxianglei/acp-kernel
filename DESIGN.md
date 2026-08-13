# DESIGN — compress 批处理错误归因 + 已消费 range 重试引导（rev3）

> 分支：`fix/compress-retry-errors`（基于 v0.0.21 / 59d1ecd）
> 关联问题：billion-context-pi 实际会话中 compress 工具"一直报错、无法自愈"
> rev2 变更：吸收第一轮 deepseek v4pro 审查（2 MAJOR / 4 MINOR / 3 NIT）——unknown/consumed 分流、tool-pair 复用边界、4 出口决策树、守卫外告警
> rev3 变更：吸收第二轮审查（PASS + 4 条精修）——R0+3 出口命名、分类错误前缀全出口统一、格式非法/anchor 失败不对称说明、行号修正、测试数 230

## 1. 问题（实测复现，billion-context-pi 会话日志）

一次真实会话中连续 5 次 compress 调用：

| # | 结果 |
|---|---|
| 1 | `69.2K → 11.8K (57.4K reclaimed, 14 blocks)` + **Errors: Summary too short (22 chars, min 50)** |
| 2–5 | 4 次重试同一批 15 个 range，全部 `0 reclaimed, 0 block` + **Errors: Total compressible content too small (1248 chars across 15 range(s), min 5000). Combine more messages into your range(s) to meet the threshold.** |

两个缺陷：

- **缺陷 A — 错误无归因**：`Summary too short` 只报字符数，不指明是**哪个 range** 失败。模型无法定位失败条目，只能整批重试。
- **缺陷 B — 重试已消费 range 时报误导性错误**：14/15 个 range 已被第 1 次调用消费（消息被隐藏进 block）。重试时预检把 "Boundary not found"（本应提示"已被 block 消费"）吞掉，改报"内容太小，请合并更多消息"——建议方向完全错误（加内容解决不了），模型照做重试 4 次。

## 2. 根因（file:line，基于 v0.0.21 源码，行号经两轮审查核实）

- `src/compress.ts:122-139` — `rangeIndexSets` 构建循环：`try { resolveBoundaries(...) } catch { continue }`（catch-continue 在 :132-134）静默丢弃无法解析（已消费/未知）的 range，不留任何记录。
- `src/compress.ts:162-201` — `minCompressRange` 预检循环：`catch { continue }`（:175）吞掉 `src/boundaries.ts:71-76` 抛出的、本可准确指导的 `Boundary not found in visible context (likely consumed by an existing block)...`；随后 :187-199 报 `Total compressible content too small (... across ${input.ranges.length} range(s) ...)`——分母把**全部**请求 range 计入（含已消费的 14 个），数字自相矛盾。
- `src/compress.ts:704-707` — `validateCompressionRange`（函数体 :690-725）：`Summary too short (${summary.length} chars, min ...)` 不含 range 标识。
- `src/compress.ts:218-219` — 批处理逐 range 的 `catch (error) { errors.push(...) }` 收集原始错误，不加 range 前缀。
- `src/boundaries.ts:115-132` — `resolveAnchorIndex`：message ref 在 `byRef` miss（:124）与 rawId 不在可见消息（:125-126）两种情形都返回 null → :71-76 统一抛 "Boundary not found"，**不区分"从未分配"与"已被消费"**。

额外问题：同一个 range 在 `applyCompression` 中被 `resolveBoundaries` 三次（compress.ts:126 / :169 / :504），信息不同步。

## 3. 修复设计

### 3.1 类型化边界错误（boundaries.ts）

```ts
export class BoundaryNotFoundError extends Error {
  readonly code = "BOUNDARY_NOT_FOUND";
  readonly kind: "unknown" | "consumed";   // ref 从未存在 | 已被 block 消费
  readonly endpoint: "start" | "end";      // 失败的是哪一端
}
```

`resolveAnchorIndex` 改为在失败点直接抛 `BoundaryNotFoundError`（该处信息齐全）：

- message ref：`state.messageRefs.byRef[...]` miss（:124）→ `kind="unknown"`（**从未分配**：拼错/跨会话；prune 只隐藏消息、不删 byRef 映射——`assignRefs`（src/refs.ts:58-60,74-79）对 byRef 单调累积、生产代码无任何 delete/重建（`rebuildRefIndex` 仅测试引用），故 byRef miss 可靠地表示"从未存在"）；byRef 命中但 rawId 不在 `input.messages`（:125-126）→ `kind="consumed"`（被 prune/block 隐藏）。
- block ref：`blockById` undefined → `unknown`；`!block.active`（被 T2/T3 蒸馏）→ `consumed`；anchor 为 null（消息被更高层 block 覆盖）→ `consumed`。

`resolveBoundaries`：`parseBoundary` 返回 null → 保留原 `Invalid boundary ref(s): ...`（普通 Error，不改）；端点 anchor 解析失败 → 首个失败端点即抛 `BoundaryNotFoundError`（带 `endpoint` 与**该端点的具体 ref**，即用户写入的 ref 规范化形态）。

文案调整（已核实无现有测试断言旧原文，安全）：`unknown` → `startId="m99999" does not exist in this session (typo or wrong session) — run acp_status for current refs.`；`consumed` → `endId="m00740" not found in visible context (likely consumed by an existing block).`

`src/index.ts:31` 附近导出 `BoundaryNotFoundError`（tsup 全内联、`dependencies:{}`、无 external，新增导出零打包风险；插件可 `instanceof` 判断）。

### 3.2 单次分类解析（compress.ts:122-139 与预检合并）

`applyCompression` 开头对每个 range **只解析一次**并分类：

```ts
type RangeResolution =
  | { status: "ok"; resolved: ResolvedRange }
  | { status: "consumed"; error: BoundaryNotFoundError }  // kind==="consumed"
  | { status: "unknown"; error: BoundaryNotFoundError }   // kind==="unknown"
  | { status: "invalid"; error: Error };                  // parseBoundary null
```

- `rangeIndexSets` / overlap `skipSpecs`（:122-157）只从 **ok** 子集构建（unknown/consumed/invalid 不参与 overlap）。
- 预检与逐 range 循环复用分类结果 → 解析次数 **3→2**（ok range 在 applySingleRange 内部再解析一次）。
- **边界明确（吸收 MAJOR 2）**：分类结果仅服务 overlap/预检/告警；`applySingleRange` **必须保留**其内部 `resolveBoundaries + applyToolPairAdjustment + 调整后嵌套块重扫`（:504-535）——若以预解析结果替代，孤儿 tool-call/result 不再被拉进 range、`:518` 的长度判断恒 false、嵌套块重扫失效。预检用原始 `resolved.messageIds` 与现状（:182-185）一致，无阈值回归。

### 3.3 预检决策（规则 R0 + 3 个出口，仅 minCompressRange>0 时执行）

对 ok 且非 skipSpecs 且非 block-boundary 的 range 累计 `totalChars`：

- **规则 R0（跨所有出口）**：存在 unknown/invalid → 无条件收集为 per-range 错误，前缀一律 `range ${spec.startRef}..${spec.endRef}: `（与 §3.4 同款），**不 fail-fast**（吸收 MAJOR 3 选项 a：合法 range 照常压缩，部分成功语义保持）——这些错误在任何出口（含早退 1/2）都随 `errors` 返回，绝不被吞。前缀与消息内嵌端点 ref 并存属有意为之：前缀定位 range，内嵌 ref 定位失败端点（吸收 MINOR-2）。
1. **无 block-boundary 且 totalChars < min 且存在 consumed** → 早退：
   ```
   Requested range(s) already compressed (e.g. m00733..m00740); remaining compressible
   content 1248 chars < min 5000. Nothing to do — run acp_status to see current compressible ranges.
   ```
   `errors = [该消息] + R0 错误`；`warnings=[]`。（"全部已消费"是退化情形：totalChars=0。）
2. **无 block-boundary 且 totalChars < min 且无 consumed** → 早退，保留原文案（仅分母修正）：
   ```
   Total compressible content too small (X chars across K range(s), min Y). Combine more messages...
   ```
   其中 **K = 实际参与计数的 ok range 数**，不再用 `input.ranges.length` 虚报（吸收 MINOR 4）。`errors = [该消息] + R0 错误`；`warnings=[]`。
3. **其余** → 放行：consumed 记入 warnings、unknown/invalid 记 per-range 错误（R0）、ok 进入逐 range 循环。

**consumed 的识别/跳过/告警位于阈值守卫之外**（吸收 MINOR 5）：分类后、逐 range 循环前统一处理——守卫只决定"是否早退"，不决定 consumed 是否可见。`minCompressRange=0` 兜底：consumed 全部 warning+skip（全 consumed → `blocksCreated=0` + warnings，无错误）。

### 3.4 逐 range 错误归因（:218-219）

```ts
} catch (error) {
  errors.push(`range ${spec.startRef}..${spec.endRef}: ${error instanceof Error ? error.message : String(error)}`);
}
```

统一覆盖 `Summary is empty` / `Summary too short` / `Summary too long` / `Range contains no compressible messages` / `Range is entirely within the protected zone`。缺陷 A 消除：模型一眼可知失败条目。批处理部分成功（14/15）语义不变。

### 3.5 已知边界（吸收 MINOR 6 与 MINOR-1）

- **部分解析**：start 可解析、end 已消费 → 分类按失败端点（`kind`+`endpoint`），错误点名失败端与具体 ref，模型据此修正另一端；**不做自动裁剪**（避免隐式改变 range 语义）。
- **格式非法 vs anchor 失败不对称**（吸收 MINOR-1）：端点 parseBoundary 返回 null（如 `"foo"`、`"m999999"`、`"m0"`）→ 整 range 判 invalid、沿用原 `Invalid boundary ref(s)` 文案、不点名端点；仅当两端格式均可解析但 anchor 解析失败时，才按 `kind`+`endpoint` 精确归因（unknown/consumed）。
- `minCompressRange=0` 时 consumed 的表现见 §3.3 出口 3 兜底（非早退路径，行为为 warn+skip）。

### 3.6 明确不做

- 不改 hide-consumed / prune / block 语义。
- 不改 `validateCompressionRange` 的消息文本（归因在批处理层统一加前缀，避免两处拼接）。
- 不改插件（billion-context-pi）逻辑——kernel 错误文本带归因后透传即可；插件侧仅升 kernel 版本。
- 不做 tool-pair 调整上移（把分类做成 1 次解析需重构 applySingleRange，超出本次范围，见 §3.2）。

## 4. 测试计划（tests/compress.test.ts 新增 + 回归）

| # | 场景 | 断言 |
|---|---|---|
| T1 | 两 range 批，其一 summary 22 字符 | errors[0] 含 `range {S}..{E}:` 前缀；另一个 range 正常建 block（部分成功保留） |
| T2 | 压缩 R 后（prune 隐藏消息，复用 tests/compress.test.ts:85-113 现成模式），以**相同 R** 再调 applyCompression（默认 minCompressRange=5000） | blocksCreated=0；errors[0] 含 "already compressed" 引导；**不出现** "Total compressible content too small" |
| T3 | 1 个已消费 + 1 个新小 range（合计 < 5000） | errors 同时说明"已消费"与"剩余不足阈值"；不出现旧误导文本 |
| T4 | 全新小内容、无 consumed | 保留 "Total compressible content too small" 文案（分母=实际计数 range 数） |
| T5 | 已消费 + 新内容 ≥ 5000 | 放行：warnings 含 "Skipped range ... already compressed"；新 range 建 block（blocksCreated=1） |
| T6 | 空 summary | 错误带 `range {S}..{E}:` 前缀 |
| T7 | 非法 ref：`"foo"` / `"m999999"` / `"m0"`（parseBoundary 返回 null） | per-range 错误 "Invalid boundary ref(s)"；不 fail-fast，合法 range 照常压缩。**注意 m99999 格式合法（`MESSAGE_REF_PATTERN=/^m0*(\d{1,5})$/` 命中），属 unknown 而非 invalid** |
| T8 | 从未分配的合法格式 ref（`m00099..m00100`，现 compress.test.ts:268-286 场景，其 config 为 minCompressRange=0） | per-range 错误 "does not exist in this session"；errors.length===1（:285 断言保持；语义从 "Boundary not found" 变为 unknown-ref，文案变更） |
| T9 | 已消费 + minCompressRange=0 | warnings 列出 consumed range；blocksCreated=0；无错误（守卫外兜底） |

回归确认（第二轮审查实测）：`node --import tsx --test tests/*.test.ts` 实际 **# tests 230**（非 216）；唯一断言旧文案的是 `tests/validation.test.ts:115`（`/too small/i`，走出口 2 仍含 "too small" ✓）与 `:176`（`/no compressible/i`，per-range 加前缀后仍匹配 ✓）；全仓无测试断言 `Boundary not found` / `Invalid boundary` 原文；无测试依赖 rangeIndexSets/预检的 catch-continue 行为（仅 compress.test.ts:268-286 用不可解析 ref，errors.length===1 不变）。

## 5. 上线路径

1. acp-kernel：本分支修复 + 测试 → PR（`fix/compress-retry-errors`）→ 合入后 release v0.0.22 并发布 npm。
2. billion-context-pi：`"acp-kernel": "0.0.22"`（精确 pin）+ `npm install` 刷 lockfile + typecheck/test/build → PR（`fix/compress-retry-errors`）。
3. 本地验证：billion-context-pi 以新版 kernel 构建，`cp dist/index.js ~/.pi/agent/npm/node_modules/billion-context-pi/dist/index.js`，supacode 新终端复现 T1/T2 场景。

## 6. 验收标准

- 压缩报错必须能定位失败 range（缺陷 A，含 "Summary too short" 带 range 前缀）。
- 重试已压缩 range 不再出现"请合并更多消息"的错误建议，而是明确"已压缩/无内容可做"（缺陷 B）。
- **unknown（ref 从未存在）与 consumed（已被消费）分开归因**：前者引导查 acp_status 修 ref，后者提示无需再做（rev2 新增）。
- 部分成功、重叠 warn+skip、T2/T3 蒸馏、既有 230 测试全部保持。
