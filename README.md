# 山海植物志

四季山林植物观察游戏。React 客户端负责地图、观察笔记、采集交互和年度报告，Node.js 服务端负责环境生成、生态演化、持久化和全部权威判定。

## 已实现闭环

- 创建匿名观察档案并持久化到 SQLite
- 四区域、四季、十日制探索与每日行动点
- 植物物候、叶片纹理、主色和环境数据记录
- 拍照、拓印、落叶采集、标准剪取及安全上限
- 错误采集对健康、种群、种子库、区域干扰和下一年度状态的持续影响
- 季节结算、年度报告、分布变化、物候偏移和生态修复
- 年度报告四类可追溯结论：分布迁移、物候偏移、修复成效、采集误差，每条结论都绑定观察、采集、修复或状态快照证据
- 历史年份报告补算（写入独立的 `backfilled_annual_reports`），不修改任何游戏状态，也不会污染后续年份的正式报告
- 观察笔记、物种档案、事件时间线、存档导出与恢复
- 幂等命令、乐观并发版本控制和自动化闭环测试

## 环境要求

- Node.js 22.13 或更高版本
- pnpm 10 或 npm 10 或更高版本

项目使用 Node.js 内置 SQLite，不需要额外安装数据库服务。

## 启动

```bash
pnpm install
cp .env.example .env
pnpm db:init
pnpm dev
```


浏览器访问 `http://127.0.0.1:5173`。API 默认运行在 `http://127.0.0.1:8787`，Vite 会代理 `/api`。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm start
```

`pnpm test:e2e` 会先构建生产包，再启动真实 HTTP 服务，完成“创建档案 → 观察 → 错误采集 → 四季结算 → 年度报告 → 第二年”的闭环，并在结束后清理临时数据库。

## 年度报告与历史补算

- 每年冬季结算生成正式年度报告（`annual_reports`），其中四类结论均带证据链与置信度：
  - **分布迁移**：年初基线 → 年末快照的局部消长/等级变化，以及 `BEGIN_NEXT_YEAR` 时实际发生、并写入 `dispersal_events` 台账的跨区域扩散（归属到目标年份）。
  - **物候偏移**：使用与进入下一年完全相同的确定性越冬推演（`applyOverwinter`），玩家观察记录决定结论置信度，避免把模型推演当成实地观测。
  - **修复成效**：每次 `RESTORE_HABITAT` 都写入 `restoration_actions`，按动作归因到干扰、健康和种子库的前后变化。
  - **采集误差**：每条不符合协议的样本逐条列出台账，包含健康、种群、种子库和区域干扰增量。
- 报告还包含数据完备性说明（四区覆盖、观察/采集偏差、错误采集占比）。
- `POST /api/save/:saveId/report/:year/backfill` 只允许补算当前游戏年**之前**的年份；过程只读历史台账，产物只写入物理隔离的 `backfilled_annual_reports` 表，因此补算不会改变存档版本、阶段、状态表或后续年份的正式报告。读取报告时正式报告优先，正式报告缺失才回退到补算版本。

## 生产启动

```bash
pnpm build
pnpm start
```

生产模式由 Node.js 同时提供 `/api` 和 `apps/web/dist` 静态资源。请在生产环境设置安全的 `SESSION_SECRET`、正确的 `APP_ORIGIN`，并将 `DATABASE_URL` 指向持久化磁盘。

## 目录

```text
apps/web                 React 客户端
apps/server              Node.js API、SQLite 与游戏服务
packages/contracts       前后端共享命令、类型和校验
packages/game-core       物种目录、环境生成和生态模拟
data/runtime             本地 SQLite 文件
tests                    真实 HTTP 闭环脚本
```

## 数据说明

物种、区域和演化参数是完整的游戏内容配置，不是界面演示数据。模拟结果用于游戏机制，不用于现实科研或生态预测。
