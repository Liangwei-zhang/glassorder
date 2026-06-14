# PLAN.md — 玻璃厂订单管理系统（Glass Order）

## 目标
基于已验收的原型（`prototype/` 里的 9 页 HTML），开发可跑、可验证、可交付的 v1。

## 既定设计决策（冻结，不再改动）
- 栈：Node 20 + Express + better-sqlite3 + vanilla JS 前端
- 客户端：PWA，手机 + iPad + 桌面通用
- 认证：手机号/邮箱 + 密码，JWT，3 角色（boss / worker / customer-no-login）
- PDF 解析：pdf-parse 提文字 + pdftocairo 出每页 jpg；假设格式统一
- 邮件：nodemailer SMTP，未配则只生成 PDF 不发
- 部署：本地 `npm start`，单机 SQLite
- 端口：backend 8781（同源服务前端）

## 数据模型
```
users      (id, phone/email, password_hash, name, role)
customers  (id, company, contact_name, phone, email, notes, created_at)
orders     (id, order_number, customer_id, project_name, priority,
            status, deadline, pdf_path, note, created_by, created_at)
pieces     (id, order_id, piece_no, stage, hold, rework, broken,
            size, type, thickness, weight, piece_note, drawing_path)
events     (id, order_id, piece_id?, actor_id, action, details, at)
pickups    (id, order_id, signer_name, signer_phone, signature_path,
            slip_pdf_path, picked_at, picked_by)
```

订单状态：`in_production | ready_pickup | picked_up`
片子 stage：`cut | edge | tempered | finished`
片子碎了 → stage 重置为 `cut`、`rework=true`、写 events

## 任务清单（按序）

### T1. Scaffold 后端
- `backend/` 目录: server.js, db.js, routes/, services/, middleware/, uploads/
- package.json：express, better-sqlite3, bcryptjs, jsonwebtoken, multer, uuid, dotenv, pdf-parse, nodemailer, pdfkit
- 启动 `npm start` 能在 8781 跑起来
- **验证**：`curl http://localhost:8781/api/health` 返回 `{ok:true}`

### T2. DB 初始化
- 建表脚本写入 db.js；首次启动时 seed 一个 boss 账号 (`admin/admin123`)
- **验证**：启动后 `sqlite3 glass.db ".tables"` 列出 7 张表；admin 存在

### T3. Auth
- `POST /api/auth/login` → `{token, user}`
- 中间件 `authenticate`、`requireRole(boss|worker)`
- **验证**：正确凭据得 token；错误得 401

### T4. 客户管理 CRUD
- `GET/POST /api/customers`，`PUT/DELETE /api/customers/:id`（仅 boss）
- **验证**：POST 一条 → GET 能看到 → PUT 改 → DELETE 掉

### T5. PDF 解析器
- `services/pdfParser.js`：
  - pdftotext 抽文字，用正则抽 total panels、每片的 size/type/thickness/weight
  - pdftocairo 按页转 jpg（page-1 = 封面，page-2..N = 第 1..N-1 片）
  - 返回 `{total, pieces: [...], coverPage}`
- **验证**：喂那份样品 PDF，解析出 8 片，每片字段与样品匹配

### T6. 订单创建 API
- `POST /api/orders`（multipart：customer_id, priority, deadline, note, pdf）
- 后端：保存 pdf → 调 T5 解析 → 插 orders + pieces + events
- **验证**：上传样品 PDF，DB 里有 1 单 8 片；片 4 的 size 为 `30" × 75-1/4"`

### T7. 订单/片 查询 API
- `GET /api/orders`（分页、过滤 status/priority/search）
- `GET /api/orders/:id` 带 pieces 展开
- `GET /api/pieces?stage=cut&order_id=...`（工人用）
- **验证**：各端点返回符合 schema

### T8. 片子操作 API
- `POST /api/pieces/:id/advance`（推到下一工序）
- `POST /api/pieces/:id/broken`（退回 cut + rework=true）
- `POST /api/pieces/:id/hold` / `:id/unhold`
- 所有操作写 events
- **验证**：对片 1 调 advance 3 次 → stage=finished；对片 2 调 broken → stage=cut, rework=true

### T9. 订单状态流转 + 取货签字
- `POST /api/orders/:id/ready`（所有片 finished 才允许；boss only）
- `POST /api/orders/:id/pickup`（body: signer_name/phone/signature_base64）
  - 保存签名 png、生成 PDF 交割单、状态 → picked_up、尝试发邮件
- `services/slipPdf.js`：用 pdfkit 生成一页凭证
- `services/mailer.js`：nodemailer SMTP，ENV 未配置则 skip
- **验证**：
  - 单未完成就 ready → 400
  - pickup 成功后 status=picked_up、slip PDF 存在、events 有 pickup 记录
  - 未配 SMTP 时不报错

### T10. 前端接入 API
- 从 `prototype/` 复制到 `frontend/`（保留现有 UI）
- 新增 `frontend/js/api.js`：fetch 包装、token 管理
- 各页面把 `data.js` 的假数据替换为 API 调用
- 新增页面：登录、客户管理
- 修改：老板新建订单改为只选客户 + 传 PDF
- **验证**：浏览器端，用 admin 登录 → 新建客户 → 新建订单（传样品 PDF）→ 工人看到 8 片，点片子能看图；点碎/完成都正确；取货签字完成得 PDF

### T11. 静态服务 + 集成部署
- backend 静态服务 `frontend/`，同源避免 CORS
- `.env.example`
- README 启动步骤
- **验证**：干净 clone、`npm install`、`npm start`，按 README 一路走通

### T12. 端到端手工验收
- 关掉原型服务器，只保留 backend
- 完整跑一遍：老板登录 → 建客户 → 传 PDF → 看工人视图 → 各种操作 → 签字取货
- **验证**：每步都符合预期

## 约束与纪律
- 每个 T 完成立刻用 curl 或 node 脚本验证，失败就回头修
- 不碰邮件、签名之外的"锦上添花"功能（报表、统计、库存等一律不做）
- 遇到阻塞不静默跳过，写入 PLAN.md 末尾"BLOCKED"段
- 所有时间、金额、PII 值用示例数据；真实凭据通过 .env

## 启动
```bash
cd backend && npm install && npm start
# 浏览器：http://localhost:8781
# 老板：admin / admin123
# 工人：worker / worker123
```

## 验证脚本
`backend/scripts/smoke.sh` — 跑一遍 T3/T4/T6/T8/T9 的 curl 链路

## Phase 45：每片玻璃生产标签 PDF（2026-06-09）

### 目标
根据订单和每片玻璃的现有数据，自动生成可打印的生产标签 PDF。标签按一片一页输出，适合先用 PDF 打印验证，后续如需 Zebra/TSC 标签机再扩展为 ZPL/TSPL。

### 数据字段策略
- 已有字段直接使用：
  - 订单：`order_number` 作为 PO、`project_name`、`deadline`、`company`
  - 片：`piece_no`、`size`、`type`、`thickness`、`weight`、`piece_note`、`drawing_path`、`required_steps`
- 缺失字段不新增数据库列：
  - `ORDER` 用 `PO-piece_no`
  - `ROUTE` 暂用 `STANDARD/RUSH`
  - `SHIP` 用订单 `deadline`
  - `SHAPE` 有图纸时显示 `LIBRARY`，否则 `STANDARD`
  - `SUMP`/条码用稳定系统码 `GO-orderId-pieceId-pieceNo`
- 标签会尽量模仿客户照片：顶部订单/PO/ship，客户名大字，片号和尺寸大字，右侧图纸预览/重量/Workflow，底部 Code128 条码和 SUMP 文本。

### P45-T1 后端标签 PDF 服务
- 新增 `backend/services/pieceLabels.js`。
- 使用 PDFKit 生成 4x6 inch 每片一页标签。
- 生成 Code128B 条码，不引入新依赖。
- 支持图纸预览：`drawing_path` 存在时嵌入右侧预览框。
- **验收标准**：
  - 可对整单生成标签 PDF。
  - 可对指定单片/多片生成标签 PDF。
  - PDF 文本包含 PO、客户名、片号、尺寸、Workflow、SUMP。
  - 条码和 SUMP 值稳定，重复生成不会依赖随机业务数据。
- **验证命令**：
  - `node --check backend/services/pieceLabels.js`

### P45-T2 标签 API
- 新增 `POST /api/orders/:id/labels`，仅 boss 可用。
- Body 可选：`{ "piece_ids": [1,2] }`；不传则生成整单所有片。
- 输出保存到 `/uploads/labels/*.pdf`，返回 `label_pdf_path`、`count`、`piece_ids`。
- 写入事件 `piece_labels_generated`。
- **验收标准**：
  - 非法订单 404。
  - 空片/不属于该订单的片返回 400。
  - 生成的 `/uploads/labels/*.pdf` 可通过已登录 boss 下载。
- **验证命令**：
  - `BASE=http://localhost:8783 node scripts/piece-label-qa.js`

### P45-T3 老板订单详情入口
- 在 `boss-order-detail.html` 增加“玻璃标签”工具卡。
- 支持：
  - 打印/下载整单标签
  - 每片单独打印/下载标签
  - 顶部菜单增加“打印玻璃标签”
- **验收标准**：
  - 订单详情页显示标签工具卡。
  - 点击整单标签按钮会调用标签 API 并打开生成 PDF。
  - 点击单片标签按钮只生成 1 张标签。
  - 页面无横向溢出、无 console error。
- **验证命令**：
  - `BASE=http://localhost:8783 node scripts/piece-label-qa.js`

### P45-T4 缓存/i18n/回归
- 更新 i18n 中英文文案。
- 更新 `boss-order-detail.html` 资源 query 和 `sw.js` cache 版本，避免现场继续使用旧页面。
- **验收标准**：
  - `frontend/js/i18n.js` 由 split source 重新生成。
  - `boss-order-detail.html` 和 SW 使用新版本标识。
  - 不影响取货/全选/HOLD 基础流程。
- **验证命令**：
  - `./scripts/build-i18n.sh`
  - `node --check frontend/js/api.js`
  - `node --check frontend/sw.js`
  - `node --check scripts/piece-label-qa.js`
  - `BASE=http://localhost:8783 node scripts/select-all-qa.js`
  - `git diff --check`

### P45 最终验收
- 目标 QA 全部通过。
- 默认服务 `:8781` 健康，并能返回新版 `boss-order-detail.html`/`sw.js`。
- 不写默认生产数据；写入型验证只在 codex QA profile `:8783` 执行。

### P45 验收结果（2026-06-09）
- 后端标签服务完成：`backend/services/pieceLabels.js` 使用 PDFKit 生成 4x6 inch 每片一页标签 PDF，包含 PO/ORDER/ROUTE/SHIP、客户名、片号、尺寸、mm 尺寸、备注、图纸预览、重量、Workflow、Code128 条码和 SUMP。
- 按客户样片二次修版：中部增加 `Glaze In` 和 `>>` 标识，底部增加 `TM/CNC` 生产码和 FAB 旗标；右侧 Workflow、底部 CUT/FAB/RACK/SLOT/条码重新排版，避免互相覆盖；长 PO/订单号在顶部和 CUT 行做显示短化，完整码仍保留在小字 PO、条码和 SUMP 中。
- 按客户原图红框修正：右上角图形不再直接缩小整页图纸，而是用 `sharp` 自动裁出当前玻璃片轮廓并缓存到 `uploads/labels/shape-previews/` 后嵌入标签；RACK/SLOT 后面的线改为水平线。
- 标签 API 完成：`POST /api/orders/:id/labels` 支持整单和指定 `piece_ids`，输出 `/uploads/labels/*.pdf`，并写 `piece_labels_generated` 审计事件。
- 老板订单详情完成：新增“玻璃生产标签”工具卡，支持整单标签和单片标签；顶部菜单新增“打印玻璃标签”。点击时先打开空白页再生成 PDF，降低浏览器弹窗拦截风险。
- i18n/cache 完成：新增中英文标签文案，重建 `frontend/js/i18n.js`，`boss-order-detail.html` 资源 query 更新为 `20260609-piece-labels`，SW cache 更新到 `v52-2026-06-09-piece-labels`。
- 验证通过：
  - `node --check backend/routes/orders.js`
  - `node --check backend/services/pieceLabels.js`
  - `node --check scripts/piece-label-qa.js`
  - `node --check frontend/sw.js`
  - `node --check frontend/js/api.js`
  - `./scripts/build-i18n.sh`
  - boss order detail inline script check
  - `BASE=http://localhost:8783 node scripts/piece-label-qa.js`
  - `BASE=http://localhost:8783 node scripts/select-all-qa.js`
  - `BASE=http://localhost:8783 node scripts/pickup-hold-qa.js`
  - `npm ls --prefix backend sharp --depth=0`
  - `pdftoppm -png -f 1 -l 1 -singlefile -r 160 <latest-label.pdf> /tmp/glassorder-label-qa-latest` 后人工对照样片确认版面无重叠
  - `git diff --check`
- Default service `:8781` restarted to load the new backend route; read-only checks confirmed health, `boss-order-detail.html` serves the new asset query, `sw.js` serves `v52-2026-06-09-piece-labels`, and `/api/orders/999999999/labels` returns JSON `Order not found` without writing default business data.

## Phase 14：车间流程与交付功能更新（2026-06-07）

### 安全与数据隔离
- 正式运行数据已备份到 `backups/20260607-152007`，包含 `glass.db` 和 `uploads/`。
- 本轮开发验证只使用 `ENV_FILE=backend/.env.codex-qa`，对应 `backend/glass-codex-qa.db` 和 `backend/uploads-codex-qa`。
- 回退锚点：本地 `ae6509c Backup glassorder project state`；GitHub 私有备份 `le5875457-max/glassorder@01dfb0d`。

### P14-T1. 打磨工序
- 需求：钢化完成后增加“打磨”工序，默认完整流程改为 `cut -> edge -> tempered -> polish -> finished`。
- 范围：
  - 后端工序常量、推进逻辑、批量完成、片工序配置。
  - SQLite `pieces.stage` CHECK 约束迁移，允许 `polish`。
  - 工人队列、片子网格、老板详情/仪表盘编辑工序、i18n 文案。
- 兼容策略：老订单已有 `process_config` 保持原流程；新订单默认包含打磨。恢复“完整工序”时使用新完整流程。
- 验收：
  - 新建订单的每片 `required_steps` 包含 `polish`。
  - 单片连续推进 4 次后才 `finished`，第三次后状态为 `polish`。
  - 工人端能按“打磨”筛选，队列显示待打磨片。
- 验证命令：
  - `ENV_FILE=backend/.env.codex-qa ./scripts/smoke.sh`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/piece-workflow-qa.js`

### P14-T2. 车间图纸上一片/下一片
- 需求：车间查看图纸时增加上一片/下一片，可左右滑动切换。
- 范围：`frontend/worker-pieces.html` 全屏图纸 viewer、i18n 文案、浏览器 QA。
- 交互策略：保留现有拖动/缩放；全屏图纸增加左右按钮，未明显缩放时横向滑动切换当前视图内上一片/下一片。
- 验收：
  - 打开第 N 片全屏图纸，点击“下一片”显示第 N+1 片标题和图纸。
  - 点击“上一片”返回第 N 片。
  - 首片/末片按钮 disabled，横滑不会越界。
- 验证命令：
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/worker-drawing-qa.js`

### P14-T3. 邮件 CC
- 需求：客户 email addresses 增加抄送 CC。
- 范围：`customers.email_cc` migration、客户 CRUD、搜索、客户页面表单和列表、邮件发送服务、发送事件详情。
- 规则：CC 支持多个邮箱，英文逗号、中文逗号或分号分隔；保存为规范化逗号列表。
- 验收：
  - 新增/编辑客户可保存 `email_cc`。
  - 无效 CC 邮箱返回 400。
  - 重发/取货 slip 调 `sendPickupEmail` 时带 `cc`，SMTP 未配置仍返回 skipped。
- 验证命令：
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/customer-cc-qa.js`

### P14-T4. 全选
- 需求：切片、开切口、钢化选片增加全选；取货时也增加全选。
- 范围：`frontend/worker-pieces.html`、`frontend/pickup-search.html`、i18n 文案、浏览器 QA。
- 规则：
  - 车间选择模式：全选当前视图片子，清空选择；当前视图包括 cut/edge/tempered/polish/all。
  - 取货：按订单分组提供全选/清空，全页提供全选可取片/清空。
- 验收：
  - 车间任一工序点全选后，选中数量等于当前视图片数。
  - 取货页全选后，确认按钮显示全部可取片数量；按订单全选只选择该订单片子。
- 验证命令：
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/select-all-qa.js`

### P14-T5. 公司 Logo 图标
- 需求：PWA 图标改为公司 logo。
- 范围：`scripts/generate-icons.js`、`frontend/icons/*`、`frontend/manifest.json`、`frontend/sw.js`。
- 现状：项目内未找到现成 logo 文件；本轮先用公司名首字母/玻璃品牌样式生成可交付图标，后续拿到正式 logo 可替换源图再重新生成。
- 验收：
  - `icon-192.png`、`icon-512.png`、`icon-maskable-512.png`、`apple-touch-icon.png` 更新。
  - `manifest.json` 引用正常，service worker cache 版本更新。
- 验证命令：
  - `ENV_FILE=backend/.env.codex-qa node scripts/generate-icons.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pwa-install-qa.js`

### P14 完整回归
- `ENV_FILE=backend/.env.codex-qa ./scripts/smoke.sh`
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pickup-batch-smoke.js`
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/browser-qa.js`
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/page-matrix-qa.js`
- `git diff --check -- glassorder`

### P14 验收结果（2026-06-07）
- P14-T1 打磨工序：`piece-workflow-qa.js` 与 `smoke.sh` 通过；新订单默认 `cut -> edge -> tempered -> polish -> finished`，第三次推进后为 `polish`，第四次完成。
- P14-T2 图纸上一片/下一片：`worker-drawing-qa.js` 通过；按钮和真实触摸横滑都能切换片图纸。
- P14-T3 邮件 CC：`customer-cc-qa.js` 通过；新增/编辑/搜索/无效邮箱校验/取货邮件及重发事件均包含 `email_cc`。
- P14-T4 全选：`select-all-qa.js` 通过；车间当前视图全选/清空、取货全页和按订单全选/清空均通过。
- P14-T5 图标：`generate-icons.js` 已更新并生成 192/512/maskable/apple 图标；`pwa-install-qa.js` 通过，SW cache 版本为 `v45-2026-06-07-phase14-icons`。
- 完整回归通过：
  - `ENV_FILE=backend/.env.codex-qa ./scripts/smoke.sh`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pickup-batch-smoke.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pickup-batch-browser-qa.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/browser-qa.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/page-matrix-qa.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/customer-search-qa.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/perf-check-worker.js`
  - `git diff --check -- glassorder`
- QA 服务：`ENV_FILE=backend/.env.codex-qa ./scripts/status.sh` 显示 `http://localhost:8783/api/health -> {"ok":true}`。
- 数据隔离结果：正式库未写入测试业务数据，计数保持 `customers=10, orders=32, pieces=322, pickup_batches=7, pickups=0`；QA 数据写入 `backend/glass-codex-qa.db`。
- 注意：一次中途 schema 检查误用了默认 DB 初始化，正式库已应用本轮非业务 schema migration（`customers.email_cc` 与 `pieces.stage` 支持 `polish`），但没有插入测试客户、订单或片数据；正式数据备份仍在 `backups/20260607-152007`。

## Phase 15：全面 QA / 查缺补漏（2026-06-07）

### 范围
- 后端：API、安全权限、上传、迁移、数据完整性、业务流程和性能自测。
- 前端：移动/桌面页面矩阵、底部导航、固定操作条、窄屏按钮、PWA、动效、图纸滑动、全选和取货批次。
- 数据：继续只使用 `ENV_FILE=backend/.env.codex-qa`；正式库只读复核，不插入测试业务数据。

### P15-T1. QA 脚本可靠性修复
- `scripts/summary-smoke.js` 改为 `admin/worker` 优先、demo 账号兜底，避免 QA 环境未 seed demo 用户时误失败。
- `scripts/browser-qa.js` 的部分取货校验改为使用本轮唯一客户名和 API 返回的剩余片 ID，避免旧 QA 数据干扰页面计数。
- 验收：`summary-smoke.js`、`browser-qa.js` 在 `8783` QA 服务上稳定通过。

### P15-T2. 前端 UI 优化与新增回归
- 新增 `scripts/ui-regression-qa.js`，覆盖 320/390/1280 视口：
  - boss 底部导航页面最后一行必须能滚到导航栏上方。
  - 车间选择模式固定操作条按钮不能裁切、不能横向溢出。
  - 取货页全选/按订单全选和确认操作条不能裁切、不能遮挡签名区。
- 修复发现的问题：移除 `.worker-company` 的 `content-visibility` 高度预估，避免车间列表分组在移动端滚到底部时因延迟展开导致最后一行被固定底部导航遮挡。
- 验收：`ui-regression-qa.js` 通过，且 `page-matrix-qa.js` / `navigation-browser-qa.js` / `motion-browser-qa.js` 仍通过。

### P15-T3. 后端迁移与数据完整性自测
- 在 `/tmp` 临时副本中复制 `backups/20260607-152007/glass.db`，加载当前 `backend/db.js` 执行 migration。
- 验收：
  - 迁移副本业务计数保持 `customers=10, orders=32, pieces=322, pickup_batches=7, pickups=0`。
  - `PRAGMA integrity_check` 返回 `ok`。
  - `PRAGMA foreign_key_check` 返回 0 条。
  - `customers.email_cc` 存在，`pieces.stage` CHECK 允许 `polish`。

### P15-T4. 最终验证命令
- 静态检查：
  - `find backend frontend scripts -path 'backend/node_modules' -prune -o -path 'backend/uploads' -prune -o -path 'backend/uploads-codex-qa' -prune -o -type f -name '*.js' -print0 | xargs -0 -n1 node --check`
  - `find . -path './backend/node_modules' -prune -o -type f -name '*.sh' -print0 | xargs -0 -n1 bash -n`
  - HTML inline script syntax check（17 个 inline script）
  - `git diff --check -- glassorder`
- 后端/API：
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 bash scripts/smoke.sh`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/security-regression.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 bash backend/scripts/zip-upload-smoke.sh`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/summary-smoke.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/piece-workflow-qa.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/customer-cc-qa.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pickup-batch-smoke.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/customer-search-qa.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/perf-check-worker.js`
- 浏览器/UI：
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/browser-qa.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/page-matrix-qa.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/navigation-browser-qa.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/motion-browser-qa.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pwa-install-qa.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/worker-drawing-qa.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/select-all-qa.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pickup-batch-browser-qa.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/ui-regression-qa.js`

### P15 验收结果
- 后端/API 回归全部通过，最终输出 `BACKEND/API REGRESSION PASS`。
- 浏览器/UI 回归全部通过，最终输出 `BROWSER/UI REGRESSION PASS`。
- QA 服务健康：`ENV_FILE=backend/.env.codex-qa bash scripts/status.sh` 返回 `RUNNING` 且 `/api/health -> {"ok":true}`。
- QA 日志错误扫描无 `error/exception/trace/failed/unhandled` 结果。
- 正式库只读复核：计数仍为 `customers=10, orders=32, pieces=322, pickup_batches=7, pickups=0`，`integrity_check=ok`，外键违规 0。
- QA 库完整性：`integrity_check=ok`，外键违规 0；测试数据只存在于 `backend/glass-codex-qa.db`。

## Phase 16：车间图纸滑动手感优化（2026-06-07）

### 需求
- 车间全屏图纸“上一片/下一片”和左右滑动切换不能生硬。
- 手指横向滑动要跟手，未达到阈值时要回弹，不应把图片拖偏；达到阈值时旧图滑出、新图滑入。

### 实现
- `frontend/worker-pieces.html`
  - 新增 `drawingTransition` 状态，切换期间锁定上一片/下一片按钮，避免重复触发。
  - 按钮切换和滑动切换共用 `animateFullDrawingTransition`：克隆旧图作为滑出层，预加载新图后按方向滑入。
  - 适配屏幕比例下的横向手势改为实时跟手；拖动时相邻图纸从侧边同步露出，边界有阻尼；短距离滑动走回弹。
  - 当前图纸加载后预热上一片/下一片图片 URL 与图片对象，减少第一次横滑时的等待感。
  - 放大查看时继续保留原有拖拽/缩放逻辑。
  - 支持 `prefers-reduced-motion`：减少动画时长。
- `frontend/shared.css`
  - 增加全屏图纸转场层的 transform/opacity transition、will-change 和拖动中禁用 transition。
- `scripts/worker-drawing-qa.js`
  - 增强专项 QA：验证按钮切换出现转场层、拖动中会出现相邻图预览层、真实触摸滑动仍能切换、短距离拖动会回弹且不误翻片。

### 验收标准
- 点击“下一片/上一片”时，旧图按方向滑出，新图按方向滑入。
- 手指横滑时当前图跟随手指移动，相邻图纸同步从侧边出现；边界滑动有阻尼。
- 短滑不翻片，并在松手后回到居中/适配位置。
- 放大后的拖拽/缩放功能不回归。
- 移动/桌面页面矩阵和 UI 溢出/遮挡检查不回归。

### 验证结果
- `node` inline script syntax check for `frontend/worker-pieces.html` ✅
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/worker-drawing-qa.js` ✅，最新输出 `WORKER DRAWING QA PASS order=129 title=第 2 片 · 10mm Clear Tempered`
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/page-matrix-qa.js` ✅，输出 `PAGE MATRIX QA PASS checks=30`
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/ui-regression-qa.js` ✅，最新输出 `UI REGRESSION QA PASS checks=18 customer=412 worker_order=131 pickup_order=133`
- `git diff --check -- glassorder` ✅
- QA 服务日志错误关键字扫描无结果 ✅

## 验收状态（2026-05-11）

全部 T1–T12 已实现并通过自动/人工验证。

- T1 Scaffold：`curl /api/health` → `{ok:true}` ✅
- T2 DB：users/customers/orders/pieces/events/pickups/schema_migrations 7 张表；admin + worker 均已 seed ✅
- T3 Auth：正确凭据返回 token；错误凭据 401；worker 调 boss-only 路由 403 ✅
- T4 客户 CRUD：POST/GET/PUT/DELETE 全部跑通，有订单的客户返回 409 ✅
- T5 PDF 解析：样品 PDF 解析出 8 片，piece4 = `30" × 75-1/4"` ✅
- T6 订单创建：multipart 上传样品 PDF → 建 order + 8 pieces + events ✅
- T7 订单/片查询：分页/过滤/详情/按 stage 过滤 pieces 全部跑通 ✅
- T8 片操作：advance / broken(rework=1, stage=cut) / hold / unhold 全部跑通 ✅
- T9 状态流转 + 取货：未完成 ready → 400；完成后 ready → 200；pickup 生成 PDF + PNG 签名，写 pickups 和 events，未配 SMTP 跳过邮件 ✅
- T10 前端：9 个 HTML 页面全部联上 API，登录 / 客户 / 订单 / 工人 / 取货签字 链路打通 ✅
- T11 静态 + 部署：同源静态服务，`.env.example`, README 启动步骤 ✅
- T12 端到端：`npm run smoke` 跑过完整链路（登录 → 客户 → PDF 上传 → 片流转 → ready → pickup → PDF 生成），事件表 28 条（1 created + 24 advance + 1 broken + 1 ready + 1 picked_up）✅

产物校验：
- pickup slip PDF 由 pdfkit 生成，1 页，含 8 片明细、签字人、签名图
- piece drawing 来自 pdftocairo 144dpi JPG，1224×1585，浏览器可直接访问
- DB 最终状态：orders.status='picked_up'，8 pieces.stage='finished'，pickups 表有 1 行

## Phase 2：全面 QA / 前端体验打磨（2026-05-11）

### 执行顺序 & 总体策略
1. Q2（后端目录冲突）→ 导致 smoke 二次跑失败，先修让 smoke 绿；
2. Q1（XSS）→ 改动 9 个 HTML 最大，单次集中处理；
3. Q3/Q7（登录/401 体验）→ 小改动一起做；
4. Q6（worker 页 UX + 退出）→ 简单；
5. Q4/Q5/Q8（确认、时间线、空状态）→ 前端功能增补；
6. smoke.sh 扩展并连跑 2 次验证全部绿。

### Q1. 全前端 XSS 修复（安全）
- 问题：customers/orders/pickups 里的用户输入（company/contact/project_name/signer_name/piece_note 等）直接 innerHTML 注入。已在 QA 中用 `<img onerror=>` 证明可落库并渲染。
- 修法：在 `js/api.js` 提供 `esc(v)` 用于文本，`escAttr(v)` 用于属性；把 9 个 HTML 里的所有模板字面量里的 `${...}` 用户数据改为 escape 后注入。
- **验证**：新建 company 为 `<img src=x onerror=alert(1)>` 的客户 → 在 boss-dashboard / customers / new-order / order-detail 几个入口查看，均原文显示，不触发 alert。curl 返回的 HTML 里应看到 `&lt;img` 字样。

### Q2. 上传与目录健壮性
- 问题：`renameSync(tmp, orders/<order_number>)` 若 FS 有同名残留则 ENOTEMPTY。另外 multer 先存盘再校验 → 校验失败 PDF 残留；filter reject 返回 500 而非 400；无大小上限。
- 修法：
  - 用 DB 自增 id 命名最终目录（`orders/<order_number>-<id>/`），避免 FS 冲突。
  - 任何 error path 先 `fs.rm(req.file.path)` 清理上传 PDF 和 tmp 目录。
  - 把 multer 的 `fileFilter` 错误改成 400；`limits: { fileSize: 25MB }` 超限 413。
- **验证**：
  - 连续两次同 PDF 建单 → 200/200，目录 `2605011-1/`, `2605011-2/` 并存，无 ENOTEMPTY。
  - POST /api/orders 传 txt → 400。
  - customer_id 无效时 `uploads/pdfs/` 不残留。

### Q3. 401 自动登出 + 统一错误提示
- 问题：token 过期后所有请求都 throw 到 toast/alert，用户懵。
- 修法：`api()` 在 401 时 clearSession + `location.href='login.html'`；页面上常用的 `alert()` 替换为 toast（已有），关键 UI 操作出错给可读消息。
- **验证**：手动删掉 localStorage.token → 刷新任意需要登录的页面，跳到 /login.html。

### Q4. 关键操作二次确认
- 问题：`通知可取货` 一键触发状态切换；`确认取货` 一键落地。
- 修法：改为模态确认（用现有 `.modal-backdrop`）。pickup 已有 2 步（签字），再加 "确认取货" 模态过度；ready_pickup 加 "确认发车间通知" 模态。
- **验证**：手动过一遍。

### Q5. 订单详情事件时间线 + 下载凭证
- 问题：boss-order-detail 不展示 events，也不在 picked_up 时显示 slip PDF。
- 修法：列出最近 10 条事件（`action` + `actor_name` + 相对时间），已取货状态突出 slip PDF 下载按钮。
- **验证**：1 单完整走完后，`/orders/:id` 详情页能看到 order_created → piece_advanced × N → order_ready_pickup → order_picked_up 序列；有 "下载取货凭证" 按钮。

### Q6. 片子网格 + 工人工位 UX
- 问题：grid 卡片上的尺寸被 `×…` 截断成无意义字符，分辨不出片子；worker-queue/worker-pieces 没退出登录入口。
- 修法：
  - 卡片显示宽×高（去掉单位保留数字），足以区分；完整信息留在弹窗。
  - 每页 topbar 右侧加 "退出" 按钮（指向 logout）。
- **验证**：浏览器打开 worker-pieces?id=1&stage=all，每张卡片尺寸可辨；topbar 右侧有退出。

### Q7. 登录页不预填 admin 密码、支持表单验证
- 问题：`value="admin"` / `value="admin123"` 预填，生产环境不合适；两个输入缺 required。
- 修法：改成 `placeholder`，加 `required`，回车键提交已支持。
- **验证**：打开 login.html 看到 placeholder 但空白输入；不填提交浏览器原生阻止。

### Q8. 空状态/错误状态统一样式
- 问题：各列表空状态 HTML 风格不一；错误大多直接 alert。
- 修法：统一用 `.empty-state` 样式（图标 + 文字 + 可选 CTA）；错误优先 toast，重大错误模态。
- **验证**：登出后访问需要登录的页 → 登录页；删光客户 → 客户列表出现统一空状态。

### 完成定义
- smoke.sh 继续全绿，**连跑两次**仍然全绿（验证 Q2 目录冲突彻底修复）。
- 手动手测清单（见下）全部打勾。
- 不引入新依赖；保持 vanilla JS、同源部署、单机 SQLite。

### Phase 2 验收（2026-05-11，连跑两次 smoke 全绿）

- Q1 XSS：`esc/escAttr/confirmModal` 入 `js/api.js`；9 个 HTML 的 `innerHTML` 模板里所有 `company/project_name/order_number/piece_note/contact_name/phone/email/notes/deadline/...` 用户数据全部 esc 包裹；Node 沙箱单元验证 `esc('<img src=x onerror=alert(1)>') = '&lt;img...&gt;'`；smoke `customers list` 断言 DB 持久化原值、前端靠 esc() 拦 ✅
- Q2 FS 冲突：`uploads/orders/<order_number>-<dbId>` 保证目录唯一；失败路径 `silentRm(uploadedPdf, tempOutputDir)` 清理；`fail(status, msg)` → 统一 catch 清理；smoke 重复订单 / 非 PDF / 无效 customer_id 三场景全部 400 且 `uploads/pdfs` count 稳定 ✅
- Q3 401 登出：`api()` 遇 401 清 token 并跳 `login.html`（避免死循环：login 接口本身不跳）✅
- Q4 二次确认：通知可取货用 `confirmModal`；取货签字提交前再确认一次；删除客户也走模态 ✅
- Q5 时间线 + slip：`boss-order-detail.html` 加事件时间线（最近 10 条，带 actor_name + 相对时间）；`picked_up` 状态显示「下载取货凭证 PDF」卡片 ✅
- Q6 片卡片 + 退出：`shortSize()` 从 `30" × 75-1/4"` 提取成 `30×75-1/4`；所有 `topbar` 加 `.logout-btn` ✅
- Q7 登录页：去掉 `value="admin/admin123"`，改 `placeholder` + `required` ✅
- Q8 空状态统一：新增 `.empty-state` CSS；customers / boss-dashboard / worker-queue / pickup-search 空状态都用它 ✅
- Q9 smoke 扩展：health / login / xss 客户 / invalid customer / 非 PDF / 正常建单 / 重复建单 / 片流转 / ready / pickup / slip PDF / XSS list 共 12 组断言 ✅

### 手工验收清单
- [x] Q1：建客户 `company=<img src=x onerror=alert(1)>`（smoke 已覆盖），node 沙箱验证 esc() 将其转为 `&lt;img...&gt;`。
- [x] Q2：同一份 PDF 连续建 2 单（smoke `duplicate order` + 每次运行），两次都 201，`uploads/orders/` 下出现 `2605011-1`、`2605011-2-2`、... 独立目录，不报 ENOTEMPTY。
- [x] Q2：POST /api/orders 传 txt，返回 400。
- [x] Q2：customer_id 无效返回 400，PDF 和 tmp dir 清理（`PRE_PDF == POST_PDF`）。
- [x] Q3：浏览器手测 — 抹掉 `localStorage.glassorder_token` 后访问 boss-dashboard，跳 `login.html`。（Phase 12 已由 `node scripts/browser-qa.js` 自动化覆盖）
- [x] Q4/Q5/Q6/Q7/Q8：browser 场景人工巡检（Phase 12 已由 `node scripts/browser-qa.js` 自动化覆盖）。



## Phase 3：核心功能补齐（2026-05-17）

### 新需求范围
1. 中文/英文界面切换。
2. 工人流程支持按玻璃片跳过工序：部分玻璃不需要钢化，部分玻璃不需要开口/其他常规步骤。
3. 同一订单内玻璃可多选批量处理。
4. 管理员可修改已完成订单信息，用于纠错。
5. 客户管理提供一键发送交割单到客户邮箱。
6. 使用 `glassorder-20260517T053732Z-3-001.zip` 中的订单 PDF 验证上传生成订单。
7. 同一订单文件不能重复上传。

### 执行计划

#### P3-T1. 数据模型与迁移
- 增加 `orders.source_file_hash`、`orders.original_filename`，对 PDF 文件 hash 做唯一约束，防止同一订单文件重复上传。
- 增加 `pieces.process_config`、`pieces.completed_steps`，用于记录每片玻璃所需工序与已完成工序。
- 保留旧 `stage` 字段用于列表筛选兼容，新增逻辑根据所需工序推进。
- **验收**：老库启动自动迁移；重复上传同一个 PDF 返回 409；旧 smoke 仍可创建订单。
- **验证命令**：`cd backend && npm run smoke`。

#### P3-T2. 工序配置、单片与批量操作 API
- 新增/扩展片子 API：
  - `PATCH /api/pieces/:id/process-config` 修改单片所需工序。
  - `POST /api/pieces/batch` 批量 `advance` / `complete` / `hold` / `unhold` / `broken` / `set_process_config`。
- 默认流程：`cut -> edge -> tempered -> finished`；若不需要某工序，推进时自动跳过。
- 所有批量操作写入 events。
- **验收**：设置某片不需要 `tempered` 后，从 `edge` advance 直接到 `finished`；批量完成同一订单多片成功。
- **验证命令**：新增 smoke 断言批量与跳过工序。

#### P3-T3. 管理员修改已完成订单
- 新增 `PATCH /api/orders/:id`，boss 可修改订单/customer/project/priority/deadline/note 和片子尺寸、类型、厚度、重量、备注、工序配置。
- 已取货/已完成订单也允许 boss 修改，并写 `order_updated` / `piece_updated` events。
- **验收**：`picked_up` 订单可修改 note/project；详情 API 返回新值并有事件。
- **验证命令**：smoke 在 pickup 后调用 PATCH 并断言。

#### P3-T4. 交割单邮件重发
- 新增 `POST /api/orders/:id/send-slip`，boss 可一键把最近 pickup slip 发到客户邮箱。
- SMTP 未配置时返回 `skipped`，但不报错；无客户邮箱或无交割单返回明确 400。
- **验收**：已取货订单调用成功；未取货订单返回 400。
- **验证命令**：smoke pickup 后调用 send-slip。

#### P3-T5. 前端中文/英文与操作体验
- `frontend/js/i18n.js` 提供中英文词典、语言持久化和页面翻译。
- 各主页面加入语言切换入口，关键按钮/标题/状态使用翻译。
- 工人订单/片子页面加入多选与批量操作；订单详情支持 boss 编辑完成订单与片子工序配置；客户列表加入发送交割单入口。
- **验收**：刷新后语言保持；worker 页面可多选批量处理；boss 详情页可编辑已取货订单。
- **验证命令**：静态页面 curl 200；最小 DOM/JS smoke 检查关键文件存在。

#### P3-T6. ZIP 内 PDF 批量上传验证
- 解压 `glassorder-20260517T053732Z-3-001.zip` 到临时目录，收集其中 PDF。
- 用脚本逐个上传，确认每个可生成订单；同一文件第二次上传返回 409。
- **验收**：ZIP 内 PDF 均能上传生成订单，重复上传被拒绝。
- **验证命令**：`./scripts/smoke.sh` 和补充 zip 上传验证脚本。

### Phase 3 完成定义
- `npm run smoke` 全绿。
- 新增重复 PDF、跳过工序、批量操作、完成订单编辑、send-slip 验证均通过。
- `glassorder-20260517T053732Z-3-001.zip` 内 PDF 至少完成一次批量上传验证，并确认重复上传被拒绝。
- 不引入与需求无关功能。

### Phase 3 验收记录（2026-05-17）

- P3-T1 数据迁移：`orders.source_file_hash/original_filename`、`pieces.process_config/completed_steps` 自动迁移；同 PDF 内容重复上传返回 409；重复失败路径清理临时 PDF ✅
- P3-T2 工序配置与批量 API：单片 `PATCH /api/pieces/:id/process-config`；批量 `POST /api/pieces/batch`；验证了跳过钢化后 `cut -> edge -> finished`，以及批量 complete 多片 ✅
- P3-T3 完成订单编辑：`PATCH /api/orders/:id` 可在 `picked_up` 后修改订单与片子备注/工序，写入事件 ✅
- P3-T4 交割单重发：`POST /api/orders/:id/send-slip` 与 `POST /api/customers/:id/send-slip`；SMTP 未配置返回 skipped，不阻塞流程 ✅
- P3-T5 前端：新增 `frontend/js/i18n.js` 与语言切换按钮；worker 片子页支持多选、批量完成/HOLD/碎片、批量设置不需要开口/钢化；订单详情支持编辑已完成订单与发送交割单；客户页支持一键发送最近交割单 ✅
- P3-T6 ZIP PDF：修复 `pdfParser`，支持数量行在材料行前后两种格式；`glassorder-20260517T053732Z-3-001.zip` 内 11 个 PDF 全部解析，内容重复的 3 个按 hash 被 409 拒绝 ✅

验证命令已通过：
```bash
node -c backend/db.js && node -c backend/services/pdfParser.js && node -c backend/services/pieceWorkflow.js && node -c backend/routes/orders.js && node -c backend/routes/pieces.js && node -c backend/routes/customers.js && node -c frontend/js/api.js && node -c frontend/js/i18n.js
./scripts/smoke.sh
BASE=http://localhost:8781 backend/scripts/zip-upload-smoke.sh
./scripts/status.sh
```

最终状态：服务稳定运行在 `http://localhost:8781`，健康检查返回 `{"ok":true}`。

## Phase 4：i18n 补齐 + UX 单手操作精修（2026-05-17）

### 背景
- 用户反馈：i18n 不彻底，9 HTML + 2 JS 还有 ~277 行硬编码中文；中文已较彻底，主要补 EN。
- 用户反馈：新增功能后按钮过多，工人/老板/客户三处密度过高，需精简到「单手大拇指可达」。

### 设计原则（贯穿全部页面）
1. 每屏只允许 1 个彩色主按钮，其余灰色或藏 ⋯ 菜单。
2. 主按钮固定底部右半区（拇指自然落点），左半永远是返回。
3. 多选/编辑这类「模式」由顶部一个开关进入，进入后底部才出现批量主按钮。
4. 冷门操作折进 ⋯ 菜单，避免与热操作抢眼球。
5. 不动后端 API、不动数据模型；纯前端重排 + i18n 补齐。

### 任务

#### P4-T1. i18n 基础设施
- `frontend/js/i18n.js` 词典扩到全量（~140 key），按 common/auth/status/stages/units/events/time/empty/toast 分组。
- 新增 `tn(template, vars)` 处理 `"X 片 · 计划 Y"` 这类带变量的串。
- 新增 `relativeTime(s)` 按当前语言返回。
- `frontend/js/api.js` 内 `STAGE_ZH` 改成 `stageLabel(stage)` 走 `t()`；`statusBadge`、`confirmModal`、`api()` 错误兜底文案全走 `t()`。
- **验收**：切到 EN 后任何其他页面都未变前 grep 已能看到 i18n.js 含完整 key；`node -c` 通过。
- **验证命令**：`node -c frontend/js/api.js frontend/js/i18n.js`。

#### P4-T2. 简单页 i18n（5 页）
- `index.html` / `login.html` / `pickup-search.html` / `worker-queue.html` / `customers.html` 中所有硬编码中文换成 `data-i18n` 或 `t()` 调用。
- **验收**：5 个页面切到 EN 后无中文残留；切回 ZH 不丢词。
- **验证命令**：浏览器或 curl HTML + 切语言 grep。

#### P4-T3. 中等页 i18n（4 页）
- `boss-dashboard.html` / `boss-new-order.html` / `pickup-sign.html` / `pickup-slip.html` 全量 i18n。
- **验收**：同上。

#### P4-T4. 复杂页 i18n（2 页）
- `boss-order-detail.html`：`ACTION_LABEL` 14 个事件名走 i18n；相对时间走 `relativeTime`；编辑模态字段标签全部 i18n。
- `worker-pieces.html`：图例、统计行、状态文案、按钮、toast、broken modal、drawing modal、所有 sub-strings。
- **验收**：两个页面切到 EN 后 grep 无中文（除常量数据）。

#### P4-T5. UX 全局基础
- `frontend/shared.css` 加 `.menu-pop` 弹出菜单样式。
- `frontend/js/api.js` 加 `popMenu(anchor, items)` 工具函数（点空白处自动关闭、点 item 触发 callback）。
- 统一 action-bar 主按钮 `flex: 2`，返回按钮 `flex: 1`，主按钮加大圆角更显眼。
- **验收**：菜单可在任意页测试出现/消失；`node -c` 通过。

#### P4-T6. customers 页精简
- 表单默认折叠为顶部 `+ 新增客户` 按钮，点击展开；保存或取消后收起。
- 每行只剩一个主按钮 `📧 发送邮件`（无邮箱时灰），尾部 ⋯ 菜单收 `修改/删除`。
- **验收**：移动尺寸（375px 宽）下每行不超出。

#### P4-T7. boss-order-detail 精简
- 删除中段「修改订单」卡（`renderEditCard`）。
- 顶部 topbar 右侧加 ⋯ 菜单：`修改订单 / 发送交割单 / 下载 PDF`。
- 底部 action-bar 永远 2 按钮：左 `返回`，右 1 个状态相关主按钮（生产中=查看车间 / 100%=通知可取货 / ready=取货签字 / picked_up=重发交割单）。
- **验收**：`actions` div 内 button 数量永远 ≤ 2。

#### P4-T8. worker-pieces 精简
- 删除中段永久批量面板。
- 顶部 topbar 加 `选择` 开关按钮，进入选择模式后卡片显示勾选；底部 action-bar 切到「批量栏」：`取消 / ✅ 批量完成 (n) / ⋯`。
- ⋯ 菜单收 `批量 HOLD / 解除 HOLD / 批量碎片 / 不需要开口 / 不需要钢化`。
- 单片弹窗主操作压缩到 3：`✅ 完成 / 💥 碎了 / ⏸ HOLD`；「不需要钢化/开口」改为底部小字链接。
- 默认底部 action-bar：左 `返回`，右 `📋 选择`。
- **验收**：默认进入页面屏幕中段无任何操作按钮；选中片后底部出现批量栏。

#### P4-T9. 完整验证
- `node -c` 所有改动文件。
- `./scripts/smoke.sh` 全绿。
- `BASE=http://localhost:8781 backend/scripts/zip-upload-smoke.sh` 全绿。
- 双语 grep 检查：浏览器分别用 ZH/EN 模式抓 HTML 后扫描；ZH 不丢词、EN 无中文残留。
- 手测拇指可达：worker-pieces / boss-order-detail / customers 移动尺寸下底部主按钮 56px 以上，单手能按到。

### Phase 4 完成定义
- 所有 task 验收命令通过。
- smoke + zip-smoke 双绿。
- 任何前端页面切到 EN 后用 `grep -P '[\x{4e00}-\x{9fff}]'` 仅命中 i18n 字典本体，没有未翻译串。
- 后端 API、smoke 脚本、数据模型 0 改动。

### Phase 4 验收记录（2026-05-17）

- P4-T1 i18n 基础设施：`i18n.js` 词典扩到 ~190 key（zh/en），新增 `tn(template, vars)`、`stageLabel(stage)`、`eventLabel(action)`、`relativeTime(s)`；`api.js` 内 `STAGE_ZH` 改为代理走 i18n、`statusBadge / confirmModal / api()` 错误兜底全部走 `t()`；`onLangChange` 钩子让切语言能触发各页重渲染 ✅
- P4-T2 简单页 i18n：`login.html / index.html / pickup-search.html / worker-queue.html / customers.html` 全量 `data-i18n` 接入 ✅
- P4-T3 中等页 i18n：`boss-dashboard.html / boss-new-order.html / pickup-sign.html / pickup-slip.html` 全量接入；统计卡、筛选 chips、空状态、相对时间、确认弹窗均 i18n 化 ✅
- P4-T4 复杂页 i18n：`boss-order-detail.html` 14 个事件名走 `eventLabel()`、相对时间走 `relativeTime()`；`worker-pieces.html` 图例、统计、状态文案、按钮、toast、broken modal、drawing modal 全量 i18n ✅
- P4-T5 UX 全局基础：`shared.css` 加 `.menu-pop / .menu-trigger / .add-trigger / .select-btn / .link-action / .collapsed-form` 与 action-bar 拇指区规则；`api.js` 加 `popMenu(anchor, items)` 工具函数（含 ESC / 外点关闭、divider、disabled、danger） ✅
- P4-T6 customers 精简：表单默认折叠，`+ 新增客户` 按钮触发展开；每行只剩 `📧 发送邮件` 主按钮 + ⋯ 菜单（编辑/删除）；无邮箱时主按钮半透明 ✅
- P4-T7 boss-order-detail 精简：删除中段 `renderEditCard` 卡片；topbar 加 ⋯ 菜单（修改订单 / 已取货时显示发送交割单）；底部 action-bar 永远 ≤ 2 按钮，按状态四选一 ✅
- P4-T8 worker-pieces 精简：删除中段永久批量面板；topbar 加 `选择` 切换按钮，进入选择模式后底部变成 `取消 / 批量完成 (n) / ⋯`；⋯ 菜单收纳 HOLD / 解除 / 不需要开口 / 不需要钢化 / 批量碎片；单片弹窗主操作压缩到 3（完成/碎/HOLD），「不需要钢化/开口」降级为弹窗底部小字链接 ✅
- P4-T9 完整验证：`./scripts/smoke.sh` 32 步全绿；`backend/scripts/zip-upload-smoke.sh` 11/11 全绿；`node -c frontend/js/api.js frontend/js/i18n.js` 通过；EN 渲染模拟脚本扫描 11 个 HTML 0 漏译；服务在 `http://localhost:8781` 健康 ✅

最终 EN 渲染漏译扫描：
```bash
node -e 'const fs=require("fs"); const files=[...]; /* 删除 data-i18n fallback 后再 grep 中文 */'
done.   # 0 leaks
```

服务持续运行：`{"ok":true}` on :8781。

## Phase 5：上线前 QA（2026-05-17）

### QA 范围
覆盖六个维度：自动化测试基线、后端 API 边界、前端代码审计、双语抽样、部署可复现、上线就绪报告。

### QA 任务

#### QA-1. 自动化测试基线
- `./scripts/smoke.sh` × 2 轮，每轮 32/32 步绿。
- `BASE=http://localhost:8781 backend/scripts/zip-upload-smoke.sh` 11/11 全绿。
- `node -c` 全部前后端 JS 文件通过。
- 服务健康 `{"ok":true}` on :8781。

#### QA-2. 后端 API 边界
覆盖 25 个攻击/异常场景：
- 认证：错密码 401、缺 body 400、未带 token 401、伪造 token 401、boss-only 用 worker token 403。
- 注入/异常：SQL inject 不走通；非法 JSON 400；非 PDF 400；非法 customer_id 400；负数 page/limit；超大 limit。
- 业务：piece batch 空数组/未知 action 400、未知 piece id 404、`set_process_config` 空/非法 step 自动兜底为默认 3 步、PATCH 未知 order id 404、send-slip 非 picked_up 400。
- 资源清理：临时 PDF/上传目录在错误路径被清理。
- **发现并修复 2 个 bug**（见下）。

#### QA-3. 前端代码审计
- 9 个 onLangChange 钩子全部就位（修了 index.html 的作用域问题：函数声明在 `if {}` 内，外层 setLang 拿不到 → 改为外层 `let onLangChange = null` + 内层赋值）。
- popMenu 内存泄漏修复：用 `_popMenuClose` 单例引用，再次调用时显式解绑监听器。
- XSS 模板扫描：所有用户输入字段（company、project_name、piece_note、signer_name 等）均通过 `esc()/escAttr()`；数字 ID 直插安全。
- popMenu 动作菜单的 disabled、ESC 关闭、外点关闭、divider 行为人工跑通。

#### QA-4. 双语抽样
- 字典 zh / en 各 262 key 完全对齐（脚本扫描 0 missing）。
- HTML/JS 中实际使用 94 key，全部命中字典。
- 抽样验证关键文案 EN 翻译合理：`Cut / Notching / Tempering / Finished` 工厂术语；`Picked up / Rework / Slip emailed` 通顺。
- 模拟 EN 渲染（删 data-i18n fallback 后扫描）：0 漏译。

#### QA-5. 部署可复现
- 冷启动：删掉 db 后 `./scripts/start.sh` 自动 `npm install`、写随机 JWT_SECRET 到 `.env`、建 7 张表、seed admin/worker、健康通过。
- `.gitignore` 完整：`node_modules / backend/.env / glass.db* / uploads / logs` 都已忽略。
- `.env.example` 配齐 SMTP 选项；未配置时 send-slip 路径走 `skipped`，不阻塞。
- 启停 `start.sh / stop.sh / restart.sh / status.sh / logs.sh / smoke.sh` 全部就绪。

#### QA-6. 出报告
本节即为报告。

### QA 发现 & 修复

#### Bug 1：删除有订单的客户返回 500（应 409）
- **症状**：FK 约束触发后，`err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY'` 不命中，因 SQLite 实际抛 `SQLITE_CONSTRAINT_TRIGGER`。
- **修复**：`backend/routes/customers.js` 在 DELETE 前先 `SELECT COUNT(*) FROM orders WHERE customer_id` 预检；catch 也改为 `code.startsWith('SQLITE_CONSTRAINT')` 通用前缀。
- **验证**：现在删除有订单的客户返回 409，无订单的返回 200。

#### Bug 2：邮箱字段不验证格式
- **症状**：`POST/PUT /api/customers` 接受任意字符串作为 email，后续 send-slip 才报错。
- **修复**：新增 `validateEmail()`（基本 RFC：`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`），POST 与 PUT 都用，无效返回 400。
- **验证**：`{"company":"X","email":"not-an-email"}` 返回 400；`x@y.com` 返回 201。

### 上线建议（非阻塞）
1. **JWT_SECRET 已自动随机化**首启时生成，但若将 db.git 同步到生产前，建议手动 `rm backend/.env` 让生产首启重新生成。
2. **SMTP 配置**：若生产需要自动发送交割单，填 `backend/.env` 中 SMTP_HOST/PORT/USER/PASS/FROM 即可，无需改代码。
3. **HTTPS**：当前代码同源服务，建议反代到 Nginx/Caddy 做 TLS。
4. **前端域名**：`API_BASE` 在 `frontend/js/api.js` 留空（同源）；如分离部署需改成绝对 URL。
5. **批量按钮 UX 微调（非阻塞）**：worker-pieces 选择模式下，未选片时 ⋯ 菜单仍可打开。可后续追加 `disabled` 视觉提示，但不影响功能（菜单内动作会 toast 提示选片）。

### Phase 5 完成定义
- 所有 QA 任务通过。
- 发现的 2 个真 bug 已修复并通过回归。
- smoke + zip-smoke 双绿。
- 服务在 :8781 健康运行。

### Phase 5 验收记录（2026-05-17）

- QA-1 测试基线：smoke 32/32 × 2 轮全绿；zip-smoke 11/11；node -c 全过 ✅
- QA-2 后端边界：25 个边界场景全过；发现 2 bug 已修；email 格式 + FK delete 现按预期返回 ✅
- QA-3 前端审计：onLangChange 作用域修复（index.html）；popMenu listener 泄漏修复；XSS 0 漏 ✅
- QA-4 双语抽样：字典 262/262 对齐；HTML/JS 使用 94 key 全命中；EN 渲染 0 漏 ✅
- QA-5 部署可复现：冷启动建 7 表 + seed + 登录通过；`.gitignore` 完整；`.env` 自动随机 secret ✅
- QA-6 报告：本节 ✅

### 上线前最终验证
```bash
./scripts/restart.sh
./scripts/smoke.sh                                           # 32 OK
BASE=http://localhost:8781 backend/scripts/zip-upload-smoke.sh  # 11/11
./scripts/status.sh                                          # RUNNING + healthy
```

**Verdict: 可以上线** — 主流程全过，2 个发现的 bug 已修复并回归，前后端代码审计无遗留问题。

## Phase 6：视觉精修（2026-05-17）

### 背景
QA 通过、功能已交付，但用户反馈 UI 有「廉价感」。诊断：
1. 配色饱和度过高，多个原色互相竞争（`#2563eb` `#dc2626` `#059669` `#d97706` 同屏出现）。
2. emoji 当主图标，渲染漂移、色彩失控（`🔥 ✅ 💥 ⏸ 🔴 ⚠️ 📦 🧩 ✂️ 🔧 ✨` 满屏）。
3. 卡片靠 1px 边框堆叠，扁平无层次。
4. 字体仅 `-apple-system` 系统栈，数字非等宽，标题字重不够。
5. 圆角与间距硬编码，节奏不齐（10/12/14/16/18 全有）。

不动后端、不动 i18n 字典 key、不动功能。

### 设计 token

```
颜色（降饱和）
- 文字：text-1 #18181b / text-2 #52525b / text-3 #a1a1aa
- 背景：bg-base #fafaf9（暖白）
- 卡片：#ffffff
- 边框：border-1 #e4e4e7 / border-2 #f4f4f5
- 主品牌：brand #18181b（中性深灰当主色）+ accent #4f46e5（仅小面积强调）
- 状态：success #0d9488 / warn #b45309 / danger #b91c1c / info #1e3a8a

阴影
- shadow-sm: 0 1px 2px rgba(15,15,20,.04), 0 1px 1px rgba(15,15,20,.03)
- shadow-md: 0 4px 12px rgba(15,15,20,.06), 0 1px 2px rgba(15,15,20,.04)
- shadow-lg: 0 12px 32px rgba(15,15,20,.10), 0 4px 8px rgba(15,15,20,.04)

圆角
- radius-sm 8 (控件) / radius-md 12 (卡片) / radius-lg 16 (模态)

间距系统：4 的倍数（4/8/12/16/20/24）

字体
- 主栈：-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif
- 数字：font-feature-settings: "tnum" 1, "ss01" 1
- 标题：letter-spacing: -0.02em
```

### 任务

#### P6-T1. shared.css 重写（基础层）
- 定义 CSS 变量（--text-1 / --bg / --shadow-sm 等）。
- 字体栈调整 + 数字等宽 feature。
- 全局 background 改 `#fafaf9` 暖白。
- **验收**：`node -c` n/a；`curl shared.css` 200。

#### P6-T2. emoji 清理
- 删除 i18n 字典中除 `🔥 ⏰` 之外的全部 emoji（zh + en 一并）。
- HTML 中的 emoji 图标改为：状态点（`<span class="dot dot-rework"></span>`）、文字（`Done` `In Production`）、或 SVG。
- 单片弹窗/批量弹窗按钮内的 `✅ 💥 ⏸` 全部去掉。
- **验收**：`grep -P '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' frontend/*.html frontend/js/*.js` 仅命中保留的两个。

#### P6-T3. topbar / action-bar 视觉升级
- topbar：背景 `rgba(255,255,255,.92)` + `backdrop-filter: blur(20px)`；底部 hairline 用 `box-shadow: 0 0.5px 0 rgba(15,15,20,.08)` 替代纯灰线。
- action-bar：同样 backdrop-filter；按钮去掉 `.btn-warn` 模糊语义，统一深色主按钮。
- 主按钮：黑灰主色 + `shadow-sm`，:active 下沉 `translateY(1px)`。
- ghost 按钮：`border 1px solid var(--border-1)`，文字 `var(--text-1)`。
- **验收**：浏览器观感—顶部 sticky 时透出底色但不糊；按钮按下有反馈。

#### P6-T4. card / badge / piece 视觉升级
- card：去掉 1px 边框，改 `shadow-sm`；hover/active 升 `shadow-md`。
- badge：8 种状态降饱和（`bg-#fef2f2 text-#b91c1c` 风），动画类 `pulse` 改更柔和。
- piece 网格格子：底层加 1px 半透明边框 + 浅 inset 投影；selected outline 从 3px 改 1.5px + ring 色更淡。
- **验收**：worker-pieces 网格视觉不刺眼；boss-dashboard 列表卡片有层次。

#### P6-T5. 表单 / 模态 / 进度条精修
- 表单：`form-input` 边框 2px → 1.5px；focus 用 `box-shadow: 0 0 0 4px rgba(79,70,229,.12)` 替代 border 跳变。
- 模态遮罩：`rgba(15,15,20,.4)` + `backdrop-filter: blur(2px)`；模态本体加 `shadow-lg`。
- 进度条：高 8 → 6px；背景 `var(--border-2)`；填充加 `border-radius: 999px` 让头尾圆。
- 签名框：虚线 → 1.5px solid `var(--border-1)`；背景 `#fdfdfc`。
- **验收**：登录、新建订单、签字、确认弹窗、删除确认全部观感不刺眼。

#### P6-T6. inline style 整合
- 11 个 HTML 内重复的颜色硬编码（`#6b7280 #111827 #2563eb #f9fafb` 等）尽量替换成 var() 引用。
- 标题和数字字号统一用 token：`text-xs 11 / text-sm 13 / text-base 15 / text-lg 18 / text-xl 22 / text-2xl 28`。
- **验收**：`grep '#[0-9a-f]\{6\}' frontend/*.html` 数量明显下降；视觉无回归。

#### P6-T7. 完整验证
- `./scripts/smoke.sh` 32/32 全绿。
- `BASE=http://localhost:8781 backend/scripts/zip-upload-smoke.sh` 11/11。
- 11 个静态页 200。
- 双语切换 OK（lang-btn 仍可用）。
- 浏览器人工巡检：登录 → 仪表盘 → 新建订单 → 工人网格 → 单片弹窗 → 取货签字 → 凭证。

### Phase 6 完成定义
- 所有 task 验收命令通过。
- emoji 数量从 67 处压到个位数。
- 字典 key 数与 HTML/JS 引用 key 数依然完全对齐。
- 后端 0 改动；功能 0 回归。

### Phase 6 验收记录（2026-05-17）

- P6-T1 shared.css 重写：CSS 变量（21 个 token）+ 字体栈 + 等宽数字 + 间距/圆角节奏；新增 `.stat-tile / .dot / .swatch / .stage-tab.active` 等组件类 ✅
- P6-T2 emoji 清理：i18n.js 字典从 17 处 emoji 压到 8 处（仅 🔥 ⏰ 保留）；HTML/JS 文件从 50 处压到 4 处 fallback；总从 67 → 12（保留语义上必要的 rush/overdue）✅
- P6-T3 topbar/action-bar：`backdrop-filter: blur(20px)` 半透明 + `box-shadow: 0 0.5px 0` hairline；主按钮 `var(--brand)` 黑灰色 + `:active` 下沉 ✅
- P6-T4 card/badge/piece：card 去边框走 `shadow-sm`；badge 8 种状态全部走降饱和的 soft 变量；piece 选中态 `outline: 1.5px + ring 4px` ✅
- P6-T5 form/modal/progress：form-input border 1.5px + focus ring `box-shadow 4px accent-soft`；modal 遮罩 blur(2px)；progress 高 6px + 圆头 ✅
- P6-T6 inline style 整合：HTML 内硬编码 hex 从 91 处压到 6 处（剩余的全是 Canvas API 与图例数组的合理硬编码）；4 个 dashboard tile 改 `.stat-tile` ✅
- P6-T7 完整验证：smoke 32/32、zip 11/11、14 个静态资源 200、字典 zh/en 262 完全对齐 ✅

视觉总览：
- 主色 `#2563eb` 蓝退到 `#18181b` 黑灰，仅在小面积焦点态用 `#4f46e5` 紫
- 状态色全部降饱和：red `#dc2626 → #b91c1c`、green `#059669 → #0d9488`、amber `#d97706 → #b45309`
- 背景从纯灰 `#f3f4f6` 换为暖白 `#fafaf9`
- 字体加 `tnum + ss01` 数字等宽 feature；标题加 `letter-spacing: -0.02em`
- 卡片用 `shadow-sm` 替代 1px 边框，扁平变层次

最终命令：
```bash
./scripts/smoke.sh                                              # SMOKE PASS
BASE=http://localhost:8781 backend/scripts/zip-upload-smoke.sh  # 11/11
node -c frontend/js/api.js frontend/js/i18n.js                  # OK
```

服务持续运行：`{"ok":true}` on :8781。

## Phase 7：生产硬化 + 体验补强（2026-05-17）

### 任务（4 红 + 5 黄）

- **P7-T1 helmet 安全头**：`X-Frame-Options / X-Content-Type-Options / Referrer-Policy` 等
- **P7-T2 登录限流**：`/api/auth/login` 5 次/分钟/IP，超出 429
- **P7-T3 JWT_SECRET 严格校验**：缺失/长度<16 时启动失败
- **P7-T4 uploads 归档脚本**：90 天前 picked_up 订单移 archive
- **P7-T5 PDF 解析兜底 422**：解析异常返 422 而非 500
- **P7-T6 撤销取货 API**：`POST /api/orders/:id/revert-pickup`，写 pickup_reverted 事件
- **P7-T7 worker-queue hero 数字**：顶部「当前工序 N 片待做」
- **P7-T8 静态资源缓存**：CSS/JS max-age=3600 must-revalidate
- **P7-T9 i18n 字典模块拆分**：674 行拆 zh.js/en.js/core.js
- **P7-T10 完整验证**：smoke 33+ / zip 11 / 安全头 / 限流 / cache

### 完成定义
- 9 项任务通过；smoke + zip 双绿；服务 :8781 健康。

### Phase 7 验收记录（2026-05-17）

- P7-T1 helmet：`X-Frame-Options: SAMEORIGIN / X-Content-Type-Options: nosniff / Referrer-Policy: no-referrer` 已就位；CSP 暂关（前端 inline script）✅
- P7-T2 限流：`/api/auth/login` 5 次/分钟/IP；第 6 次 429；smoke 不受影响（skipSuccessfulRequests）；逃生口 `DISABLE_LOGIN_RATE_LIMIT=1` ✅
- P7-T3 JWT secret：缺失或长度 < 16 → 启动失败；现网由 `start.sh` 自动生成 64 字符 secret ✅
- P7-T4 uploads 归档：`scripts/archive-old-orders.sh` 默认 dry-run；`--apply` 把目录打 zip 移到 archive；events 写 `order_archived`；用 9 个订单实测通过并完整复原 ✅
- P7-T5 PDF 解析兜底：parsePdf 异常或 0 片返 422 + `PDF parsing failed: <reason>`；5 字节假 PDF 验证返 422 ✅
- P7-T6 撤销取货：`POST /api/orders/:id/revert-pickup`（boss）；状态回滚 + `pickup_reverted` 事件 + 保留 pickups 行；前端 ⋯ 菜单项；smoke 加 3 步断言 ✅
- P7-T7 worker 首屏汇总：顶部 hero `48px` 数字 + `myPendingN` 副标题；切 stage 后联动 ✅
- P7-T8 静态缓存：`shared.css / *.js` 走 1h must-revalidate；HTML 走 no-cache（实时上线）✅
- P7-T9 i18n 拆分：源文件拆 `js/i18n/{zh,en,core}.js` 共 685 行；`scripts/build-i18n.sh` 一键拼接出运行时 i18n.js；zh/en 各 267 key 对齐 ✅
- P7-T10 完整验证：smoke 35/35 双轮、zip 11/11、14 静态资源 200、安全头 3 项、cache 分级正确、限流 6 次手测 401×5 + 429 ✅

### 上线前最终状态
```
后端依赖：12（新增 helmet, express-rate-limit）
前端 LOC：3375（含 i18n 拆分后总规模）
i18n keys：zh 267 / en 267 完全对齐
smoke：35/35 全绿（×2 轮）
zip-smoke：11/11 全绿
安全头：3 项命中
登录限流：5 次/分钟/IP，第 6 次 429
JWT_SECRET：缺失/短启动失败；start.sh 自动随机化
uploads：归档脚本可用，默认 dry-run
PDF 解析：异常返 422 + 友好 message
revert-pickup：API + 前端菜单 + 审计事件
工人首屏：hero 大数字 + stage 联动
静态缓存：CSS/JS 1h，HTML 实时
```

服务持续运行：`{"ok":true}` on :8781。可上线。

## Phase 8：长期执行模式 — 核心功能交付闭环 + 性能验收（2026-05-19）

### 当前目标
完成并验证玻璃厂订单系统的核心交付闭环，确保项目可运行、可验证、可交付；不新增无关功能。

### 项目结构快照
- `backend/`：Express API、SQLite 初始化、认证、客户/订单/片子路由、PDF 解析、交割单 PDF、邮件服务。
- `frontend/`：同源静态前端，vanilla JS 页面，PWA service worker，中文/英文 i18n。
- `scripts/`：启动、停止、重启、状态、日志、smoke、归档、i18n 构建脚本。
- `backend/scripts/`：后端 smoke 与 ZIP 上传验证。
- `memory/`：本地执行记录。

### Phase 8 任务

#### P8-T1. 计划与端口一致性
- 修正 `PLAN.md` 历史 `8782` 描述为当前默认端口 `8781`。
- 确认 `README.md`、`backend/server.js`、`backend/scripts/*.sh`、`scripts/*.sh` 对默认端口一致。
- **验收标准**：项目文档和脚本默认端口不再互相冲突。
- **验证命令**：
```bash
rg -n "8782" README.md backend scripts frontend -S
rg -n "localhost:8781|PORT=8781|process.env.PORT \\|\\| 8781" README.md backend scripts frontend -S
```

#### P8-T2. 核心 API 与业务流验收
- 覆盖登录、客户 CRUD、PDF 上传、重复文件拒绝、PDF 解析、片子推进/碎片/HOLD、跳过工序、批量完成、ready、pickup、交割单、撤销取货。
- 注意：此命令会操作共享 DB/uploads，必须与 ZIP smoke 串行运行，不能并行。
- **验收标准**：主 smoke 全绿。
- **验证命令**：
```bash
./scripts/smoke.sh
```

#### P8-T3. ZIP PDF 上传兼容验收
- 使用 `glassorder-20260517T053732Z-3-001.zip` 中的 PDF 做批量上传验证。
- 注意：此命令会操作共享 DB/uploads，必须与主 smoke 串行运行，不能并行。
- **验收标准**：ZIP 内 PDF 上传/重复拒绝逻辑全绿，无解析回归。
- **验证命令**：
```bash
BASE=http://localhost:8781 backend/scripts/zip-upload-smoke.sh
```

#### P8-T4. 前端语法、i18n 与静态资源验收
- 验证所有 JS 语法、zh/en 字典 key 对齐、核心页面/资源 HTTP 200、缓存头/安全头存在。
- **验收标准**：JS 语法通过；zh/en key 完全对齐；核心静态资源 200；CSS/JS cache 与 HTML no-cache 符合预期；安全头存在。
- **验证命令**：
```bash
node -c $(find backend frontend -name '*.js' -not -path '*/node_modules/*' | sort)
node - <<'NODE'
const fs = require('fs');
const vm = require('vm');
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('frontend/js/i18n/zh.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync('frontend/js/i18n/en.js', 'utf8'), ctx);
const z = Object.keys(ctx.window.__I18N_ZH__).sort();
const e = Object.keys(ctx.window.__I18N_EN__).sort();
const missEn = z.filter(k => !e.includes(k));
const missZh = e.filter(k => !z.includes(k));
console.log(`zh=${z.length} en=${e.length} missingEn=${missEn.length} missingZh=${missZh.length}`);
if (missEn.length || missZh.length) process.exit(1);
NODE
for p in / /login.html /index.html /boss-dashboard.html /boss-new-order.html /boss-order-detail.html /worker-queue.html /worker-pieces.html /customers.html /pickup-search.html /pickup-sign.html /pickup-slip.html /shared.css /js/api.js /js/i18n.js /sw.js /manifest.json; do code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:8781$p"); echo "$code $p"; test "$code" = 200 || exit 1; done
curl -sI http://localhost:8781/shared.css | tr -d '\r' | rg -i '^cache-control: public, max-age=3600, must-revalidate$'
curl -sI http://localhost:8781/login.html | tr -d '\r' | rg -i '^cache-control: no-cache$'
curl -sI http://localhost:8781/login.html | tr -d '\r' | rg -i '^x-frame-options: SAMEORIGIN$'
```

#### P8-T5. 前端流畅度验收
- 工人片子页操作后不得再额外整单 refetch；移动端核心页面不得横向溢出；签名板 resize 不丢签名；批量选择空菜单禁用。
- **验收标准**：Playwright 移动端巡检通过；工人单片完成只发一个 piece mutation API，不再发 `GET /api/orders/:id`。
- **验证命令**：
```bash
node scripts/perf-check-worker.js
```

### Phase 8 完成定义
- P8-T1 到 P8-T5 全部验收通过。
- 如果任何命令失败，先修复再复跑，不跳过。
- 不新增与核心交付、稳定性、性能验收无关的功能。

### Phase 8 验收记录（2026-05-19）

- P8-T1 计划与端口一致性：`PLAN.md` 历史端口修正为 `8781`；`README.md`、`backend/server.js`、`backend/scripts/smoke.sh`、`backend/scripts/zip-upload-smoke.sh` 均使用 `8781`。`rg "8782" README.md backend scripts frontend -S` 无命中；`PLAN.md` 仅保留本验收说明中的历史引用 ✅
- P8-T2 核心 API 与业务流：`./scripts/smoke.sh` 串行复跑 `SMOKE PASS`。首次并行跑主 smoke 与 zip-smoke 时失败于上传目录计数干扰，已在 P8-T2/P8-T3 记录“必须串行运行”，串行复跑通过 ✅
- P8-T3 ZIP PDF 上传兼容：`BASE=http://localhost:8781 backend/scripts/zip-upload-smoke.sh` 通过，11/11 为 already existed 或 duplicate rejected，无解析回归 ✅
- P8-T4 前端语法、i18n 与静态资源：`node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` 通过；zh/en 字典 `276/276` key 对齐；17 个核心静态页面/资源 HTTP 200；`shared.css` cache 为 `public, max-age=3600, must-revalidate`；HTML 为 `no-cache`；`X-Frame-Options: SAMEORIGIN` ✅
- P8-T5 前端流畅度：新增 `scripts/perf-check-worker.js`；验证工人页单片完成只发 `POST /api/pieces/:id/advance`，无额外 `GET /api/orders/:id`；本轮测得约 `513ms`。移动端 Playwright 巡检 10 个核心页面 `375x812` 无横向溢出、无 console error ✅

最终状态：核心功能开发闭环可运行、可验证、可交付；服务健康 `{"ok":true}` on `http://localhost:8781/api/health`。

## Phase 9：长期执行模式复验（2026-05-19）

### 当前目标
在重新进入长期执行模式后，对核心功能、交付脚本、前端资源、性能验收做一次串行复验，确认系统仍然可运行、可验证、可交付。

### 执行任务

#### P9-T1. 项目结构与计划复核
- 读取项目结构、`README.md`、`PLAN.md`、当日 memory。
- 确认当前计划包含任务、验收标准、验证命令。
- **验证命令**：
```bash
find . -maxdepth 2 -type d | sort
rg --files | sort
sed -n '1,180p' PLAN.md
tail -n 160 PLAN.md
```

#### P9-T2. 核心业务流串行验收
- 主 smoke 与 ZIP smoke 必须串行执行，避免共享 DB/uploads 目录互相干扰。
- **验收标准**：两个 smoke 均 PASS。
- **验证命令**：
```bash
./scripts/smoke.sh
BASE=http://localhost:8781 backend/scripts/zip-upload-smoke.sh
```

#### P9-T3. 前端与交付资源验收
- 验证 JS 语法、i18n 字典对齐、核心静态资源 200、缓存头/安全头存在。
- **验收标准**：全部命令退出码为 0。
- **验证命令**：
```bash
node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)
node - <<'NODE'
const fs = require('fs');
const vm = require('vm');
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('frontend/js/i18n/zh.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync('frontend/js/i18n/en.js', 'utf8'), ctx);
const z = Object.keys(ctx.window.__I18N_ZH__).sort();
const e = Object.keys(ctx.window.__I18N_EN__).sort();
const missEn = z.filter(k => !e.includes(k));
const missZh = e.filter(k => !z.includes(k));
console.log(`zh=${z.length} en=${e.length} missingEn=${missEn.length} missingZh=${missZh.length}`);
if (missEn.length || missZh.length) process.exit(1);
NODE
for p in / /login.html /index.html /boss-dashboard.html /boss-new-order.html /boss-order-detail.html /worker-queue.html /worker-pieces.html /customers.html /pickup-search.html /pickup-sign.html /pickup-slip.html /shared.css /js/api.js /js/i18n.js /sw.js /manifest.json; do code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:8781$p"); echo "$code $p"; test "$code" = 200 || exit 1; done
curl -sI http://localhost:8781/shared.css | tr -d '\r' | rg -i '^cache-control: public, max-age=3600, must-revalidate$'
curl -sI http://localhost:8781/login.html | tr -d '\r' | rg -i '^cache-control: no-cache$'
curl -sI http://localhost:8781/login.html | tr -d '\r' | rg -i '^x-frame-options: SAMEORIGIN$'
```

#### P9-T4. 前端流畅度验收
- 验证工人页完成单片时只调用 piece mutation API，不额外拉整单。
- **验收标准**：`scripts/perf-check-worker.js` PASS。
- **验证命令**：
```bash
node scripts/perf-check-worker.js
```

### Phase 9 完成定义
- P9-T1 到 P9-T4 全部通过。
- 任一验证失败必须修复并复跑。
- 不开发无关功能。

### Phase 9 验收记录（2026-05-19）

- P9-T1 项目结构与计划复核：已重新读取目录结构、`README.md`、`PLAN.md`、`memory/2026-05-19.md`；计划中包含任务、验收标准、验证命令 ✅
- P9-T2 核心业务流串行验收：`./scripts/smoke.sh` 通过；`BASE=http://localhost:8781 backend/scripts/zip-upload-smoke.sh` 通过；二者按计划串行运行，未发生共享目录计数干扰 ✅
- P9-T3 前端与交付资源验收：`node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` 通过；zh/en 字典 `276/276` 对齐；17 个核心页面/资源 HTTP 200；`shared.css` cache 为 `public, max-age=3600, must-revalidate`；HTML 为 `no-cache`；`X-Frame-Options: SAMEORIGIN` ✅
- P9-T4 前端流畅度验收：`node scripts/perf-check-worker.js` 通过，工人页单片完成只发 `POST /api/pieces/:id/advance`，无额外 `GET /api/orders/:id`；修正脚本计时为单调时钟后本轮测得约 `395.4ms` ✅

最终状态：Phase 9 全部验收通过，服务健康运行在 `http://localhost:8781`。

## Phase 10：长期执行模式复验（2026-05-19）

### 当前目标
重新进入长期执行模式后，再次按项目计划验证核心功能开发闭环，确保系统可运行、可验证、可交付；不新增无关功能。

### 执行任务

#### P10-T1. 项目结构与计划复核
- 读取项目结构、`README.md`、`PLAN.md`、当日 memory、服务状态。
- 确认计划中包含任务、验收标准、验证命令。
- **验收标准**：项目结构清楚，服务健康，`PLAN.md` 已追加 Phase 10。
- **验证命令**：
```bash
find . -maxdepth 2 -type d | sort
rg --files | sort
sed -n '1,180p' PLAN.md
tail -n 180 PLAN.md
bash scripts/status.sh
```

#### P10-T2. 核心业务流串行验收
- 主 smoke 与 ZIP smoke 共享 DB/uploads，必须串行执行。
- **验收标准**：两个 smoke 均 PASS。
- **验证命令**：
```bash
./scripts/smoke.sh
BASE=http://localhost:8781 backend/scripts/zip-upload-smoke.sh
```

#### P10-T3. 交付资源验收
- 验证 JS 语法、i18n 字典对齐、核心静态资源 200、缓存/安全头。
- **验收标准**：所有命令退出码为 0。
- **验证命令**：
```bash
node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)
node - <<'NODE'
const fs = require('fs');
const vm = require('vm');
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('frontend/js/i18n/zh.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync('frontend/js/i18n/en.js', 'utf8'), ctx);
const z = Object.keys(ctx.window.__I18N_ZH__).sort();
const e = Object.keys(ctx.window.__I18N_EN__).sort();
const missEn = z.filter(k => !e.includes(k));
const missZh = e.filter(k => !z.includes(k));
console.log(`zh=${z.length} en=${e.length} missingEn=${missEn.length} missingZh=${missZh.length}`);
if (missEn.length || missZh.length) process.exit(1);
NODE
for p in / /login.html /index.html /boss-dashboard.html /boss-new-order.html /boss-order-detail.html /worker-queue.html /worker-pieces.html /customers.html /pickup-search.html /pickup-sign.html /pickup-slip.html /shared.css /js/api.js /js/i18n.js /sw.js /manifest.json; do code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:8781$p"); echo "$code $p"; test "$code" = 200 || exit 1; done
curl -sI http://localhost:8781/shared.css | tr -d '\r' | rg -i '^cache-control: public, max-age=3600, must-revalidate$'
curl -sI http://localhost:8781/login.html | tr -d '\r' | rg -i '^cache-control: no-cache$'
curl -sI http://localhost:8781/login.html | tr -d '\r' | rg -i '^x-frame-options: SAMEORIGIN$'
```

#### P10-T4. 前端流畅度验收
- 验证工人页单片完成只调用 piece mutation API，不额外拉整单。
- **验收标准**：`scripts/perf-check-worker.js` PASS。
- **验证命令**：
```bash
node scripts/perf-check-worker.js
```

### Phase 10 完成定义
- P10-T1 到 P10-T4 全部通过。
- 任一验证失败必须修复并复跑。
- 不开发无关功能。

### Phase 10 验收记录（2026-05-19）

- P10-T1 项目结构与计划复核：已读取项目结构、`README.md`、`PLAN.md`、`memory/2026-05-19.md`、服务状态；服务健康 `{"ok":true}` on `:8781`；`PLAN.md` 已追加 Phase 10 ✅
- P10-T2 核心业务流串行验收：`./scripts/smoke.sh` 通过；`BASE=http://localhost:8781 backend/scripts/zip-upload-smoke.sh` 通过；两者串行运行，未发生共享目录干扰 ✅
- P10-T3 交付资源验收：`node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` 通过；zh/en 字典 `276/276` 对齐；17 个核心页面/资源 HTTP 200；`shared.css` cache 为 `public, max-age=3600, must-revalidate`；HTML 为 `no-cache`；`X-Frame-Options: SAMEORIGIN` ✅
- P10-T4 前端流畅度验收：`node scripts/perf-check-worker.js` 通过，工人页单片完成只发 `POST /api/pieces/:id/advance`，无额外 `GET /api/orders/:id`；本轮测得约 `425.8ms` ✅

最终状态：Phase 10 全部验收通过，核心功能闭环仍可运行、可验证、可交付。

## Phase 11：老板端订单归档与编号查询（2026-05-19）

### 当前目标
补齐老板端上线前的订单收口能力：老板菜单可进入归档订单；已完成订单可移动到归档；订单可按编号精确/模糊查询。范围仅限订单归档、查询与对应验证，不开发报表等无关功能。

### 执行任务

#### P11-T1. 归档数据模型与 API
- 在 `orders` 上增加 `archived_at`、`archived_by` 字段和归档索引；不改变既有 `status` 枚举，避免重建 SQLite 表。
- `GET /api/orders` 默认只返回未归档订单；`?archived=1` 只返回归档订单；`?include_archived=1` 返回全部；`?order_number=` 支持按编号精确查询，`?search=` 继续支持订单号/项目/客户模糊查询。
- 新增老板接口 `POST /api/orders/:id/archive`：仅允许 `picked_up` 完成订单归档；重复归档或未完成订单返回 400；写入 `order_archived` 事件。
- **验收标准**：老库启动自动迁移；完成订单归档后默认列表隐藏，归档列表可查到；编号精确查询可用；重复归档被拒绝。
- **验证命令**：
```bash
./scripts/restart.sh
./scripts/smoke.sh
```

#### P11-T2. 老板端前端入口与订单详情操作
- `boss-dashboard.html` 增加老板菜单入口，可在当前订单和归档订单之间切换；归档视图继续支持搜索订单编号。
- `boss-order-detail.html` 对已取货且未归档订单提供“移入归档”操作；归档订单显示归档标记，并从详情返回归档列表。
- `frontend/js/api.js` 的状态标记和逾期逻辑识别归档订单；补齐 zh/en i18n 文案并重建 `frontend/js/i18n.js`；更新 service worker 版本让前端缓存刷新。
- **验收标准**：老板可从菜单进入归档列表；订单详情可归档已取货订单；归档订单不显示逾期；中英文 key 对齐。
- **验证命令**：
```bash
bash scripts/build-i18n.sh
node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)
node - <<'NODE'
const fs = require('fs');
const vm = require('vm');
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('frontend/js/i18n/zh.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync('frontend/js/i18n/en.js', 'utf8'), ctx);
const z = Object.keys(ctx.window.__I18N_ZH__).sort();
const e = Object.keys(ctx.window.__I18N_EN__).sort();
const missEn = z.filter(k => !e.includes(k));
const missZh = e.filter(k => !z.includes(k));
console.log(`zh=${z.length} en=${e.length} missingEn=${missEn.length} missingZh=${missZh.length}`);
if (missEn.length || missZh.length) process.exit(1);
NODE
for p in /boss-dashboard.html /boss-dashboard.html?archived=1 /boss-order-detail.html /js/api.js /js/i18n.js /sw.js; do code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:8781$p"); echo "$code $p"; test "$code" = 200 || exit 1; done
```

#### P11-T3. 串行交付复验
- 主 smoke 与 ZIP smoke 共享 DB/uploads，必须串行执行。
- **验收标准**：核心业务流、归档查询、ZIP PDF 兼容、前端资源和工人流畅度全部通过。
- **验证命令**：
```bash
./scripts/smoke.sh
BASE=http://localhost:8781 backend/scripts/zip-upload-smoke.sh
node scripts/perf-check-worker.js
```

### Phase 11 完成定义
- P11-T1 到 P11-T3 全部通过。
- 任一验证失败必须修复并复跑。
- 不开发无关功能。

### Phase 11 验收记录（2026-05-19）

- P11-T1 归档数据模型与 API：`orders.archived_at`、`orders.archived_by`、`idx_orders_archived_at`、`idx_orders_number_archived` 已通过迁移创建；`GET /api/orders` 默认过滤归档，`?archived=1` 查看归档，`?include_archived=1` 查看全部；新增 `?order_number=` 精确查询；`POST /api/orders/:id/archive` 仅允许 `picked_up` 订单，重复归档/未完成归档均 400；写入 `order_archived` 事件 ✅
- P11-T2 老板端前端：`boss-dashboard.html` 增加老板菜单入口，可切换当前订单/归档订单；归档视图标题正确、搜索框仍支持订单号；`boss-order-detail.html` 已取货未归档订单可“移入归档”，归档订单显示归档时间与标记，返回按钮回归档列表；`statusBadge()`/`isOverdue()` 识别归档；service worker 版本更新到 `v7-2026-05-19-order-archive` ✅
- P11-T2 浏览器验收：Playwright 390×844 登录态验证老板菜单进入 `boss-dashboard.html?archived=1`，标题为“归档订单”，列表有归档内容，无横向溢出，无 console/page error。首次验收发现标题被 i18n 初始化覆盖为“订单总览”，已修复 `updatePageTitle()` 同步 `data-i18n` 后复跑通过 ✅
- P11-T3 串行交付复验：`./scripts/smoke.sh` 通过，新增覆盖未完成不能归档、已取货可归档、重复归档拒绝、默认编号查询隐藏归档、归档编号精确/模糊查询可见；`BASE=http://localhost:8781 backend/scripts/zip-upload-smoke.sh` 通过，11/11 duplicate_or_existing；`node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` 通过；zh/en 字典 `289/289` 对齐；18 个核心页面/资源 HTTP 200；缓存/安全头通过；`node scripts/perf-check-worker.js` 通过，单片完成只发 `POST /api/pieces/:id/advance`，约 `414.4ms` ✅

最终状态：Phase 11 全部验收通过；老板端可以从菜单进入归档，已完成订单可移入归档，订单可按编号查询，服务健康运行在 `http://localhost:8781`。

## Phase 12：长期执行模式浏览器待办清零与交付复验（2026-05-19）

### 当前目标
重新进入长期执行模式后，不新增业务功能，优先清掉 Phase 2 遗留的两项浏览器人工待办，并对核心功能、静态资源、归档功能、工人流畅度做串行复验，确保项目可运行、可验证、可交付。

### 执行任务

#### P12-T1. 项目结构与计划复核
- 读取项目结构、`PLAN.md`、当日 memory、服务状态。
- 确认本轮 Phase 12 已列出任务、验收标准和验证命令。
- **验收标准**：服务健康；项目结构清楚；`PLAN.md` 包含 Phase 12。
- **验证命令**：
```bash
find . -maxdepth 2 -type d | sort
rg --files | sort
tail -n 220 PLAN.md
bash scripts/status.sh
```

#### P12-T2. 旧 Phase 2 浏览器待办自动化
- 新增 `scripts/browser-qa.js`，用 Playwright 覆盖旧手工项：
  - Q3：清空登录态后访问 `boss-dashboard.html`，必须跳转 `login.html`。
  - Q4：老板详情页“通知可取货”必须出现确认模态；取货签字提交前必须出现确认模态。
  - Q5：完成取货后订单详情必须显示事件时间线和交割单下载卡片。
  - Q6：工人片子网格移动端无横向溢出，片子尺寸可辨，页面有退出入口。
  - Q7：登录页不预填账号/密码，输入 required 生效，placeholder 存在。
  - Q8：空状态使用 `.empty-state` 样式。
- **验收标准**：脚本退出码 0，输出 `BROWSER QA PASS`；无 console/page error；失败必须修复后复跑。
- **验证命令**：
```bash
node scripts/browser-qa.js
```

#### P12-T3. 交付串行复验
- 主 smoke 与 ZIP smoke 共享 DB/uploads，必须串行执行。
- **验收标准**：核心业务 smoke、ZIP PDF 兼容、JS 语法、i18n、静态资源、缓存/安全头、工人流畅度全部通过。
- **验证命令**：
```bash
./scripts/smoke.sh
BASE=http://localhost:8781 backend/scripts/zip-upload-smoke.sh
node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)
node - <<'NODE'
const fs = require('fs');
const vm = require('vm');
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('frontend/js/i18n/zh.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync('frontend/js/i18n/en.js', 'utf8'), ctx);
const z = Object.keys(ctx.window.__I18N_ZH__).sort();
const e = Object.keys(ctx.window.__I18N_EN__).sort();
const missEn = z.filter(k => !e.includes(k));
const missZh = e.filter(k => !z.includes(k));
console.log(`zh=${z.length} en=${e.length} missingEn=${missEn.length} missingZh=${missZh.length}`);
if (missEn.length || missZh.length) process.exit(1);
NODE
for p in / /login.html /index.html /boss-dashboard.html /boss-dashboard.html?archived=1 /boss-new-order.html /boss-order-detail.html /worker-queue.html /worker-pieces.html /customers.html /pickup-search.html /pickup-sign.html /pickup-slip.html /shared.css /js/api.js /js/i18n.js /sw.js /manifest.json; do code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:8781$p"); echo "$code $p"; test "$code" = 200 || exit 1; done
curl -sI http://localhost:8781/shared.css | tr -d '\r' | rg -i '^cache-control: public, max-age=3600, must-revalidate$'
curl -sI http://localhost:8781/login.html | tr -d '\r' | rg -i '^cache-control: no-cache$'
curl -sI http://localhost:8781/login.html | tr -d '\r' | rg -i '^x-frame-options: SAMEORIGIN$'
node scripts/perf-check-worker.js
```

### Phase 12 完成定义
- P12-T1 到 P12-T3 全部通过。
- 任一验证失败必须修复并复跑。
- 不开发无关功能。

### Phase 12 验收记录（2026-05-19）

- P12-T1 项目结构与计划复核：已重新读取项目结构、`PLAN.md`、`memory/2026-05-19.md` 和服务状态；服务健康 `{"ok":true}` on `:8781`；`PLAN.md` 已追加 Phase 12 ✅
- P12-T2 浏览器待办自动化：新增 `scripts/browser-qa.js`，通过 API 自建临时客户/订单并走真实前端流程；覆盖 Q3 无 token 访问老板页跳登录、Q4 通知可取货确认模态、Q4 取货签字确认模态、Q5 详情时间线与交割单下载、Q6 工人片子网格尺寸/退出/无横向溢出、Q7 登录页 required/placeholder/不预填、Q8 空状态 `.empty-state`。首次运行发现 `boss-dashboard.html` 未授权跳转后仍继续发 `/api/orders` 产生 401 console error，已修复为 `requireRolePage('boss')` 不通过时不加载订单；复跑 `node scripts/browser-qa.js` 输出 `BROWSER QA PASS` ✅
- Phase 2 手工验收清单旧待办已由自动化覆盖：
  - Q3：浏览器无 token 访问 `boss-dashboard.html` 跳 `login.html` ✅
  - Q4/Q5/Q6/Q7/Q8：浏览器场景巡检已由 `scripts/browser-qa.js` 覆盖 ✅
- P12-T3 交付串行复验：`./scripts/smoke.sh` 通过；`BASE=http://localhost:8781 backend/scripts/zip-upload-smoke.sh` 通过，11/11 duplicate_or_existing；`node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` 通过；zh/en 字典 `289/289` 对齐；18 个核心页面/资源 HTTP 200；`shared.css` cache、HTML no-cache、`X-Frame-Options` 均通过；`node scripts/perf-check-worker.js` 通过，单片完成只发 `POST /api/pieces/:id/advance`，约 `468.2ms` ✅

最终状态：Phase 12 全部验收通过；旧浏览器待办已自动化清零，核心功能闭环可运行、可验证、可交付。

## Phase 13：片级跨订单取货、回退纠错、老板汇总与导航（2026-05-20）

### 当前目标
适配真实工厂流程：老板可按客户跨多个订单选择部分玻璃片取货；客户只在老板设备签字，不登录；取货后可按片回退并继续修改；老板可打印生产/客户汇总；工人端保持现有结构，不开放取货、汇总、客户管理、归档、回退。第一版不做金额/尾款模型。

### 已确认业务规则
- 真实登录角色仅老板、工人；客户不登录系统。
- 正常取货只能同一客户内跨订单选片，不允许普通流程混客户。
- 仅已完成且未取货的玻璃片可被选中取货；HOLD、返工、未完成片不可取。
- 取货记录以“提货批次”为核心，批次可包含同一客户多个订单的多片玻璃；PDF 按订单分组列明。
- 回退/纠错支持按片回退，必须写原因并保留原签字/PDF/审计事件。
- 工人不能办理客户取货签字，不能查看汇总，不能接触后续金额/对账能力。
- 部分取货订单不能归档；必须全部取货后才允许归档。

### 执行任务

#### P13-T1. 片级取货数据模型与兼容迁移
- 新增 `pickup_batches`、`pickup_items` 表；在 `pieces` 增加 `picked_up_at`、`pickup_batch_id` 字段和索引。
- 兼容旧数据：旧订单级 `pickups` 记录保留；新流程用批次/片项；订单列表和详情返回片级取货统计。
- **验收标准**：老库启动自动迁移；已有订单不丢；新字段/表存在；旧 smoke 仍可跑。
- **验证命令**：
```bash
./scripts/restart.sh
cd backend && node - <<'NODE'
const db = require('./db');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
const pieceCols = db.prepare('PRAGMA table_info(pieces)').all().map(r => r.name);
console.log({ hasPickupBatches: tables.includes('pickup_batches'), hasPickupItems: tables.includes('pickup_items'), picked: pieceCols.includes('picked_up_at'), batch: pieceCols.includes('pickup_batch_id') });
if (!tables.includes('pickup_batches') || !tables.includes('pickup_items') || !pieceCols.includes('picked_up_at') || !pieceCols.includes('pickup_batch_id')) process.exit(1);
NODE
```

#### P13-T2. 片级跨订单取货与回退 API
- 新增老板 API：
  - `GET /api/pickups/available?customer_id=`：按客户返回已完成未取货片，按订单分组。
  - `POST /api/pickups/batches`：创建提货批次，保存签字、生成 PDF、标记选中片已取货。
  - `GET /api/pickups/batches` / `GET /api/pickups/batches/:id`：查询批次和明细。
  - `POST /api/pickups/batches/:id/revert`：按片或整批回退，必须写原因。
- 订单状态保留 `in_production | ready_pickup | picked_up`，但 API 返回派生 `pickup_status`：`not_ready | ready | partial | picked_up`。
- 归档接口改为只允许全部片已取货且无未取货完成片的订单归档。
- **验收标准**：同一客户两个订单可选部分片生成同一批次；只标记所选片已取；回退部分片后恢复可取；工人调用取货/汇总 API 返回 403。
- **验证命令**：
```bash
node scripts/pickup-batch-smoke.js
```

#### P13-T3. 老板端取货批次前端
- 老板端新增/改造取货页：按客户搜索，展示该客户所有可取玻璃片，按订单分组，多选本次取货片，签字后生成批次和 PDF。
- 新增提货批次列表/详情入口，支持打印/下载 PDF 和按片回退纠错。
- 取货页面仅老板可访问；工人访问跳回工位或显示无权限。
- **验收标准**：移动端可完成“选客户 → 跨订单选片 → 签字 → 打印/下载明细 → 批次详情 → 按片回退”链路；无横向溢出，无 console error。
- **验证命令**：
```bash
node scripts/pickup-batch-browser-qa.js
```

#### P13-T4. 老板汇总与打印
- 新增汇总页：生产进度汇总、按客户汇总、按状态汇总、客户对账打印（不含金额）。
- 支持按客户筛选和打印视图；展示订单数、总片数、完成片、已取片、未取片、返工/碎片/HOLD。
- 工人不可访问汇总 API/页面。
- **验收标准**：老板可查看和打印汇总；工人访问汇总 API/页面被拒；客户对账能列出客户所有订单和提货批次。
- **验证命令**：
```bash
node scripts/summary-smoke.js
```

#### P13-T5. 老板端底部导航，工人端保持现状
- 老板登录后直接进入订单页，不再先选“老板/工人/客户”总入口；老板页提供底部 4 菜单：订单、车间、取货、汇总。
- 订单页包含当前订单、新建订单、客户管理、归档订单入口；归档仍作为订单视图，不做一级菜单。
- 工人登录后仍直接进入当前 `worker-queue.html`，不加底部菜单。
- **验收标准**：老板登录进入订单工作台；工人登录进入工位；老板底部 4 菜单移动端可用且不拥挤；工人看不到取货/汇总入口。
- **验证命令**：
```bash
node scripts/navigation-browser-qa.js
```

#### P13-T6. 完整交付复验
- 主 smoke 与 ZIP smoke 共享 DB/uploads，必须串行执行。
- **验收标准**：原核心业务、批次取货、汇总、导航、静态资源和工人流畅度全部通过。
- **验证命令**：
```bash
./scripts/smoke.sh
BASE=http://localhost:8781 backend/scripts/zip-upload-smoke.sh
node scripts/browser-qa.js
node scripts/perf-check-worker.js
node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)
bash scripts/build-i18n.sh
```

### Phase 13 完成定义
- P13-T1 到 P13-T6 全部通过。
- 任一验证失败必须修复并复跑，不跳过。
- 不开发金额/收款/库存等未确认功能。

### Phase 13 验收结果（2026-05-20）

- P13-T1 数据模型：`pickup_batches`、`pickup_items`、`pieces.picked_up_at`、`pieces.pickup_batch_id` 和关键索引均存在；老库迁移通过 ✅
- P13-T2 片级取货 API：`node scripts/pickup-batch-smoke.js` 通过；同一客户两个订单跨订单取 2 片，两个订单均为 `partial`；回退 1 片后恢复可取；工人取货/回退 403 ✅
- P13-T3 老板取货前端：`node scripts/pickup-batch-browser-qa.js` 通过；移动端完成选客户、跨订单选片、签字、生成批次 PDF、详情查看、按片回退，无横向溢出 ✅
- P13-T4 汇总：`node scripts/summary-smoke.js` 通过；老板可看生产/客户/状态汇总，工人 API 403，移动端无横向溢出 ✅
- P13-T5 导航与角色：`node scripts/navigation-browser-qa.js` 通过；老板登录进订单工作台并有 4 个底部菜单，工人登录进工位且没有底部菜单，工人访问老板取货/汇总被挡回工位 ✅
- P13-T6 完整复验全部通过：
  - `./scripts/smoke.sh` ✅
  - `BASE=http://localhost:8781 backend/scripts/zip-upload-smoke.sh` ✅
  - `node scripts/browser-qa.js` ✅
  - `node scripts/perf-check-worker.js` ✅，单片操作只发 `POST /api/pieces/:id/advance`，未触发全订单重拉
  - `node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` ✅
  - `bash scripts/build-i18n.sh` ✅，zh/en 字典 `313/313` 对齐
  - 新增核心静态页 `/boss-workspace.html`、`/pickup-search.html`、`/pickup-batches.html`、`/pickup-batch-detail.html`、`/summary.html`、`/summary-customer.html` HTTP 200 ✅

实现范围保持在已确认需求内：未加入金额、收款、库存等未确认功能。

## Phase 14：全面上线前 QA（2026-05-20）

### QA 目标
在 Phase 13 已交付的基础上，做一轮上线前横向 QA：核心 API、真实 PDF 上传、老板/工人角色权限、移动/桌面页面渲染、底部导航/操作栏遮挡、console error、工人操作流畅度、静态资源和双语字典一致性。

### QA 任务

#### P14-T1. 服务、结构与计划复核
- 确认服务健康，项目结构和现有 QA 脚本存在。
- **验收标准**：`/api/health` 返回 `{ok:true}`；`PLAN.md` 已记录本轮 QA。
- **验证命令**：
```bash
bash scripts/status.sh
```

#### P14-T2. 新增页面矩阵 QA
- 新增浏览器矩阵脚本，覆盖老板/工人登录态、无登录态、移动端 390×844 和桌面端 1280×900。
- 覆盖页面：登录、老板订单工作台、订单列表、客户管理、新建订单、订单详情、车间、片子网格、取货列表、取货选片、批次详情、汇总、客户对账。
- 检查项：HTTP 200/正确跳转、无 console error/pageerror、无横向溢出、底部导航不与操作栏共存遮挡、老板 4 菜单正确、工人无底部菜单、工人访问老板页被挡回工位。
- **验收标准**：脚本通过。
- **验证命令**：
```bash
node scripts/page-matrix-qa.js
```

#### P14-T3. 完整自动化回归
- 串行运行既有 smoke、ZIP smoke、浏览器业务 QA、取货批次 QA、汇总 QA、导航 QA、工人性能 QA、语法和 i18n。
- **验收标准**：所有命令通过；失败项必须修复并复跑。
- **验证命令**：
```bash
./scripts/smoke.sh
BASE=http://localhost:8781 backend/scripts/zip-upload-smoke.sh
node scripts/browser-qa.js
node scripts/pickup-batch-smoke.js
node scripts/pickup-batch-browser-qa.js
node scripts/summary-smoke.js
node scripts/navigation-browser-qa.js
node scripts/page-matrix-qa.js
node scripts/perf-check-worker.js
node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)
bash scripts/build-i18n.sh
```

### Phase 14 完成定义
- P14-T1 到 P14-T3 全部通过。
- 所有发现的问题都修复并复验。
- 不引入未确认业务功能。

### Phase 14 QA 结果（2026-05-20）

- P14-T1 服务与结构复核：`bash scripts/status.sh` 通过，服务运行在 `:8781`，`/api/health` 返回 `{"ok":true}` ✅
- P14-T2 页面矩阵 QA：新增 `scripts/page-matrix-qa.js` 并通过；覆盖 mobile 390×844 与 desktop 1280×900，老板/工人/未登录三种状态，30 个关键页面/跳转检查；无 console error、无 pageerror、无横向溢出、底部导航不遮挡操作栏 ✅
- P14-T3 完整自动化回归全部通过：
  - `./scripts/smoke.sh` ✅
  - `BASE=http://localhost:8781 backend/scripts/zip-upload-smoke.sh` ✅
  - `node scripts/browser-qa.js` ✅
  - `node scripts/pickup-batch-smoke.js` ✅
  - `node scripts/pickup-batch-browser-qa.js` ✅
  - `node scripts/summary-smoke.js` ✅
  - `node scripts/navigation-browser-qa.js` ✅
  - `node scripts/page-matrix-qa.js` ✅
  - `node scripts/perf-check-worker.js` ✅，单片操作只发 `POST /api/pieces/:id/advance`，未触发全订单重拉，耗时约 `459.9ms`
  - `node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` ✅
  - `bash scripts/build-i18n.sh` ✅，zh/en 字典 `313/313` 对齐

本轮 QA 发现并修正了页面矩阵脚本的误报逻辑：可见文本检查已排除 `script/style/noscript`，避免把源码里的 `undefined` 字样当成 UI 渲染问题。复验通过。

## Phase 15：客户模糊检索可用性修复（2026-05-20）

### 问题
客户数量达到几百时，普通 `<select>` 下拉几乎不可用；客户名称相似，无法快速定位客户，影响新建订单、客户取货和客户管理。

### 实现
- 新增通用 `initCustomerPicker()` 客户搜索选择器，支持公司名、联系人、电话、邮箱、备注模糊检索。
- 搜索结果按匹配质量排序：精确匹配 > 前缀匹配 > 包含匹配，再截取前 40 条，避免大量相似客户时目标被截断。
- `boss-new-order.html` 新建订单客户选择改为搜索选择器。
- `pickup-search.html` 客户取货客户选择改为搜索选择器。
- `customers.html` 客户管理新增搜索框，可按公司 / 联系人 / 电话 / 邮箱过滤列表，并显示结果数。
- 新增 `scripts/customer-search-qa.js`：创建 80+ 个相似客户和 1 个目标客户，验证可用电话/邮箱快速定位并选中目标。

### 验收结果
- `node scripts/customer-search-qa.js` ✅
- `node scripts/pickup-batch-browser-qa.js` ✅
- `node scripts/browser-qa.js` ✅
- `node scripts/page-matrix-qa.js` ✅
- `node scripts/navigation-browser-qa.js` ✅
- `./scripts/smoke.sh` ✅
- `node scripts/perf-check-worker.js` ✅，单片操作仍只发 `POST /api/pieces/:id/advance`
- `node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` ✅
- `bash scripts/build-i18n.sh` ✅，zh/en 字典 `318/318` 对齐

### P15 补充修复：PWA 旧缓存导致客户搜索函数缺失（2026-05-20）
- 现象：用户打开 `pickup-search.html` 时报 `initCustomerPicker is not defined`，同时浏览器提示 `apple-mobile-web-app-capable` deprecated。
- 根因：页面 HTML 已更新，但 PWA/service worker 仍可能从旧缓存返回旧 `js/api.js`，导致新页面调用了旧脚本里不存在的函数。
- 修复：
  - 所有 HTML 的 `js/api.js` / `js/i18n.js` 引用增加版本参数 `v=20260520-customer-search2`，绕过旧 asset cache。
  - `frontend/sw.js` 版本提升到 `v9-2026-05-20-customer-search`，触发缓存更新。
  - `frontend/js/api.js` 的缓存清理 key 更新为 `__sw_nuke_2026_05_20_customer_search__`。
  - 将 `initCustomerPicker`、`customerSearchText`、`normText` 显式挂到 `window`，提高内联页面脚本兼容性。
  - 增加 `meta[name="mobile-web-app-capable"]`，保留 apple 旧 meta 以兼容 iOS。
- 复验：
  - 无缓存浏览器打开 `pickup-search.html`，`window.initCustomerPicker === 'function'`，无 pageerror ✅
  - `node scripts/customer-search-qa.js` ✅
  - `node scripts/pickup-batch-browser-qa.js` ✅
  - `node scripts/page-matrix-qa.js` ✅
  - `bash scripts/build-i18n.sh` ✅
  - `node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` ✅

## Phase 16：老板订单入口扁平化（2026-05-20）

### 问题
老板登录后进入“订单”页仍是 4 个二级卡片：当前订单 / 新建订单 / 客户管理 / 归档订单。实际高频操作是查看当前订单，其次是新建、查客户、看归档；中间页导致每次多点一次，查看客户后还要回退再进入其它功能，手机上也显得拥挤。

### 任务
- 老板登录、首页自动跳转、底部“订单”菜单都直接进入 `boss-dashboard.html`。
- `boss-dashboard.html` 作为订单一级页：默认展示当前订单列表，顶部保留“客户”“+新建”和归档菜单。
- `boss-workspace.html` 仅作为旧链接兼容，访问后自动跳转到订单列表。
- 更新导航/页面矩阵 QA，确保老板仍有 4 个底部一级菜单，工人仍没有底部菜单且不能访问老板页。
- 更新 PWA 资源版本，避免旧缓存继续显示四卡片入口。

### 验收标准
- 老板登录后直接看到当前订单列表，不再看到 4 个订单卡片入口。
- 底部“订单”从车间/取货/汇总返回时直接到订单列表。
- 订单列表无横向溢出，底部导航不遮挡操作区。
- 老板可从订单列表一键进入客户管理、新建订单、归档订单。
- 工人权限和现有取货/客户搜索流程不回退。

### 验证命令
```bash
node scripts/navigation-browser-qa.js
node scripts/page-matrix-qa.js
node scripts/browser-qa.js
node scripts/customer-search-qa.js
node scripts/pickup-batch-browser-qa.js
./scripts/smoke.sh
node scripts/perf-check-worker.js
node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)
bash scripts/build-i18n.sh
```

### Phase 16 验收结果
- 老板登录和 `index.html` 自动跳转已改为 `boss-dashboard.html`，不再先进入四卡片订单工作台 ✅
- 底部“订单”导航已改为 `boss-dashboard.html`；从车间 / 取货 / 汇总返回订单时直接看到当前订单列表 ✅
- `boss-dashboard.html` 已注入老板底部 4 菜单，顶部保留“客户”“+新建”和归档菜单 ✅
- `boss-workspace.html` 作为旧链接兼容，访问后自动跳转到 `boss-dashboard.html` ✅
- PWA 资源版本提升到 `v10-2026-05-20-orders-direct`，HTML 脚本参数提升到 `v=20260520-orders-direct`，避免旧缓存继续显示四卡片入口 ✅
- 针对截图问题的浏览器快检通过：老板登录后 path 为 `/boss-dashboard.html`，当前页面 `.role-card` 数量为 0，订单列表、客户入口、新建入口存在，横向溢出为 0 ✅
- 验证命令全部通过：
  - `bash scripts/status.sh` ✅，服务健康在 `:8781`
  - `node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` ✅
  - `bash scripts/build-i18n.sh` ✅
  - `node scripts/navigation-browser-qa.js` ✅
  - `node scripts/page-matrix-qa.js` ✅，mobile/desktop 共 30 项检查通过
  - `node scripts/browser-qa.js` ✅
  - `node scripts/customer-search-qa.js` ✅
  - `node scripts/pickup-batch-browser-qa.js` ✅
  - `./scripts/smoke.sh` ✅
  - `node scripts/perf-check-worker.js` ✅，单片操作仍只发 `POST /api/pieces/:id/advance`，约 `430.6ms`

## Phase 17：老板底部 5 菜单与订单页快捷操作（2026-05-20）

### 需求
老板底部菜单从 4 个调整为 5 个：订单、车间、取货、客户、汇总。客户成为一级入口；订单列表右下角加入圆形 `+` 悬浮按钮用于新建订单；归档列表放到筛选条最左侧，默认仍选中“全部”。

### 任务
- `bossNav()` 增加“客户”一级菜单，底部导航从 4 项改 5 项。
- `customers.html` 注入老板底部导航，激活“客户”，去掉顶部返回按钮。
- `boss-dashboard.html` 顶部去掉“客户 / +新建 / ⋯”入口，保留订单列表为主屏；右下角增加圆形 `+` 悬浮按钮指向新建订单。
- 订单筛选条最左侧加入“归档”按钮；默认仍激活“全部”；点击归档进入 `boss-dashboard.html?archived=1`，归档页可点击“全部”回当前订单。
- 更新导航与页面矩阵 QA：老板底部菜单必须为 5 项，且包含客户；客户页应有底部 nav，工人仍无底部 nav 并被挡回工位。
- 更新 PWA 版本和脚本版本，避免旧缓存显示旧导航。

### 验收标准
- 老板登录后底部显示 5 项：订单、车间、取货、客户、汇总。
- 点击底部“客户”直接进入客户管理，并保持底部 nav active。
- 订单页默认“全部”筛选高亮；归档按钮在最左侧。
- 订单页右下角圆形 `+` 可进入新建订单，并不遮挡底部导航。
- 移动端 320px/390px 无横向溢出；页面矩阵、业务 QA、客户搜索、取货、smoke、工人性能均通过。

### 验证命令
```bash
node scripts/navigation-browser-qa.js
node scripts/page-matrix-qa.js
node scripts/browser-qa.js
node scripts/customer-search-qa.js
node scripts/pickup-batch-browser-qa.js
./scripts/smoke.sh
node scripts/perf-check-worker.js
node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)
bash scripts/build-i18n.sh
```

### Phase 17 验收结果
- 老板底部导航已调整为 5 项：订单、车间、取货、客户、汇总 ✅
- `customers.html` 已成为一级菜单页面，底部 nav 激活“客户”，顶部返回按钮移除 ✅
- `boss-dashboard.html` 顶部去掉“客户 / +新建 / ⋯”，订单列表为主屏；右下角新增圆形 `+` 悬浮按钮进入 `boss-new-order.html` ✅
- 订单筛选条最左侧加入“归档订单”；默认仍选中“全部”；归档页中归档按钮激活，点击“全部”回当前订单 ✅
- PWA 资源版本提升到 `v11-2026-05-20-five-nav`，所有 HTML 脚本参数提升到 `v=20260520-five-nav` ✅
- `scripts/perf-check-worker.js` 改为自建临时订单，避免历史数据状态导致性能回归误报 ✅
- 五菜单细节快检通过：320px 小屏无横向溢出；菜单顺序为 `订单|车间|取货|客户|汇总`；归档在筛选最左；默认“全部”高亮；浮动 `+` 位于底部 nav 上方；客户页 active 正确 ✅
- 验证命令全部通过：
  - `bash scripts/status.sh` ✅
  - `node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` ✅
  - `bash scripts/build-i18n.sh` ✅
  - `node scripts/navigation-browser-qa.js` ✅
  - `node scripts/page-matrix-qa.js` ✅
  - `node scripts/browser-qa.js` ✅
  - `node scripts/customer-search-qa.js` ✅
  - `node scripts/pickup-batch-browser-qa.js` ✅
  - `./scripts/smoke.sh` ✅
  - `node scripts/perf-check-worker.js` ✅，单片操作只发 `POST /api/pieces/:id/advance`，约 `416.0ms`

### P17 补充修复：Pixel 手机底部菜单换行与 `+` 遮挡（2026-05-20）
- 现象：Google Pixel 10 手机上 5 个底部菜单文字换成两行，底栏被撑高并遮挡右下角 `+` 新建按钮。
- 修复：
  - 底部菜单项字号从 `12px` 收紧为 `11px`，间距和 padding 略减。
  - 菜单文字强制单行：`white-space: nowrap; overflow: hidden;`，防止中文标签换行撑高底栏。
  - 底部 nav 固定为 5 等分；图标字号略收紧。
  - 悬浮 `+` 上移到 `bottom: calc(98px + env(safe-area-inset-bottom))`，与底栏保持稳定间距。
  - PWA 版本提升到 `v12-2026-05-20-nav-fit`，HTML 脚本参数提升到 `v=20260520-nav-fit`。
- 复验：
  - Playwright 移动宽度 `412×915`、`393×873`、`360×800`、`320×740` 均通过：底栏高度 `62px`，`+` 与底栏间距 `36px`，无换行、无重叠、无横向溢出 ✅
  - `node scripts/navigation-browser-qa.js` ✅
  - `node scripts/page-matrix-qa.js` ✅
  - `node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` ✅

### P17 补充修复 2：底部菜单字体放大并保持单行（2026-05-20）
- 现象：底部 5 菜单已可单行展示，但 `11px` 字号偏小。
- 修复：
  - 底部菜单文字调大到 `12px`，图标调回 `18px`。
  - 保留菜单文字 `nowrap` 和溢出隐藏，确保不换行。
  - 底栏高度稳定约 `64px`，悬浮 `+` 与底栏保持约 `34px` 间距。
  - PWA 版本提升到 `v13-2026-05-20-nav-font`，HTML 脚本参数提升到 `v=20260520-nav-font`。
- 复验：
  - Playwright 移动宽度 `412×915`、`393×873`、`360×800`、`320×740` 均通过：字号 `12px`，无换行、无重叠、无横向溢出 ✅
  - `node scripts/navigation-browser-qa.js` ✅
  - `node scripts/page-matrix-qa.js` ✅
  - `node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` ✅

## Phase 18：工人“我的待做”页打磨（2026-05-20）

### 需求
工人“我的待做”是登录后的一级首页，不应有返回按钮；当前页面视觉较粗，需要在不改业务流程的前提下打磨层级、间距、卡片和列表可读性。

### 任务
- 去掉 `worker-queue.html` 顶部返回按钮。
- 重做待做数量卡、工序切换卡、返工提醒和订单列表的视觉层级。
- 保持工人无底部菜单；老板从底部“车间”进入时仍显示老板 5 菜单。
- 更新 PWA/脚本版本，避免手机继续读取旧样式。

### 验收标准
- 工人进入“我的待做”页不出现 `.back-btn`。
- 390px/412px/320px 移动宽度无横向溢出，按钮文字不挤压。
- 工序切换、待做列表、返工提醒、进入片子网格功能不回退。
- 老板访问车间页仍有底部 5 菜单，工人访问仍无底部菜单。

### 验证命令
```bash
node scripts/navigation-browser-qa.js
node scripts/page-matrix-qa.js
node scripts/browser-qa.js
node scripts/perf-check-worker.js
node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)
bash scripts/build-i18n.sh
```

### Phase 18 验收结果
- `worker-queue.html` 顶部返回按钮已移除，工人进入“我的待做”不再出现 `.back-btn` ✅
- 待做数量卡重做为左侧工序说明 + 右侧数字块；工序切换改为 3 列紧凑按钮；订单列表改为更清晰的公司分组、订单行和待做数量块 ✅
- 返工提醒卡去掉持续闪动动画，改为稳定的警示卡片 ✅
- 老板从底部“车间”进入 `worker-queue.html` 仍显示老板 5 菜单并激活“车间”；工人进入仍无底部菜单 ✅
- PWA 版本提升到 `v15-2026-05-20-worker-queue-polish`，HTML 脚本参数提升到 `v=20260520-worker-queue-polish` ✅
- 专项 Playwright 验收通过：
  - 工人视口 `412×915`、`390×844`、`320×740`：无返回按钮、无底部菜单、无横向溢出、工序切换可用、订单行可进入片子网格 ✅
  - 老板视口 `390×844`：车间页无返回按钮、底部 5 菜单存在且“车间”激活 ✅
- 验证命令全部通过：
  - `bash scripts/status.sh` ✅，服务健康在 `:8781`
  - `node scripts/navigation-browser-qa.js` ✅
  - `node scripts/page-matrix-qa.js` ✅
  - `node scripts/browser-qa.js` ✅
  - `node scripts/perf-check-worker.js` ✅，单片操作只发 `POST /api/pieces/:id/advance`，约 `495.7ms`
  - `node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` ✅
  - `bash scripts/build-i18n.sh` ✅

### P18 补充修复：`shared.css` 旧缓存导致待做样式不生效（2026-05-20）
- 现象：用户反馈“我的待做样式没了”。代码里的 `.worker-hero` / `.worker-stage-grid` 等新样式存在，但手机端仍可能加载旧 `shared.css`。
- 根因：此前只给 `api.js` / `i18n.js` 加了版本参数，`shared.css` 仍是不带 query 的 `shared.css`，PWA/浏览器缓存可能继续返回旧 CSS。
- 修复：
  - 所有 HTML 的样式引用改为 `shared.css?v=20260520-worker-css-version`。
  - JS/i18n 版本参数同步提升为 `v=20260520-worker-css-version`。
  - PWA 版本提升到 `v16-2026-05-20-worker-css-version`。
  - 缓存清理 key 提升为 `__sw_nuke_2026_05_20_worker_css_version__`。
- 复验：
  - `curl /worker-queue.html` 已返回带版本号 CSS 链接 ✅
  - `curl /shared.css?v=20260520-worker-css-version` 可看到 `.worker-hero` / `.worker-stage-grid` / `.worker-order-row` ✅
  - Playwright 验证浏览器实际加载 `shared.css?v=20260520-worker-css-version`，`.worker-hero` computed display 为 `flex`，`.worker-stage-grid` 为 `grid`，无返回按钮，无横向溢出 ✅
  - `node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` ✅
  - `bash scripts/build-i18n.sh` ✅
  - `node scripts/navigation-browser-qa.js` ✅
  - `node scripts/page-matrix-qa.js` ✅

## Phase 19：取货首页统计卡打磨（2026-05-20）

### 需求
取货菜单进入后只有提货批次列表，视觉上不够像一级工作台。需要在列表上方增加几张统计卡，让老板一进入就看到取货概况。

### 任务
- `pickup-batches.html` 顶部增加统计卡区域。
- 使用现有接口统计：
  - 可取订单数量：`GET /api/orders?status=ready_pickup`
  - 未取片数量：上述订单的 `unpicked_pieces`
  - 提货批次数量：`GET /api/pickups/batches`
  - 已取片 / 撤销片：批次列表的 `active_items` / `reverted_items`
- 保留提货批次列表和右下角 `+` 新取货入口。
- 更新 i18n、PWA/脚本/CSS 版本。

### 验收标准
- 取货首页上方显示统计卡，下面仍显示提货批次列表。
- 空批次时统计卡仍显示，并保留空状态和新取货入口。
- 老板底部 5 菜单仍激活“取货”；工人仍不能进入取货页。
- 390px/412px/320px 移动端无横向溢出，`+` 不遮挡底部菜单。

### 验证命令
```bash
node scripts/page-matrix-qa.js
node scripts/navigation-browser-qa.js
node scripts/pickup-batch-browser-qa.js
node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)
bash scripts/build-i18n.sh
```

### Phase 19 验收结果
- `pickup-batches.html` 顶部新增 2×2 统计卡：可取订单、未取片、提货批次、撤销片 ✅
- 统计数据来自现有接口：`/api/orders?status=ready_pickup&limit=100` 和 `/api/pickups/batches`，未新增后端接口 ✅
- 下方保留提货批次列表、空状态和右下角 `+` 新取货入口 ✅
- PWA 版本提升到 `v17-2026-05-20-pickup-stats`，HTML/CSS/JS 版本参数提升到 `v=20260520-pickup-stats` ✅
- 专项 Playwright 验收通过：
  - `412×915`、`390×844`、`320×740`：4 张统计卡均显示数字，底部“取货”高亮，FAB 指向 `pickup-search.html`，无横向溢出，FAB 与底部 nav 不重叠 ✅
- 验证命令全部通过：
  - `bash scripts/build-i18n.sh` ✅
  - `node scripts/page-matrix-qa.js` ✅
  - `node scripts/navigation-browser-qa.js` ✅
  - `node scripts/pickup-batch-browser-qa.js` ✅
  - `node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` ✅

## Phase 20：前端动效与过场体验优化（2026-05-21）

### 需求
前端加入过场动画和能提升使用流畅感的动效。动效必须服务操作反馈，不能拖慢工人点片、老板查单和取货流程。

### 任务
- 增加全局轻量页面进入/离开过场，用于同源 HTML 页面切换。
- 增加列表行、统计卡、客户卡、取货卡、工人待做卡的短进入动效。
- 增强底部 5 菜单、FAB、按钮、客户搜索结果、菜单弹层的按压/激活反馈。
- `withBusy()` 操作完成后给按钮一次短反馈，不改变原有 toast 和业务逻辑。
- 保留并验证 `prefers-reduced-motion: reduce`，系统关闭动画时不强行动效。
- 更新 PWA、CSS、JS 版本，避免手机端继续使用旧缓存。

### 验收标准
- 页面切换有轻量过场，底部导航和 FAB 不遮挡、不换行。
- 列表/卡片进入更顺滑，但工人片子操作仍不触发整单重拉或长动画。
- 低动效系统设置下禁用主要动画。
- 390px/412px/320px 移动端无横向溢出；现有业务 QA 全部通过。

### 验证命令
```bash
node scripts/motion-browser-qa.js
node scripts/navigation-browser-qa.js
node scripts/page-matrix-qa.js
node scripts/perf-check-worker.js
node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)
bash scripts/build-i18n.sh
```

### Phase 20 验收结果
- 已在 `frontend/js/api.js` 增加全局同源页面切换过场：页面加载后加 `motion-ready`，点击同源 HTML 链接时短暂加 `page-leaving` 再跳转；PDF、上传件、外链、下载链接不拦截 ✅
- `withBusy()` 成功完成后增加短反馈环，不改变原有禁用、spinner、toast 和错误处理逻辑 ✅
- `frontend/shared.css` 增加页面进入、顶部栏、底部导航、FAB、列表行、统计卡、客户搜索结果、工人待做卡等轻量动效，持续时间控制在 120–320ms 范围 ✅
- 保留 `prefers-reduced-motion: reduce`，动效专项 QA 确认低动效模式不会加 `motion-ready`，不会强制页面退出动画 ✅
- PWA 版本提升到 `v19-2026-05-21-motion-polish`，全部 HTML 的 CSS/JS 版本参数提升到 `v=20260521-motion-polish`，缓存清理 key 同步更新 ✅
- 新增 `scripts/motion-browser-qa.js`，覆盖 `412×915`、`390×844`、`320×740` 和 reduced-motion 场景 ✅
- 验证命令全部通过：
  - `node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` ✅
  - `bash scripts/build-i18n.sh` ✅
  - `bash scripts/status.sh` ✅，服务健康在 `:8781`
  - `node scripts/motion-browser-qa.js` ✅
  - `node scripts/navigation-browser-qa.js` ✅
  - `node scripts/page-matrix-qa.js` ✅
  - `node scripts/perf-check-worker.js` ✅，单片操作只发 `POST /api/pieces/:id/advance`，约 `466.7ms`
  - `node scripts/pickup-batch-browser-qa.js` ✅
  - `node scripts/customer-search-qa.js` ✅
  - `./scripts/smoke.sh` ✅

### P20 补充优化：过场等待 GIF（2026-05-21）
- 新增本地等待动图资源 `frontend/icons/loading.gif`，不依赖外链 ✅
- 页面同源跳转过场中加入居中等待 GIF 浮层；PDF、上传件、外链、下载链接仍不拦截 ✅
- Service Worker 预缓存 `./icons/loading.gif`，PWA/弱网场景可用 ✅
- 资源版本提升到 `v20-2026-05-21-transition-gif`，全部 HTML 的 CSS/JS 版本参数提升到 `v=20260521-transition-gif` ✅
- `scripts/motion-browser-qa.js` 增加过场 GIF 检查：点击底部菜单时必须出现 `.page-transition-loader img[src="/icons/loading.gif"]`；低动效模式不显示过场层 ✅

### P20 补充优化 2：高级动效质感升级（2026-05-21）
- 增强页面过场为玻璃质感浮层和更明显的进入/退出动效，但保持同源页面跳转总等待短于 300ms。
- 增加按钮/列表/FAB/底部导航的点击水波与微浮动反馈。
- 增加统计数字滚动、进度条流光、状态徽章细节动效，提升工作台质感。
- 动效集中在公共 `shared.css` / `api.js`，不改业务流程和权限。
- 继续保留 `prefers-reduced-motion: reduce`，低动效模式不强制显示高级动效。
- 资源版本提升到 `v21-2026-05-21-premium-motion`，全部 HTML 的 CSS/JS 版本参数提升到 `v=20260521-premium-motion`。
- 验证命令：
```bash
node scripts/motion-browser-qa.js
node scripts/navigation-browser-qa.js
node scripts/page-matrix-qa.js
node scripts/perf-check-worker.js
node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)
```
- 验收结果：
  - `node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` ✅
  - `node scripts/motion-browser-qa.js` ✅
  - `node scripts/navigation-browser-qa.js` ✅
  - `node scripts/page-matrix-qa.js` ✅
  - `node scripts/perf-check-worker.js` ✅，单片操作仍只发 `POST /api/pieces/:id/advance`
  - `node scripts/customer-search-qa.js` ✅
  - `node scripts/pickup-batch-browser-qa.js` ✅
  - `bash scripts/build-i18n.sh` ✅
  - `./scripts/smoke.sh` ✅

### P20 补充修复：取货菜单批次模糊查询（2026-05-21）
- `pickup-batches.html` 在统计卡下方新增“搜索取货记录”输入框。
- 支持按客户名、批次号、签字人、电话、取货时间做本地模糊过滤。
- 批次列表副标题增加签字人和电话，方便老板核对取货记录。
- 搜索结果显示 `显示 {shown} / {total} 个批次`；无匹配时显示统一空状态。
- 资源版本提升到 `v22-2026-05-21-pickup-batch-search`，全部 HTML 的 CSS/JS 版本参数提升到 `v=20260521-pickup-batch-search`。
- `scripts/pickup-batch-browser-qa.js` 已覆盖取货批次搜索命中、无结果、返回详情后的回退纠错流程。
- 验证通过：
  - `node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` ✅
  - `bash scripts/build-i18n.sh` ✅
  - `node scripts/pickup-batch-browser-qa.js` ✅
  - `node scripts/page-matrix-qa.js` ✅
  - `node scripts/navigation-browser-qa.js` ✅
  - `node scripts/motion-browser-qa.js` ✅
  - `node scripts/perf-check-worker.js` ✅

### P20 补充修复 2：取货首页 4 卡片可点击切换（2026-05-21）
- 修复取货菜单只展示“取货完成/提货批次”的问题。
- 取货首页 4 张统计卡改为可点击视图：
  - 可取订单：显示当前可取订单，点击行进入对应客户取货。
  - 未取片：跨客户显示所有已完成但未取的片，点击行进入对应客户取货。
  - 提货批次：显示已办理的提货批次。
  - 撤销片：显示有回退/纠错的提货批次。
- 搜索框随当前视图切换提示文案，并对当前列表做模糊查询。
- 新增 `GET /api/pickups/available/all`，供老板查看跨客户未取片，不开放给工人。
- `pickup-search.html` 支持 `?customer_id=`，从可取订单/未取片点击后自动选中客户。
- 资源版本提升到 `v23-2026-05-21-pickup-tabs`，全部 HTML 的 CSS/JS 版本参数提升到 `v=20260521-pickup-tabs`。
- `scripts/pickup-batch-browser-qa.js` 已覆盖默认可取订单、未取片、提货批次、撤销片四个视图。
- 验证通过：
  - `node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` ✅
  - `bash scripts/build-i18n.sh` ✅
  - `node scripts/pickup-batch-browser-qa.js` ✅
  - `node scripts/page-matrix-qa.js` ✅
  - `node scripts/navigation-browser-qa.js` ✅
  - `node scripts/motion-browser-qa.js` ✅
  - `./scripts/smoke.sh` ✅
  - `node scripts/perf-check-worker.js` ✅

## Phase 21：顶级动效性能安全打磨与全面 QA（2026-05-21）

### 需求
继续提升前端动效质感，但不能因为动画导致老板查单、取货查询、工人点片出现卡顿。

### 任务
- 将全局动效改成性能分级：
  - `prefers-reduced-motion: reduce` 时完全不强行动画。
  - 低配设备或省流量模式走 `motion-lite`。
  - 其他设备走 `motion-premium`。
- 列表/卡片入场改为 `IntersectionObserver` 可见区触发，并限制单页绑定动画元素数量，避免几百条列表同时动画。
- 把持续动画收敛到少量 premium 场景：
  - 进度条流光从无限循环改成一次性播放。
  - 片子网格只给前 48 片做入场动画。
  - skeleton shimmer 只在 premium 档开启。
- 动画优先使用 `transform` 和 `opacity`，去掉页面退出/卡片入场中的 `filter`。
- 给动效 QA 增加性能预算：
  - 检查 motion tier。
  - 检查单页动画元素上限。
  - 检查运行中的无限动画数量。
  - 采样 `requestAnimationFrame` 帧间隔，防止明显掉帧。
- 更新 PWA/CSS/JS 版本，避免手机继续使用旧动效资源。

### 验收标准
- 页面切换、统计卡、列表、底部菜单、FAB 仍有高级动效质感。
- 动效不会让列表页出现大量持续动画。
- 390px/412px/320px 移动端无横向溢出，底部菜单和 `+` 不遮挡。
- 工人片子操作仍只调用单片推进接口，不整单重拉。
- 取货四卡片切换、模糊查询、客户搜索、归档/查询、核心 smoke 全部通过。

### 验证命令
```bash
bash scripts/status.sh
node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)
bash scripts/build-i18n.sh
node scripts/motion-browser-qa.js
node scripts/navigation-browser-qa.js
node scripts/page-matrix-qa.js
node scripts/pickup-batch-browser-qa.js
node scripts/customer-search-qa.js
node scripts/browser-qa.js
node scripts/perf-check-worker.js
./scripts/smoke.sh
```

### Phase 21 验收结果
- `frontend/js/api.js` 已加入 `motion-lite` / `motion-premium` 分级和可见区动效调度，`MutationObserver` 只观察 `body` 并按帧合并处理新增节点 ✅
- `frontend/shared.css` 已把重动画收敛到 premium 档，列表/卡片用可见区入场，进度条流光改为一次性播放，减少持续动画占用 ✅
- PWA 版本提升到 `v24-2026-05-21-motion-perf`，全部 HTML 的 CSS/JS 版本参数提升到 `v=20260521-motion-perf`，缓存清理 key 同步更新 ✅
- 动效专项 QA 首轮发现进度条无限流光过多，已修复并复验通过 ✅
- 验证通过：
  - `bash scripts/status.sh` ✅，服务健康在 `:8781`
  - `node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` ✅
  - `bash scripts/build-i18n.sh` ✅
  - `node scripts/motion-browser-qa.js` ✅，覆盖 412/390/320 移动视口、低动效模式和帧预算
  - `node scripts/navigation-browser-qa.js` ✅
  - `node scripts/page-matrix-qa.js` ✅，30 项页面矩阵通过
  - `node scripts/pickup-batch-browser-qa.js` ✅
  - `node scripts/customer-search-qa.js` ✅
  - `node scripts/browser-qa.js` ✅
  - `node scripts/perf-check-worker.js` ✅，单片操作只发 `POST /api/pieces/:id/advance`，无整单重拉
  - `./scripts/smoke.sh` ✅

## Phase 22：订单详情取货入口统一到按片取货（2026-05-21）

### 需求
订单列表进入订单详情后，底部“调出取货签字”仍跳到旧整单取货页，不能按片取货。需要统一到新的跨订单、分片取货逻辑。

### 任务
- 订单详情 `ready_pickup` 状态的底部按钮改为跳转 `pickup-search.html?order_id=<订单ID>`。
- `pickup-search.html` 支持 `order_id`：
  - 先读取订单详情，自动选择该订单客户。
  - 默认只展示该订单当前可取片，仍然通过 `piece_ids` 创建提货批次。
  - 返回按钮回到当前订单详情。
  - 如果该订单没有可取片，展示提示，并可切到该客户全部可取片。
- 旧 `pickup-sign.html?id=<订单ID>` 改为纯兼容重定向页，自动跳到 `pickup-search.html?order_id=<订单ID>`，前端不再保留旧整单提交逻辑。
- 补充 `piece_picked_up` / `piece_pickup_reverted` 事件翻译，订单详情时间线能显示按片取货事件。
- 更新 PWA/CSS/JS 版本，避免手机旧缓存继续打开旧签字页。

### 验收标准
- 从订单详情点击“调出取货签字”进入新按片取货页面。
- 页面只显示该订单可取玻璃片，老板可选择其中几片办理取货。
- 提交后生成提货批次，不调用旧整单取货接口。
- 旧 `pickup-sign.html?id=...` 链接也会跳到新流程。
- 部分取货后订单详情时间线显示片取货事件，客户仍有剩余未取片可继续办理。

### 验证结果
- `node scripts/browser-qa.js` ✅，覆盖订单详情按钮、新旧入口跳转、按片选择 2 片生成提货批次、时间线和剩余 6 片可继续取货。
- `node scripts/pickup-batch-browser-qa.js` ✅
- `node scripts/page-matrix-qa.js` ✅
- `node scripts/navigation-browser-qa.js` ✅
- `node scripts/motion-browser-qa.js` ✅
- `node scripts/customer-search-qa.js` ✅
- `node scripts/perf-check-worker.js` ✅，单片操作仍只发 `POST /api/pieces/:id/advance`
- `./scripts/smoke.sh` ✅
- `node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` ✅
- `bash scripts/build-i18n.sh` ✅

## Phase 23：订单筛选统一等待 GIF 与背景模糊（2026-05-21）

### 需求
订单页点击“全部 / 加急 / 逾期 / 生产中 / 可取货”时，列表正在加载但没有全项目统一的等待 GIF 和背景模糊，体验不一致。

### 任务
- 将页面跳转用的 `.page-transition-loader` 抽成公共 `showTransitionLoader()` / `hideTransitionLoader()` / `withGlobalLoader()`。
- 订单页非首次加载时，筛选和搜索刷新订单列表都使用公共 loader：
  - 居中本地 `/icons/loading.gif`
  - 背景模糊遮罩
  - 最小展示时间，避免闪一下
- 快速连续点击筛选时，只渲染最后一次请求结果，避免旧请求覆盖新筛选。
- `archived=1` 页面点击“全部”返回当前订单时也先显示统一 loader。
- 更新 PWA/CSS/JS 版本，避免手机继续加载旧订单页资源。

### 验收标准
- 订单页筛选按钮点击后，必须出现统一等待 GIF 和背景模糊。
- 加载完成后遮罩自动关闭，列表显示对应筛选结果。
- 页面跳转过场仍然使用同一套 loader。
- 低动效模式仍不强制启用页面过场动画。

### 验证结果
- `node scripts/motion-browser-qa.js` ✅，新增覆盖订单筛选 loader 的 GIF 和 `backdrop-filter: blur(...)` 检查，覆盖 412/390/320 移动视口。
- `node scripts/page-matrix-qa.js` ✅
- `node scripts/browser-qa.js` ✅
- `node scripts/navigation-browser-qa.js` ✅
- `node scripts/pickup-batch-browser-qa.js` ✅
- `node scripts/perf-check-worker.js` ✅
- `./scripts/smoke.sh` ✅
- `node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` ✅

## Phase 24：订单列表模糊查询修复（2026-05-21）

### 问题
订单列表搜索框看起来“没效果”。实际排查发现两类问题：
- 后端只按原始字符串 `LIKE` 搜索，订单号 `2605011-220` 输入成 `2605011220` 时搜不到。
- 自动化 QA 没有等待搜索接口返回，容易在初始 100 条列表里误判搜索未生效。

### 任务
- 后端 `/api/orders` 搜索改为分词模糊匹配，支持订单号、项目名、备注、客户公司、联系人、电话、邮箱、日期。
- 对订单号/客户名/电话等字段增加“紧凑匹配”，忽略横线、空格、`#`、`/`、`.`、`_`、括号、`+` 等常见分隔符。
- 多个关键词按 AND 收敛结果，避免几百个客户/订单时越搜越乱。
- 浏览器 QA 增加订单列表搜索断言：用不带横线的订单号搜索，必须等待 `/api/orders?search=...` 返回，并且列表只显示目标订单。

### 验收标准
- 输入完整订单号可搜索到订单。
- 输入去掉横线/空格的订单号也可搜索到订单。
- 输入多个关键词能进一步缩小结果。
- 手机端订单列表在搜索接口返回后更新，不停留在初始 100 条列表。

### 验证命令
```bash
node -c backend/routes/orders.js
node -c scripts/browser-qa.js
node scripts/browser-qa.js
./scripts/smoke.sh
```

### 验证结果
- `node -c backend/routes/orders.js` ✅
- `node -c scripts/browser-qa.js` ✅
- `node scripts/browser-qa.js` ✅，覆盖订单列表用无横线订单号搜索，列表只剩目标订单
- `./scripts/smoke.sh` ✅，订单创建、工序、取货、归档主链路通过

## Phase 25：订单列表长按快捷菜单（2026-05-21）

### 需求
老板在订单列表不想先进入详情再操作。订单列表需要支持手机长按订单行，弹出快捷菜单，菜单里展示“修改订单”和订单详情页右下角主按钮对应的动作。

### 任务
- 订单列表行增加 `data-order-id`，普通点击仍进入订单详情。
- 手机触摸长按订单行打开快捷菜单，桌面右键也可打开，避免影响正常点按。
- 快捷菜单动作按订单状态动态展示：
  - 未完成：查看车间。
  - 已完成但未通知：通知可取货。
  - 可取货：调出取货签字。
  - 已取货：重发交割单。
- 菜单同时包含“修改订单”和“订单详情”；已取货订单补充归档、撤销取货。
- 订单列表页补齐修改订单弹窗，复用详情页的订单字段和片子工序/备注编辑逻辑。
- 长按时增加轻量按压反馈，并禁用手机系统长按选中文本。
- PWA/CSS/JS 版本提升到 `v27-2026-05-21-order-longpress`，避免手机旧缓存。

### 验收标准
- Pixel 手机上长按订单行会弹出快捷菜单。
- 普通点击订单行仍进入订单详情。
- 长按菜单必须包含“修改订单”和当前订单详情底部主动作。
- 点击“修改订单”能在列表页直接打开编辑弹窗，保存后列表刷新。
- 对主业务链路无回归。

### 验证结果
- `node -c frontend/js/api.js` ✅
- `node -c scripts/browser-qa.js` ✅
- `bash scripts/build-i18n.sh` ✅
- `node scripts/browser-qa.js` ✅，覆盖订单列表触摸长按菜单和列表页修改订单弹窗
- `node scripts/navigation-browser-qa.js` ✅
- `node scripts/page-matrix-qa.js` ✅
- `./scripts/smoke.sh` ✅

## Phase 26：订单列表补充“已取货”筛选（2026-05-21）

### 问题
老板想在订单列表长按已取货订单进行归档，但当前订单页只有“全部 / 加急 / 逾期 / 生产中 / 可取货”，没有“已取货”。当未归档订单超过 100 条时，“全部”只加载最新 100 条，较早的已取货订单会被新订单挤出列表，看起来像无法展示已取货订单。

### 任务
- 在订单列表筛选栏增加“已取货”标签。
- 点击后调用 `/api/orders?status=picked_up`，只展示未归档的已取货订单。
- 已取货订单长按菜单继续展示“重发交割单 / 移入归档 / 撤销取货”。
- PWA/CSS/JS 版本提升到 `v28-2026-05-21-picked-filter`，避免手机旧缓存。
- 浏览器 QA 增加完整验证：部分取货后验证剩余 6 片，再取完剩余片，回到订单列表点击“已取货”，确认目标订单出现并且长按菜单有“移入归档”。

### 验收标准
- 老板可以从订单列表点击“已取货”看到未归档的已取货订单。
- 在“已取货”列表中长按订单，可以直接归档。
- “归档订单”仍只显示已归档订单。
- 普通订单列表、取货、归档主链路无回归。

### 验证结果
- `node -c frontend/js/api.js` ✅
- `node -c scripts/browser-qa.js` ✅
- `bash scripts/build-i18n.sh` ✅
- `node scripts/browser-qa.js` ✅，覆盖“已取货”筛选和长按归档菜单
- `node scripts/navigation-browser-qa.js` ✅
- `node scripts/page-matrix-qa.js` ✅
- `./scripts/smoke.sh` ✅

## Phase 27：订单列表筛选区降噪与统计卡快捷筛选（2026-05-21）

### 问题
订单列表顶部筛选条有 7 个入口（归档、全部、加急、逾期、生产中、可取货、已取货），Pixel 手机上显得拥挤，并且与上方 4 个统计卡产生冗余。

### 任务
- 4 个统计卡改为可点击快捷筛选：
  - 订单总数 → 全部。
  - 生产中 → 生产中。
  - 待取货 → 可取货。
  - 待补片 → 待补片。
- 筛选条精简为 4 个主入口：
  - 全部
  - 已取货
  - 归档
  - 筛选
- “筛选”二级菜单包含：加急、逾期、生产中、可取货、待补片。
- 归档改为同页视图切换，不再依赖拥挤的独立链接。
- 保持已取货列表可长按归档。
- PWA/CSS/JS 版本提升到 `v29-2026-05-21-dashboard-filters`，避免手机旧缓存。

### 验收标准
- Pixel 手机订单页筛选条只显示 4 个入口，不横向拥挤。
- 统计卡点击后能直接切换对应筛选。
- “筛选”菜单能打开并展示二级筛选项。
- 已取货和归档仍能从主入口直接进入。
- 长按订单菜单、按片取货、归档、搜索、动效无回归。

### 验证结果
- `node -c frontend/js/api.js` ✅
- `node -c scripts/browser-qa.js` ✅
- `node -c scripts/motion-browser-qa.js` ✅
- `bash scripts/build-i18n.sh` ✅
- `node scripts/browser-qa.js` ✅，覆盖 4 入口筛选条、统计卡快捷筛选、二级筛选菜单、已取货长按归档入口
- `node scripts/navigation-browser-qa.js` ✅
- `node scripts/motion-browser-qa.js` ✅，覆盖 412/390/320 移动视口和低动效模式
- `node scripts/page-matrix-qa.js` ✅
- `./scripts/smoke.sh` ✅

## Phase 28：上线前安全 QA 修复（2026-05-21）

### 问题
安全 QA 发现 6 项上线阻断/可复现问题：
- 工人账号可直接读取老板侧订单详情、客户列表，泄露客户邮箱、事件、取货记录。
- `/uploads` 被匿名静态暴露，图纸、签名、交割单只要拿到 URL 就能下载。
- 新建订单 `priority` 缺少前置校验，非法值触发 DB 约束并返回 500。
- 取货签名只检查 Buffer 非空，不校验有效 PNG，垃圾 base64 会导致 PDF 生成 500。
- 多个 QA 脚本依赖 `bossdemo/workerdemo`，干净 DB 只 seed `admin/worker`。
- 浏览器 QA 依赖 Playwright，但 `backend/package.json` 没声明，fresh clone 不能复现完整 QA。

### 任务
- 对老板侧读接口加角色限制：
  - `/api/orders`、`/api/orders/:id` 只允许 boss。
  - `/api/customers` 只允许 boss。
- 保持工人功能可用：
  - 工人待做继续使用 `/api/pieces`。
  - 工人片子网格从 `/api/orders/:id` 改为使用工人可访问的 pieces 查询，避免读取客户邮箱/events/pickups。
- 移除匿名 `/uploads` 静态服务，改为受保护的文件下载路由：
  - 未登录访问 `/uploads/...` 返回 401。
  - 工人只能读取 `/uploads/orders/...` 图纸。
  - 老板可读取图纸、签名、交割单、上传 PDF。
  - 阻止路径穿越。
- 新建订单校验 `priority`，非法值返回 400。
- 新增签名 PNG 校验，单订单取货和批量取货都在写文件/生成 PDF 前返回 400。
- DB seed 增加 `bossdemo/boss123456` 和 `workerdemo/worker123456`，README 同步说明。
- 把 `playwright` 加入项目依赖，确保浏览器 QA 可复现。
- 增加安全回归脚本，覆盖 worker RBAC、匿名文件保护、非法 priority、非法签名。

### 验收标准
- worker 调老板订单/客户接口返回 403。
- worker 工人页面仍能打开待做和片子图纸。
- 匿名访问任意 `/uploads/orders|slips|signatures|pdfs` 返回 401。
- worker 不能访问 slips/signatures/pdfs，boss 可以访问。
- 非法 priority 返回 400，不返回 500。
- 非 PNG 签名返回 400，不返回 500。
- 干净 DB 初始化包含 admin/worker/bossdemo/workerdemo。
- `npm install` 后浏览器 QA 依赖可由项目自身提供。

### 验证命令
```bash
node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)
bash scripts/status.sh
node scripts/security-regression.js
node scripts/pickup-batch-smoke.js
node scripts/summary-smoke.js
node scripts/browser-qa.js
node scripts/navigation-browser-qa.js
node scripts/page-matrix-qa.js
node scripts/motion-browser-qa.js
node scripts/perf-check-worker.js
node scripts/customer-search-qa.js
node scripts/pickup-batch-browser-qa.js
./scripts/smoke.sh
```

### 验证结果
- `node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` ✅
- `bash scripts/status.sh` ✅，服务运行在 `http://localhost:8781`
- `node scripts/security-regression.js` ✅，覆盖 worker RBAC、匿名/角色文件访问、非法 priority、非法签名、有效批量取货文件权限
- `node scripts/pickup-batch-smoke.js` ✅
- `node scripts/summary-smoke.js` ✅
- `node scripts/browser-qa.js` ✅
- `node scripts/navigation-browser-qa.js` ✅
- `node scripts/page-matrix-qa.js` ✅
- `node scripts/motion-browser-qa.js` ✅
- `node scripts/perf-check-worker.js` ✅，单片操作只发 `POST /api/pieces/:id/advance`
- `node scripts/pickup-batch-browser-qa.js` ✅
- `./scripts/smoke.sh` ✅
- `bash scripts/build-i18n.sh` ✅
- `cd backend && npm ls playwright --depth=0` ✅，项目依赖可解析到 `playwright@1.60.0`

### 完成结果
- `/api/orders`、`/api/orders/:id`、`/api/customers` 已收紧为 boss-only。
- 工人片子网格改用 `/api/pieces?order_id=...`，不再依赖老板订单详情 payload。
- `/uploads` 改为鉴权文件流：匿名 401，worker 仅可读 `uploads/orders` 图纸，boss 可读图纸/PDF/签名/取货单；响应 `Cache-Control: private, no-store`。
- 前端图纸和 PDF 下载改为登录态 blob URL，避免匿名直链。
- 新建订单 `priority` 非法值前置返回 400。
- 单订单取货和批量取货都用严格 PNG 签名校验，垃圾 base64 返回 400。
- 干净 DB seed 增加 `bossdemo/boss123456`、`workerdemo/worker123456`，README 已同步。
- `backend/package.json` / lockfile 已声明 Playwright。

## Phase 29：订单总览统计口径统一（2026-05-21）

### 问题
老板订单页顶部 4 个统计卡当前从“当前列表接口返回的前 100 条订单”里计算。点击生产中、待取货、待补片或搜索后，列表数据变化，统计卡数字也跟着变化，导致同一个总览区出现不同口径。

### 任务
- 新增 boss-only `/api/orders/stats`，按当前视图范围（未归档 / 已归档）直接从数据库汇总，不受列表筛选、搜索、分页限制影响。
- 顶部 4 个统计卡只使用 `/api/orders/stats` 的结果：
  - 订单总数：当前视图范围内订单总数。
  - 生产中：`status='in_production'` 订单数。
  - 待取货：`status='ready_pickup'` 订单数，包含部分取货后仍有未取片的订单。
  - 待补片：需补切片数。
- 顶部补片/逾期提醒也使用同一套稳定统计，避免切换筛选后提醒忽隐忽现。
- 后端 `/api/orders` 补齐 `filter=overdue|rework`，避免“统计有数量但列表只在前 100 条里筛”的错觉。
- 浏览器 QA 增加断言：搜索、点击统计卡筛选后，4 个统计数字保持不变。
- 安全回归补充：worker 不能访问 `/api/orders/stats`。

### 验收标准
- 点击“订单总数 / 生产中 / 待取货 / 待补片”统计卡只改变下面列表，4 个统计数字不变。
- 输入订单号/公司名搜索时，统计卡数字不随搜索结果变化。
- 待补片、逾期列表由后端过滤，不受首页 100 条分页限制。
- 工人账号访问统计接口返回 403。
- 现有搜索、归档、已取货、长按菜单、取货、汇总、安全回归无回归。

### 验证命令
```bash
node -c backend/routes/orders.js
node -c scripts/browser-qa.js
node -c scripts/security-regression.js
bash scripts/restart.sh
node scripts/security-regression.js
node scripts/browser-qa.js
node scripts/navigation-browser-qa.js
node scripts/page-matrix-qa.js
node scripts/motion-browser-qa.js
./scripts/smoke.sh
```

### 验证结果
- `node -c backend/routes/orders.js` ✅
- `node -c scripts/browser-qa.js` ✅
- `node -c scripts/security-regression.js` ✅
- `node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` ✅
- `bash scripts/restart.sh` ✅，服务运行在 `http://localhost:8781`
- 接口抽查 ✅：
  - `/api/orders/stats` 返回全局未归档统计，不受列表筛选影响。
  - `/api/orders?status=in_production`、`/api/orders?status=ready_pickup`、`/api/orders?filter=rework`、`/api/orders?filter=overdue` 的 `total` 与统计口径一致。
  - worker 访问 `/api/orders/stats` 返回 403。
- `node scripts/security-regression.js` ✅，新增覆盖 worker 不能访问订单统计接口。
- `node scripts/browser-qa.js` ✅，覆盖搜索后统计不变、点击统计卡筛选后统计不变、长按菜单、已取货筛选。
- `node scripts/navigation-browser-qa.js` ✅
- `node scripts/summary-smoke.js` ✅
- `bash scripts/build-i18n.sh` ✅
- `node scripts/page-matrix-qa.js` ✅
- `node scripts/motion-browser-qa.js` ✅
- `node scripts/pickup-batch-smoke.js` ✅
- `node scripts/customer-search-qa.js` ✅
- `node scripts/perf-check-worker.js` ✅
- `node scripts/pickup-batch-browser-qa.js` ✅
- `./scripts/smoke.sh` ✅，独立重跑通过完整订单/工序/取货/归档主链路。

### 完成结果
- 订单总览顶部 4 个统计卡现在由 `/api/orders/stats` 提供稳定全局数字，不再随搜索、分页或当前筛选列表变化。
- 点击统计卡只作为快捷筛选入口，改变下面订单列表，不改变顶部统计口径。
- 补片、逾期列表筛选改为后端过滤，避免从前 100 条里二次筛选造成空列表/漏单。
- 补片和逾期提醒改用同一套统计口径，不再因为切换筛选忽隐忽现。
- PWA 版本提升到 `v31-2026-05-21-dashboard-stats`，前端资源版本提升到 `20260521-dashboard-stats`，手机端会清旧缓存。

## Phase 30：取货统计卡选中态统一（2026-05-21）

### 问题
取货页顶部统计卡选中态是紫色描边和底部横线，订单页统计卡选中态是黑色细边框加柔和外环。两个一级菜单的同类卡片视觉语言不一致。

### 任务
- 取货页 `.pickup-stat-card.active` 改成与订单页 `.stat-action.active` 一致：
  - 黑色细边框。
  - 柔和外环阴影。
  - 无紫色底部横线。
  - 无渐变背景。
- 更新取货页资源版本和 PWA 版本，避免手机端旧 CSS 缓存。
- 浏览器 QA 增加断言：取货统计卡 active 样式必须与订单统计卡 active 样式一致。

### 验收标准
- 取货页点击 4 个统计卡时，选中态和订单页统计卡一致。
- Pixel 手机视口无横向溢出，底部菜单和 FAB 不遮挡。
- 动效、取货批次、订单页、导航、页面矩阵无回归。

### 验证命令
```bash
node -c frontend/js/api.js frontend/sw.js scripts/pickup-batch-browser-qa.js
node scripts/pickup-batch-browser-qa.js
node scripts/page-matrix-qa.js
node scripts/motion-browser-qa.js
node scripts/navigation-browser-qa.js
node scripts/browser-qa.js
bash scripts/status.sh
```

### 验证结果
- `node -c frontend/js/api.js frontend/sw.js scripts/pickup-batch-browser-qa.js` ✅
- `node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` ✅
- `bash scripts/restart.sh` ✅，服务运行在 `http://localhost:8781`
- `node scripts/pickup-batch-browser-qa.js` ✅，新增覆盖取货统计卡 active 样式与订单统计卡一致。
- `node scripts/page-matrix-qa.js` ✅
- `node scripts/motion-browser-qa.js` ✅
- `node scripts/navigation-browser-qa.js` ✅
- `node scripts/browser-qa.js` ✅
- `bash scripts/status.sh` ✅

### 完成结果
- 取货页统计卡 active 状态已改为订单页同款黑色细边框 + 柔和外环。
- 移除了取货统计卡 active 的紫色底部横线和渐变背景。
- `pickup-batches.html` 资源版本提升到 `20260521-pickup-card-active`。
- PWA 版本提升到 `v32-2026-05-21-pickup-card-active`，缓存清理 key 同步更新。

## Phase 31：QA 回归阻断修复与前端体验补强（2026-05-21）

### 问题
QA 复核指出两条上线阻断和若干体验欠账：
- `backend npm run smoke` 的 PDF 残留断言可能红；当前单独复跑通过，但脚本用全目录 PDF 数量判断，容易被并行 QA 污染。
- 批量取货批次号通过“取最后一条 +1”生成，存在并发/重入唯一键冲突风险，曾复现 `/api/pickups/batches` 500。
- 取货批次详情页用浏览器原生 `prompt()` 输入回退原因，移动端体验粗糙。
- 取货搜索页是长表单，客户、选片、签字缺少步骤聚焦。
- 客户对账页缺少顶部摘要卡片。
- 工人工位不记忆上次工序。

### 任务
- 后端新增 `pickup_batch_counters` 计数表，用数据库事务原子分配 `PU-YYMMDD-0001` 批次号，避免唯一键 500。
- smoke 改为检查本次无效/重复上传的唯一文件名是否被清理，不再用全目录 PDF 数量。
- 取货批次详情页移除 `prompt()`，改成站内 textarea 模态，支持必填校验和移动端样式。
- 取货搜索页增加 3 步流程提示，未选片前隐藏/弱化签字区，让首屏聚焦客户和可取玻璃。
- 客户对账页增加总订单、已取片、未取片、提货批次摘要卡片。
- 工人工位记忆上次选择的工序。

### 验收标准
- `cd backend && npm run smoke` 独立通过。
- `node scripts/security-regression.js` 通过，且批量取货不再出现 `pickup_batches.batch_number` 唯一约束 500。
- 取货批次详情页不再触发浏览器原生 dialog。
- 取货搜索页在未选片时不直接展示签名表单；选片后签名表单出现并可提交。
- 客户对账页顶部能一眼看到订单/已取/未取/批次数。
- 工人工位刷新后保持上次工序。

### 验证命令
```bash
node -c backend/db.js backend/routes/pickups.js backend/routes/orders.js frontend/js/api.js frontend/sw.js scripts/security-regression.js scripts/pickup-batch-browser-qa.js scripts/browser-qa.js scripts/page-matrix-qa.js scripts/perf-check-worker.js
bash scripts/restart.sh
cd backend && npm run smoke
node scripts/security-regression.js
node scripts/pickup-batch-smoke.js
node scripts/pickup-batch-browser-qa.js
node scripts/browser-qa.js
node scripts/page-matrix-qa.js
node scripts/navigation-browser-qa.js
node scripts/motion-browser-qa.js
node scripts/perf-check-worker.js
node scripts/summary-smoke.js
```

### 验证结果
- `node -c backend/db.js backend/routes/pickups.js backend/routes/orders.js frontend/js/api.js frontend/js/i18n.js frontend/sw.js scripts/security-regression.js scripts/pickup-batch-browser-qa.js scripts/browser-qa.js scripts/page-matrix-qa.js scripts/perf-check-worker.js` ✅
- `bash -n backend/scripts/smoke.sh scripts/smoke.sh` ✅
- `bash scripts/restart.sh` ✅，迁移后服务运行在 `http://localhost:8781`
- `cd backend && npm run smoke` ✅，PDF 清理断言改为检查本次唯一文件名，不受并行 QA 污染。
- `node scripts/security-regression.js` ✅，批量取货不再因 `pickup_batches.batch_number` 唯一约束返回 500。
- `node scripts/pickup-batch-smoke.js` ✅
- 连续创建两个取货批次专项验证 ✅，批次号递增：`PU-260521-0077` → `PU-260521-0078`
- `node scripts/pickup-batch-browser-qa.js` ✅，覆盖回退原因站内模态，确认不触发原生 dialog。
- `node scripts/browser-qa.js` ✅
- `node scripts/page-matrix-qa.js` ✅
- `node scripts/navigation-browser-qa.js` ✅
- `node scripts/motion-browser-qa.js` ✅
- `node scripts/perf-check-worker.js` ✅
- `node scripts/summary-smoke.js` ✅

### 完成结果
- `pickup_batch_counters` 计数表已加入迁移，批次号分配会先对齐当日历史最大编号，再原子递增。
- `/api/pickups/batches` 已避免“查最后一条 +1”的重入/并发撞号风险。
- smoke 的 PDF 清理断言不再使用全目录数量，改为检查本次无效/重复上传文件名是否残留。
- `pickup-batch-detail.html` 的回退原因输入从原生 `prompt()` 改为站内 textarea 模态。
- `pickup-search.html` 增加客户、选片、签字三步提示；未选片前隐藏签字表单。
- `summary-customer.html` 增加订单、已取片、未取片、提货批次摘要卡。
- `worker-queue.html` 会记忆上次选择的工序。
- 前端资源版本提升到 `20260521-regression-polish`，PWA 版本提升到 `v33-2026-05-21-regression-polish`。

## Phase 32：交付缓存与 QA 文档收口（2026-05-21）

### 问题
终验没有发现阻断缺陷，但还有 3 个交付层面的低风险隐患：
- HTML 资源 query 参数混用 `20260521-security-hardening`、`20260521-dashboard-stats`、`20260521-pickup-card-active` 和 `20260521-regression-polish`，PWA 缓存路径下可能出现页面加载不同代际 CSS/JS。
- README 只写了 smoke 和泛浏览器 QA，没有把发布前关键 QA 命令列成一套显性清单。
- 默认运行目录一直使用 `backend/glass.db` 和 `backend/uploads/`，QA 脚本会持续写入演示/测试数据，需要在交接文档里说明。

### 任务
- 统一所有前端 HTML 的 `shared.css`、`api.js`、`i18n.js` query 参数到 `20260521-regression-polish`。
- README 增加发布前 QA 清单，覆盖后端 smoke、安全回归、浏览器矩阵、导航、动画、性能、取货批次和汇总验证。
- README 增加测试数据说明，明确默认 DB/uploads 是共享运行目录，QA 会写入数据，交付/演示前需要备份或清理。

### 验收标准
- `frontend/*.html` 内不再出现旧资源版本号。
- README 能直接指导新环境执行发布前 QA。
- README 明确说明 `backend/glass.db` 和 `backend/uploads/` 的共享数据风险。

### 验证命令
```bash
rg "20260521-" frontend/*.html
rg "security-regression|page-matrix|browser-qa|backend/glass.db|backend/uploads" README.md
node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)
node scripts/page-matrix-qa.js
node scripts/navigation-browser-qa.js
bash scripts/status.sh
```

### 验证结果
- `rg "20260521-" frontend/*.html` ✅，全部 HTML 资源 query 均为 `20260521-regression-polish`。
- `rg "20260521-(security-hardening|dashboard-stats|pickup-card-active|motion|transition|premium|pickup-tabs|pickup-batch-search)" frontend/*.html || true` ✅，旧版本参数已清空。
- `rg "security-regression|page-matrix|browser-qa|backend/glass.db|backend/uploads" README.md` ✅
- `node -c $(find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' | sort)` ✅
- `node scripts/page-matrix-qa.js` ✅，`PAGE MATRIX QA PASS checks=30`
- `node scripts/navigation-browser-qa.js` ✅，`NAVIGATION BROWSER QA PASS boss=bottom-nav worker=no-nav`
- `bash scripts/status.sh` ✅，服务运行在 `http://localhost:8781`，健康检查返回 `{"ok":true}`。

### 完成结果
- 前端 HTML 资源版本已统一到 `20260521-regression-polish`，与当前 SW 版本 `v33-2026-05-21-regression-polish` 对齐。
- README 已补充发布前 QA 清单。
- README 已补充 `backend/glass.db` 和 `backend/uploads/` 共享运行目录说明，明确 QA 会写入测试数据。

## Phase 33：产品体验层级打磨（2026-05-21）

### 问题
当前版本已经没有阻断缺陷，但几处页面仍偏“后台工具”：
- 老板订单首页首屏层级偏平，提醒、统计、筛选、搜索和列表同时出现，决策优先级不够清楚。
- 取货搜索页虽然有三步提示，但仍像长页表单，选片后缺少自动推进和固定已选反馈。
- 取货批次详情页偏列表，不够像交割单详情，批次数量和回退状态不够醒目。
- 客户管理页新增入口、洞察卡、搜索框竞争注意力，查找客户的主任务不够前置。
- 登录失败提示只是表单内红字，移动端存在感偏弱。
- README 发布前 QA 清单还未分层，接手者不容易判断必跑和专项检查。

### 任务
- 老板首页增加任务优先区，把待补片、逾期、待取货作为首屏动作入口；筛选条改为高频视图，归档弱化到更多菜单。
- 取货搜索页增强 stepper 的 sticky 锚点感，固定显示已选数量，选片后自动滚到签字区。
- 取货批次详情页增加批次摘要，总订单数、总片数、已回退片数；把单片回退收进行内二级菜单。
- 客户页把搜索框前置，新增客户入口弱化成顶部小按钮，洞察卡下移。
- 登录页错误反馈改为更明显的状态卡，支持多行提示。
- README QA 清单分成必跑、浏览器覆盖、专项回归三组。

### 验收标准
- 老板首页首屏能先看到异常和待处理任务，归档不再和高频状态并列抢位。
- 取货搜索页选中片子后能自动推进到签字区，并在底部固定显示已选片数。
- 取货批次详情页顶部能直接看到批次规模和回退数量；默认界面更偏查看。
- 客户页首屏优先支持搜索客户，新增客户入口保留但降低视觉权重。
- 登录失败提示比原红字更醒目，且不破坏登录 QA。
- README 能区分必跑检查、浏览器覆盖和专项回归。

### 验证命令
```bash
node -c frontend/js/i18n.js frontend/js/api.js frontend/js/i18n/zh.js frontend/js/i18n/en.js scripts/browser-qa.js scripts/pickup-batch-browser-qa.js scripts/page-matrix-qa.js
node scripts/browser-qa.js
node scripts/pickup-batch-browser-qa.js
node scripts/page-matrix-qa.js
node scripts/navigation-browser-qa.js
node scripts/motion-browser-qa.js
node scripts/customer-search-qa.js
bash scripts/status.sh
```

### 验证结果
- `bash scripts/build-i18n.sh` ✅
- `node -c frontend/js/i18n.js frontend/js/api.js frontend/js/i18n/zh.js frontend/js/i18n/en.js scripts/browser-qa.js scripts/pickup-batch-browser-qa.js scripts/page-matrix-qa.js` ✅
- `node scripts/browser-qa.js` ✅，覆盖老板首页任务入口、收敛后的筛选、订单搜索、长按菜单、按片取货和已取货归档菜单。
- `node scripts/pickup-batch-browser-qa.js` ✅，覆盖取货搜索已选数量、批次详情摘要、行内菜单回退和站内回退模态。
- `node scripts/page-matrix-qa.js` ✅，`PAGE MATRIX QA PASS checks=30`
- `node scripts/navigation-browser-qa.js` ✅，老板底部导航和工人无底部导航通过。
- `node scripts/motion-browser-qa.js` ✅，3 个移动视口和 reduced-motion 通过。
- `node scripts/customer-search-qa.js` ✅，客户搜索、客户洞察和移动端无横溢通过。
- `bash scripts/status.sh` ✅，服务运行在 `http://localhost:8781`，健康检查返回 `{"ok":true}`。
- 资源版本提升后复跑 `node scripts/page-matrix-qa.js` ✅，确认 `20260521-product-polish` 资源路径加载正常。

### 完成结果
- 老板首页新增待处理任务入口：待补片、逾期、待取货；归档已弱化到“筛选”菜单。
- 取货搜索页 stepper 改为 sticky 锚点，底部确认按钮显示已选片数，首次选片后自动滚到签字区。
- 取货批次详情页新增订单数、取货片数、回退片数摘要；单片回退收进行内菜单。
- 客户页搜索框前置，新增客户入口改为顶部轻按钮。
- 登录失败提示改为醒目的状态卡。
- README 发布前 QA 清单已分为必跑、浏览器主流程、专项回归三组。
- 前端资源版本提升到 `20260521-product-polish`，PWA 版本提升到 `v34-2026-05-21-product-polish`。

## Phase 34：前端样式与渲染基础收敛（2026-05-21）

### 问题
当前前端已经进入产品打磨阶段，但还有几类长期维护风险：
- 页面内联样式仍较多，stat card、list row、section header、action strip 等模式分散。
- 多个页面继续用字符串 `innerHTML` 重复拼同类 UI，后续视觉和文案容易漂。
- 老板首页和取货流程仍有一定信息噪音，已选状态和任务优先级还能更清楚。
- 客户页/客户对账页在数据变多后扫读效率还可以继续提升。

### 任务
- 在 `frontend/js/api.js` 增加轻量 render helper：`renderStatCells`、`renderPanel`、`renderSectionHeader`、`renderPickupSteps`。
- 在 `frontend/shared.css` 增加通用 class：`content-shell`、`section-panel`、`section-head`、`metrics-grid`、`task-priority-stack`、`order-card-layout`、`pickup-selected-note` 等，减少页面内联样式。
- 老板首页把任务入口进一步作为首屏优先区，普通统计与列表保持但弱化结构噪音。
- 取货搜索 stepper 增加已选片数提示，让“当前已选/下一步签字”更明确。
- 取货批次详情、客户对账页改用通用 metrics/grid helper。
- 客户列表增加轻量排序提示，默认强调最近业务和搜索。

### 验收标准
- 高频页面的同类结构优先使用共享 class/helper，减少重复内联样式。
- 老板首页、取货搜索、批次详情、客户页、客户对账页视觉仍一致，移动端不横溢。
- 现有业务流程不回归：订单搜索、长按菜单、按片取货、批次回退、客户搜索、页面矩阵全部通过。

### 验证命令
```bash
bash scripts/build-i18n.sh
node -c frontend/js/i18n.js frontend/js/api.js frontend/js/i18n/zh.js frontend/js/i18n/en.js scripts/browser-qa.js scripts/pickup-batch-browser-qa.js scripts/page-matrix-qa.js
node scripts/browser-qa.js
node scripts/pickup-batch-browser-qa.js
node scripts/page-matrix-qa.js
node scripts/navigation-browser-qa.js
node scripts/motion-browser-qa.js
node scripts/customer-search-qa.js
bash scripts/status.sh
```

### 验证结果
- `bash scripts/build-i18n.sh` ✅
- `node -c frontend/js/i18n.js frontend/js/api.js frontend/js/i18n/zh.js frontend/js/i18n/en.js scripts/browser-qa.js scripts/pickup-batch-browser-qa.js scripts/page-matrix-qa.js` ✅
- `node scripts/browser-qa.js` ✅
- `node scripts/pickup-batch-browser-qa.js` ✅
- `node scripts/page-matrix-qa.js` ✅，`PAGE MATRIX QA PASS checks=30`
- `node scripts/navigation-browser-qa.js` ✅
- `node scripts/customer-search-qa.js` ✅
- `node scripts/motion-browser-qa.js` 首轮发现 `.content-shell` 未纳入页面入场动画选择器，已修复后复跑 ✅，`MOTION BROWSER QA PASS viewports=3 reduced-motion=1`
- `bash scripts/status.sh` ✅，服务运行在 `http://localhost:8781`，健康检查返回 `{"ok":true}`。
- `rg "20260521-" frontend/*.html | rg -v "20260521-ui-foundation" || true` ✅，HTML 资源版本已统一。

### 完成结果
- 新增 `renderStatCells`、`renderPanel`、`renderSectionHeader`、`renderPickupSteps` 轻量公共渲染 helper。
- 新增 `content-shell`、`section-panel`、`section-head`、`metrics-grid`、`metric-cell`、`order-card-layout`、`pickup-selected-note` 等共享 class。
- 老板首页、取货搜索、取货批次详情、客户对账页已接入部分共享 helper/class，减少重复内联样式。
- 取货搜索 stepper 增加已选片数提示，客户页增加默认排序/搜索提示。
- 动效系统已覆盖新的 `.content-shell` 页面容器。
- 前端资源版本提升到 `20260521-ui-foundation`，PWA 版本提升到 `v35-2026-05-21-ui-foundation`。

## Phase 35：移动端细节、列表性能与运行隔离（2026-05-21）

### 问题
当前版本已无阻断缺陷，但还有三类值得在上线前收口的问题：
- 客户页和汇总页在数据增长后仍以整表重绘为主，搜索输入缺少 debounce，长列表时会先感到“钝”。
- 取货搜索等移动端高频页已可用，但已选状态与流程焦点还能更稳，尤其在长客户列表下。
- 当前项目脚本默认总是复用 `backend/.env`、`backend/glass.db` 和 `backend/uploads/`；README 已提示风险，但演示/正式/QA 仍缺少真正可执行的隔离手段。

### 任务
- 客户页搜索增加 debounce，并把搜索过滤结果、快速跳转和列表渲染尽量收敛到同一条轻量路径，减少高频整页抖动。
- 汇总页和客户对账页继续接入共享 helper/class，压缩内联布局噪音并保持移动端可扫读性。
- 取货搜索页在客户切换和选片后维持更稳定的流程状态提示，减少长页来回确认。
- 后端接入可配置 `UPLOADS_DIR`，让上传目录与 `DB_PATH` 一样可切换。
- 项目脚本支持通过 `ENV_FILE` 选择独立运行 profile，并补充演示环境初始化/备份脚本，真正做到演示数据隔离。

### 验收标准
- 客户页搜索输入不会每击键立刻全量重绘，页面在现有 QA 下保持通过。
- 汇总页、客户对账页继续使用共享 helper/class，移动端无横溢。
- `UPLOADS_DIR` 未配置时行为与当前兼容；配置后上传与读取都指向新目录。
- `ENV_FILE=<path> ./scripts/start.sh` 能正常启动，健康检查通过。
- 备份/演示脚本可生成独立 env/profile，不污染默认 `backend/glass.db` 与 `backend/uploads/`。

### 验证命令
```bash
node -c backend/server.js backend/db.js backend/routes/orders.js backend/routes/pickups.js backend/routes/customers.js frontend/js/api.js scripts/start.sh scripts/status.sh scripts/smoke.sh scripts/init-demo-env.sh scripts/backup-runtime.sh
bash scripts/build-i18n.sh
ENV_FILE=backend/.env ./scripts/restart.sh
bash scripts/status.sh
cd backend && npm run smoke
node scripts/security-regression.js
node scripts/browser-qa.js
node scripts/pickup-batch-browser-qa.js
node scripts/page-matrix-qa.js
node scripts/navigation-browser-qa.js
node scripts/motion-browser-qa.js
node scripts/customer-search-qa.js
```

### 验证结果
- `node -c backend/server.js backend/db.js backend/routes/orders.js backend/routes/pickups.js backend/routes/customers.js frontend/js/api.js frontend/js/i18n.js frontend/js/i18n/zh.js frontend/js/i18n/en.js scripts/browser-qa.js scripts/pickup-batch-browser-qa.js scripts/page-matrix-qa.js scripts/navigation-browser-qa.js scripts/motion-browser-qa.js scripts/customer-search-qa.js` ✅
- `bash scripts/build-i18n.sh` ✅
- `ENV_FILE=backend/.env ./scripts/restart.sh` ✅，服务恢复到 `http://localhost:8781`
- `bash scripts/status.sh` ✅，健康检查返回 `{"ok":true}`
- `./scripts/init-demo-env.sh` ✅，生成独立 profile `backend/.env.demo`
- `ENV_FILE=backend/.env.demo bash scripts/status.sh` ✅，独立 profile 指向 `8782` 且与默认环境分离
- `./scripts/backup-runtime.sh /tmp/glassorder-backup-check` ✅，导出当前 runtime 的 DB 与 uploads 备份
- `cd backend && npm run smoke` ✅
- `node scripts/security-regression.js` ✅
- `node scripts/browser-qa.js` ✅
- `node scripts/pickup-batch-browser-qa.js` ✅
- `node scripts/page-matrix-qa.js` ✅，`PAGE MATRIX QA PASS checks=30`
- `node scripts/navigation-browser-qa.js` ✅
- `node scripts/motion-browser-qa.js` ✅，`MOTION BROWSER QA PASS viewports=3 reduced-motion=1`
- `node scripts/customer-search-qa.js` ✅

### 完成结果
- 客户页搜索已增加 debounce，并把列表容器收敛到共享 panel/class，减少高频输入时的整页抖动。
- 汇总页和客户对账页继续接入共享 `renderStatCells` / `renderPanel` / 通用 row class，移动端可扫读性更稳定。
- 取货搜索页在切换客户和重新选片时会重置签名状态，并在签字区顶部持续显示当前已选片数，移动端流程更稳。
- 后端已支持 `UPLOADS_DIR`，上传、读取、发凭证都会跟随当前 profile 的上传目录。
- 项目脚本已支持 `ENV_FILE=<path>` 运行独立 profile；PID/日志文件也会按 profile 拆分。
- 新增 `scripts/init-demo-env.sh` 和 `scripts/backup-runtime.sh`，可以创建 demo 环境并备份当前 runtime 数据。
- 前端资源版本提升到 `20260521-runtime-isolation`，PWA 版本提升到 `v36-2026-05-21-runtime-isolation`。

## Phase 36：PWA 安装态专属 UI（2026-05-21）

### 问题
当前项目已经具备 PWA 基础能力（manifest / SW / standalone display），但仍缺少真正的“安装态”产品体验：
- 没有检测浏览器态、已安装态、iOS 主屏幕态。
- 没有安装引导，用户只能靠系统菜单自己发现“添加到主屏幕”。
- 没有安装后专属 UI，当前页面在已安装态和普通浏览器态完全一致。
- 没有版本更新提示和离线状态条，PWA 用户更像在用 App，但现在缺少 App 级运行反馈。

### 任务
- 在 `frontend/js/api.js` 增加 PWA runtime：检测 `display-mode: standalone`、`navigator.standalone`、`beforeinstallprompt`、`appinstalled`、`online/offline`。
- 新增统一 PWA 状态 UI：安装提示条、iOS 添加到主屏幕引导、离线状态条、发现新版本后的刷新提示。
- 在登录页和首页接入安装态专属 UI：
  - 浏览器态显示安装引导。
  - 已安装态隐藏安装提示并切换为更像 App launcher 的说明文案。
- 给 `body` 注入安装态 class/data 标记，便于样式层做 installed/browser 两套微差异。
- 补一条专项 QA 脚本，验证浏览器态和安装态下的关键 UI 分支、离线状态和更新提示容器。

### 验收标准
- 普通浏览器打开时，支持安装的环境能看到安装入口；iOS/Safari 至少能看到“添加到主屏幕”引导。
- `standalone` / `navigator.standalone` 环境下，页面会切换到安装态 class，且不再显示安装 CTA。
- 断网时能显示离线状态条，恢复网络后自动切回在线提示。
- 新 SW 安装完成且有现有 controller 时，页面能显示“发现新版本，立即刷新”提示。
- 现有业务流程不回归，主流程 QA 和页面矩阵 QA 继续通过。

### 验证命令
```bash
node -c frontend/js/api.js frontend/js/i18n/zh.js frontend/js/i18n/en.js scripts/browser-qa.js scripts/page-matrix-qa.js scripts/navigation-browser-qa.js scripts/motion-browser-qa.js scripts/pwa-install-qa.js
bash scripts/build-i18n.sh
node scripts/pwa-install-qa.js
node scripts/browser-qa.js
node scripts/page-matrix-qa.js
node scripts/navigation-browser-qa.js
node scripts/motion-browser-qa.js
bash scripts/status.sh
```

### 验证结果
- `node -c frontend/js/api.js frontend/js/i18n/zh.js frontend/js/i18n/en.js scripts/pwa-install-qa.js` ✅
- `bash scripts/build-i18n.sh` ✅
- `node scripts/pwa-install-qa.js` ✅，覆盖浏览器态 / standalone 安装态分支，以及离线状态条。
- `node scripts/browser-qa.js` ✅
- `node scripts/page-matrix-qa.js` ✅，`PAGE MATRIX QA PASS checks=30`
- `node scripts/navigation-browser-qa.js` ✅
- `node scripts/motion-browser-qa.js` ✅，`MOTION BROWSER QA PASS viewports=3 reduced-motion=1`
- `bash scripts/status.sh` ✅，服务运行在 `http://localhost:8781`，健康检查返回 `{"ok":true}`。

### 完成结果
- `frontend/js/api.js` 已新增 PWA runtime：检测安装态、监听 `beforeinstallprompt` / `appinstalled`、处理在线/离线状态、显示新版本刷新提示。
- 登录页和首页已接入安装态专属 UI：浏览器态显示安装入口，安装态自动隐藏安装 CTA，并切换说明文案。
- 新增统一 PWA banner 组件，用于安装提示、iOS 主屏幕引导、离线提示、更新提示。
- `body` 会注入 `pwa-installed` / `pwa-browser` class 与 `data-app-mode`，便于继续做安装态视觉微调。
- i18n 已补充中英文安装/离线/更新相关文案。
- 新增 `scripts/pwa-install-qa.js` 专项验证脚本。

## Phase 37：取货签字改为可选（2026-05-22）

### 需求
老板办理客户取货时，过去必须让客户手写签名才能完成取货。现在业务要求改为：
- 可以签字，也可以不签字。
- 不签字也能完成按片取货流程，并生成提货批次和 PDF。
- 如果前端或接口传了签名数据，仍必须是有效 PNG，不能放松坏签名输入校验。

### 任务
- 后端 `POST /api/pickups/batches` 支持空 `signature_base64`，仅在传入签名时校验并保存签名图片。
- 旧兼容接口 `POST /api/orders/:id/pickup` 同步支持空签名，避免遗留入口行为不一致。
- PDF 生成逻辑在无签名时显示“未提供签名/No signature provided”，不再尝试嵌图。
- 前端 `pickup-search.html` 不再拦截未签字提交，stepper 和提示文案改为“签字可选”。
- QA 增加无签名批量取货覆盖，并保留坏签名返回 400 的安全回归。

### 验收标准
- 老板选择片子、填写取货人姓名、不签名，也能完成取货并进入提货批次详情。
- 提货批次仍有 slip PDF；`signature_path` 为空时前端和后端不报错。
- 如果传 `signature_base64: "abc"`，后端仍返回 400。
- 现有签名取货流程继续可用。

### 验证命令
```bash
node -c backend/routes/pickups.js backend/routes/orders.js backend/services/signature.js backend/services/pickupSlip.js backend/services/slipPdf.js frontend/js/api.js frontend/js/i18n.js frontend/js/i18n/zh.js frontend/js/i18n/en.js scripts/security-regression.js scripts/browser-qa.js scripts/pickup-batch-browser-qa.js scripts/pickup-batch-smoke.js
bash scripts/build-i18n.sh
cd backend && npm run smoke
node scripts/security-regression.js
node scripts/pickup-batch-smoke.js
node scripts/browser-qa.js
node scripts/pickup-batch-browser-qa.js
node scripts/page-matrix-qa.js
bash scripts/status.sh
```

### 验证结果
- `bash scripts/build-i18n.sh` ✅
- `node -c backend/routes/pickups.js backend/routes/orders.js backend/db.js backend/services/signature.js backend/services/pickupSlip.js backend/services/slipPdf.js frontend/js/api.js frontend/js/i18n.js frontend/js/i18n/zh.js frontend/js/i18n/en.js frontend/sw.js scripts/security-regression.js scripts/browser-qa.js scripts/pickup-batch-browser-qa.js scripts/pickup-batch-smoke.js` ✅
- `ENV_FILE=backend/.env ./scripts/restart.sh` ✅，服务运行在 `http://localhost:8781`
- `cd backend && npm run smoke` ✅
- `node scripts/security-regression.js` ✅，坏签名仍返回 400；无签名批次可生成 slip 且 `signature_path` 为空。
- `node scripts/pickup-batch-smoke.js` ✅，覆盖无签名批量取货成功。
- `node scripts/browser-qa.js` ✅，浏览器取货流程不画签名也能完成。
- `node scripts/pickup-batch-browser-qa.js` ✅，取货专项验证无签名批次不保存 `signature_path`。
- `node scripts/page-matrix-qa.js` ✅，`PAGE MATRIX QA PASS checks=30`
- `node scripts/navigation-browser-qa.js` ✅
- `node scripts/motion-browser-qa.js` ✅，`MOTION BROWSER QA PASS viewports=3 reduced-motion=1`
- `node scripts/customer-search-qa.js` ✅
- `bash scripts/status.sh` ✅，健康检查返回 `{"ok":true}`。

### 完成结果
- `POST /api/pickups/batches` 已支持无 `signature_base64` 完成取货；传坏签名仍返回 400。
- 旧兼容 `POST /api/orders/:id/pickup` 已同步支持无签名。
- `signature_path` 新建表默认允许空字符串；无签名批次不会生成签名图片路径。
- 取货 PDF 无签名时显示 `No signature provided.`。
- `pickup-search.html` 不再强制签名，签名区文案改为可选，确认按钮只要求取货人姓名。
- QA 脚本改为默认账号优先，避免没有 demo 账号时误触发登录限流。
- 前端资源版本提升到 `20260522-optional-signature`，PWA 版本提升到 `v44-2026-05-22-optional-signature`。

## Phase 38：测试数据清理策略加固（2026-05-23）

### 问题
手工清空测试数据可以临时解决问题，但不能说 100% 有把握。审查后发现这些漏洞：
- 备份脚本只复制主 DB 文件，WAL 模式下可能漏掉 `-wal` / `-shm` 中尚未 checkpoint 的数据。
- 清理靠手工 Node 片段，容易漏掉后续新增业务表。
- 清理时服务仍可能运行，存在并发写入或清理后马上被 QA 写入的风险。
- profile 隔离不可靠：`ENV_FILE=...` 启动时后端仍读默认 `.env`，启动脚本还会误杀同项目其他 profile。
- uploads 路径缺少保护，误配置时有误删非上传目录的风险。

### 修复
- 新增 `scripts/clear-test-data.sh`：
  - 默认 dry-run，真正执行必须 `--apply`。
  - 执行时先停当前 profile、备份、清业务表、清 uploads、重建上传子目录、验证结果、再重启。
  - 保留 `users` 和 `schema_migrations`。
  - 清空 `customers/orders/pieces/events/pickups/pickup_batches/pickup_items/pickup_batch_counters`，并重置业务自增序列。
  - 遇到未知表直接拒绝执行，要求先审查清理范围。
  - uploads basename 必须是 `uploads` 或 `uploads-*`，并拒绝根目录/home/项目根/backend 目录。
- `scripts/backup-runtime.sh` 在有 `sqlite3` 时使用 `.backup`；否则复制 DB 主文件和 `-wal/-shm`。
- `backend/server.js` 按 `ENV_FILE` 指定路径加载 env。
- `scripts/_common.sh` 将相对 `ENV_FILE` 规范化为绝对路径。
- `scripts/start.sh` / `scripts/stop.sh` 按当前 profile 管理进程，不再误杀同项目其他 profile。
- README 增加清理脚本和 profile 清理说明。

### 验收标准
- 默认运行 `./scripts/clear-test-data.sh` 只输出清理范围，不停服务、不改数据。
- `ENV_FILE=backend/.env.clear-qa ./scripts/clear-test-data.sh --apply` 能在独立 profile 上备份并清空业务数据。
- 清理后客户、订单、片、事件、取货、取货批次、取货明细和批次计数均为 0；账号和迁移记录仍保留。
- 清理后 uploads 文件数为 0，目录结构仍有 `orders/pdfs/signatures/slips`。
- 清理前备份包含 DB、WAL/SHM 和 uploads，且备份库能读到清理前业务数据。
- 异常 uploads 路径会拒绝执行。
- 默认 profile 和独立 profile 可同时运行，互不误杀。

### 验证命令
```bash
bash -n scripts/_common.sh scripts/start.sh scripts/stop.sh scripts/status.sh scripts/backup-runtime.sh scripts/clear-test-data.sh
./scripts/clear-test-data.sh
ENV_FILE=backend/.env.clear-qa ./scripts/start.sh
BASE=http://localhost:8783 node <seed-clear-qa>
ENV_FILE=backend/.env.clear-qa ./scripts/clear-test-data.sh --apply
bash scripts/status.sh
ENV_FILE=backend/.env.clear-qa bash scripts/status.sh
BASE=http://localhost:8783 node <verify-empty-api>
BASE=http://localhost:8781 node <verify-default-profile>
```

### 验证结果
- shell 语法检查通过：`bash -n scripts/_common.sh scripts/start.sh scripts/stop.sh scripts/status.sh scripts/clear-test-data.sh scripts/backup-runtime.sh` ✅
- 默认 profile dry-run 成功：列出清理范围和计数，不清数据、不停服务 ✅
- 独立 profile `backend/.env.clear-qa` 与默认 profile 同时运行：8781 / 8783 健康检查均通过 ✅
- 独立 profile 造数成功：清理前 `customers=1, orders=1, pieces=8, events=28, pickup_batches=1, pickup_items=2, upload files=19` ✅
- `ENV_FILE=backend/.env.clear-qa ./scripts/clear-test-data.sh --apply` 成功：备份、停服务、清理、重启均完成 ✅
- 清理后独立 profile：业务表全 0，`users=2`，`schema_migrations=6`，uploads 文件数 0 ✅
- 默认 profile 清理前后保持空库且服务健康，没有被独立 profile 清理影响 ✅
- 备份 `backups/20260523-145028` 包含 DB/WAL/SHM 和上传 PDF；备份库可读到清理前业务数据 ✅
- 异常 `UPLOADS_DIR=./not-uploads-target` 被拒绝，退出码非 0 ✅

### 第二轮漏洞复审与修复
再次按“还能怎么失败”复查后，又发现并修复以下边界问题：
- PID 文件可能指向已经复用的进程：`running_pid` 现在必须校验 cwd 和 `ENV_FILE` 都匹配当前 profile。
- 端口被其他 profile 占用时，`start.sh` 可能把别人的健康检查当成自己启动成功：现在启动前检查端口占用，健康通过后也校验 listener 属于当前 profile。
- 清理脚本只保护 uploads 路径，未保护 DB 路径：现在 DB basename 必须匹配 `glass*.db`，避免误清任意 sqlite 文件。
- 指定非空备份目录会在停服务后失败，导致服务留在停止状态：现在清理失败且原服务原本运行时，会自动尝试恢复启动。
- 备份目录混入旧文件会造成恢复判断混乱：现在备份目录必须不存在或为空。
- 备份后没有立即验证可读性：清理脚本现在会打开备份 DB 并读取关键表，确认备份可用后才继续清理。

第二轮验证：
- `bash -n scripts/_common.sh scripts/start.sh scripts/stop.sh scripts/status.sh scripts/backup-runtime.sh scripts/clear-test-data.sh` ✅
- 默认 profile dry-run 仍不改数据、不停服务 ✅
- `backend/.env.clear-qa2` 独立 profile 造数后清理成功：清理前 `customers=1, orders=1, pieces=8, pickup_batches=1, upload files=19`；清理后业务表全 0、uploads 文件数 0、账号保留 ✅
- 备份 `backups/20260523-151434-clear/glass-clear-qa2.db` 可读，且仍包含清理前 `customers=1, orders=1, pieces=8, pickup_batches=1` ✅
- 坏 DB 名 `business.sqlite` 被拒绝 ✅
- 非空备份目录被拒绝，且失败后自动恢复原本运行的 clear-qa2 profile ✅
- 端口冲突 profile 被拒绝启动，不会误判 8781 默认服务为新 profile ✅
- 默认 8781 服务保持健康，默认库仍为空且 `users=2` ✅

### 第三轮漏洞复审与修复
继续复查“默认正式库误清”和“停服务是否真的停干净”两个风险后，新增以下保护：
- `stop.sh` 在杀掉 pidfile 指向进程后，会继续清理同 cwd + 同 `ENV_FILE` 的额外当前 profile 进程，避免父/残留进程继续存在。
- `--no-backup` 不再只是一个命令行参数，必须额外设置 `ALLOW_CLEAR_WITHOUT_BACKUP=1`，否则拒绝执行。
- `--apply` 也必须额外设置 `CONFIRM_CLEAR_TEST_DATA=1`，避免误手执行 `./scripts/clear-test-data.sh --apply` 清空默认库。

第三轮验证：
- `bash -n scripts/stop.sh scripts/clear-test-data.sh scripts/_common.sh scripts/start.sh scripts/backup-runtime.sh` ✅
- `./scripts/clear-test-data.sh --apply --no-backup --no-restart` 在未设置 `ALLOW_CLEAR_WITHOUT_BACKUP=1` 时拒绝执行，并自动恢复原本运行的默认 profile ✅
- 默认 profile 服务恢复后健康检查正常，默认业务表仍全 0、`users=2`、`schema_migrations=6` ✅

## Phase 39：订单 PO 唯一识别码改造计划

### 需求
上传 PDF 订单时，从 PDF 文件名自动识别 PO 码，并把 PO 作为订单的唯一业务编码。数据库中如果已经存在相同 PO，上传必须失败并提示上传者修改 PDF 文件名，不能自动生成重复或带后缀的新订单号。员工查询订单、老板查找订单、客户签字/取货查询、后期统计都要以 PO 为识别码。

### 文件名规律
样例规律为：`Glass Order - <YYMMDD> <订单描述>.pdf`，PO 来自日期后面的订单描述。

- `Glass Order - 260514 Glass Built- PO 546.pdf` -> `PO 546`
- `Glass Order - 260513 You -Canmore (1).pdf` -> `Canmore (1)`
- `Glass Order - 260515 Kinspace 10698.pdf` -> `10698`
- `Glass Order - 260515 Kinspace 10695.pdf` -> `10695`
- `Glass Order - 260515 Acme- 328.pdf` -> `328`
- `Glass Order - 260512 Sohal Glass Jackso.pdf` -> `Jackso`

解析规则按优先级执行：

1. 去掉 `.pdf` 扩展名。
2. 容忍大小写、空格和不同横线，去掉开头 `Glass Order -`。
3. 去掉后面的 6 位日期 token，例如 `260514`。
4. 如果剩余内容里有显式 `PO xxx`，优先取 `PO xxx`，统一规范为大写 `PO` 加单空格。
5. 否则如果末尾是数字 token，取末尾数字，例如 `10698`、`328`。
6. 否则如果存在横线分段，取最后一个有效分段，例如 `You -Canmore (1)` 取 `Canmore (1)`。
7. 否则取最后一个有效词，例如 `Sohal Glass Jackso` 取 `Jackso`。

无法按以上规则得到 PO 时，上传接口返回 400，并提示按命名规则修改 PDF 文件名。

### 数据模型策略
客户已确认当前业务数据不多，可以在代码验证通过后清空业务数据并重新上传 PDF。因此本阶段采用直接方案：`orders.order_number` 就是 PO，不再保留一套客户看不懂的内部订单号。

- 新上传订单的 `order_number` 直接写入识别出的 PO，例如 `PO 546`、`Canmore (1)`、`10698`。
- 新增 `orders.order_number_key` 作为唯一判断辅助字段，统一大小写、去掉空白/标点，避免 `Canmore (1)` 和 `canmore(1)` 被当成两个订单。
- 保留现有 `orders.order_number UNIQUE`，并额外建立 `order_number_key` 唯一索引。
- 正式库上线前先备份，然后清空业务表和 uploads，再重新上传 PDF。
- 保留现有 `source_file_hash` 重复 PDF 检查；新需求额外增加“不同 PDF 但同 PO”的重复检查。

### 后端任务
- 新增 `backend/services/poCode.js`：
  - `extractPoCodeFromFilename(originalName)`
  - `normalizePoCode(value)`
  - `poCodeKey(value)`
- 在 `backend/db.js` 增加 migration：
  - `orders.order_number_key TEXT`
  - 唯一索引 `idx_orders_order_number_key_unique`，仅对非空值生效。
- 修改 `POST /api/orders`：
  - 上传后先从 `req.file.originalname` 识别 PO。
  - 先查 `order_number_key` 是否已存在；存在则删除临时上传文件并返回 409。
  - 返回错误建议：`PO 10698 already exists. Please rename the PDF and upload again.`
  - 停用当前 `uniqueOrderNumber()` 自动加 `-2` 的行为。
  - 插入订单时写入 `order_number = PO` 和 `order_number_key`。
- 修改订单查询接口：
  - `GET /api/orders?po=...` 支持精确查询。
  - 现有 `order_number` 参数保留兼容。
  - 模糊搜索继续匹配 `order_number`，也支持去空格、括号和横线后的 PO 搜索。
- 修改取货相关接口：
  - 按订单查询/客户签字流程支持 PO 精确查找。

### 前端任务
- 新建订单页面：
  - 用户选择 PDF 后立即显示“识别到的 PO：xxx”。
  - 无法识别时显示文件名规则提示，并阻止提交。
  - 后端返回重复 PO 409 时，明确提示“PO xxx 已存在，请修改 PDF 文件名后重新上传”。
- 老板仪表盘、订单详情、客户汇总、取货页面、取货批次、工人队列、工人片子页面：
  - 显示文案从“订单号/#order_number”调整为“PO xxx”。
  - 搜索框 placeholder 改为“搜索 PO / 公司名 / 项目”。
  - 展示字段使用 `order_number`，但渲染为客户能看懂的 PO 标签。
- 取货签字/客户查询：
  - 支持输入 PO 查订单或限定客户下的订单。
  - 避免只靠内部自增 `order_id` 暴露给客户操作。

### 测试与验证
- 解析单元脚本：`scripts/po-code-parse-qa.js`
  - 覆盖 6 个样例，结果必须完全匹配。
  - 覆盖大小写、额外空格、不同横线、无法识别、重复空白规范化。
- 上传接口脚本：`scripts/po-code-upload-qa.js`
  - 上传样例 PDF，确认订单 `order_number` 为识别值。
  - 上传不同内容但相同 PO 的 PDF，必须 409，DB 不新增订单，uploads 不残留孤儿文件。
  - 上传同内容 PDF，仍由 `source_file_hash` 返回 409。
  - 上传无法识别 PO 的文件名，必须 400。
- 搜索/页面验证：
  - 老板页面按 PO 搜索能找到订单。
  - 工人页面显示 PO。
  - 取货选择和批次详情显示 PO。
  - 客户汇总/签字查询可按 PO 定位。
- 清库重传验证：
  - 上线前运行正式库备份。
  - 确认代码验证通过后，使用受保护的清理脚本清空业务表和 uploads。
  - 重新上传 PDF 后，订单列表、工人页面、取货页面都只显示 PO。

### 验收标准
- 6 个样例文件名全部识别为指定 PO。
- 新上传订单的唯一业务编码为 PO，不再自动追加 `-2`、`-3`。
- 同 PO 重复上传一定返回 409，并给出修改 PDF 文件名的清晰提示。
- 老板、员工、取货、客户汇总页面都能看到并搜索 PO。
- 正式清库前必须完成备份；清库后重新上传的订单均以 PO 作为 `order_number`。
- 全部测试只使用 `ENV_FILE=backend/.env.codex-qa`，不污染正式数据。

### 验证命令
```bash
ENV_FILE=backend/.env.codex-qa node scripts/po-code-parse-qa.js
ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/po-code-upload-qa.js
ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/customer-search-qa.js
ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pickup-batch-smoke.js
ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pickup-batch-browser-qa.js
ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/browser-qa.js
ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/page-matrix-qa.js
ENV_FILE=backend/.env.codex-qa ./scripts/smoke.sh
git diff --check -- glassorder
```

### 实施结果
- 已新增 `backend/services/poCode.js`，上传 PDF 时从文件名识别 PO，并把 `orders.order_number` 直接写为 PO。
- 已新增 `orders.order_number_key` migration 和唯一索引，用规范化 key 拦截大小写、空格、括号、横线差异造成的重复 PO。
- 已停用自动追加 `-2`、`-3` 的订单号逻辑；同 PO 上传返回 409 `DUPLICATE_PO`，无法识别 PO 返回 400 `PO_FILENAME_INVALID`。
- 已新增 `GET /api/orders?po=...`，并在查询层兼容 `PO 546` / `546` 这类取货员常见输入。
- 已在取货 API 增加 `po` 过滤；取货页面顶部新增 PO 搜索框，取货员只知道 PO 时可自动定位客户并只显示该 PO 的可取玻璃片。
- 老板、工人、取货批次、客户汇总、交割单、邮件主题/附件等显示已统一改为 PO 文案。
- 新订单页面选择 PDF 后会显示识别到的 PO；重复 PO 和无效文件名都有明确提示。
- QA 脚本已改为使用符合 PO 规则的 PDF 文件名，避免测试污染正式命名规则。

### 验证结果（codex QA 隔离环境）
- `ENV_FILE=backend/.env.codex-qa node scripts/po-code-parse-qa.js` ✅，覆盖客户给出的 6 个样例、大小写/空格/Unicode 横线、描述里重复出现 PO、`PO 546`/`546` 查询兼容。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/po-code-upload-qa.js` ✅，验证新订单 `order_number=PO`、重复 PO 409、重复 PDF hash 409、无效文件名 400。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 ./scripts/smoke.sh` ✅，验证订单创建、PO 查询、重复上传清理、工序、取货、邮件跳过、回退、归档。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pickup-batch-browser-qa.js` ✅，包含“只输入 PO 查找取货片”的浏览器验证。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pickup-batch-smoke.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/browser-qa.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/page-matrix-qa.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/select-all-qa.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/customer-search-qa.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/ui-regression-qa.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/security-regression.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pwa-install-qa.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/customer-cc-qa.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/piece-workflow-qa.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/worker-drawing-qa.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/summary-smoke.js` ✅。
- 静态检查通过：`node --check`、`bash -n`、`git diff --check -- PLAN.md backend frontend scripts` ✅。
- 默认正式库 dry-run 已执行，没有清数据：清理前 `customers=10, orders=32, pieces=322, events=727, pickup_batches=9, pickup_items=214, uploads=563`；`users=2` 和 `schema_migrations=8` 会保留。
- 正式库已按客户确认执行备份后清空：备份目录 `backups/20260607-200417-clear`；清理后业务表全 0、uploads 文件数 0，`users=2` 保留，服务 `http://localhost:8781/api/health` 正常。

### 风险与结论
这是可改的。由于客户已确认可以清空业务数据并重新上传，风险比历史迁移方案低：不需要把旧 `number_order` 映射成 PO，也不需要保留两套编号。主要风险集中在文件名识别和重复 PO 拦截，必须通过样例解析、上传重复、老板搜索、工人显示和取货显示这些 QA 后再清正式库。

## Phase 40：车间流程修正、完成片返工与取片 HOLD

### 需求澄清
- 默认玻璃流程应为 `切玻璃 -> 开切口 -> 钢化 -> 完成`。
- `打磨` 不是默认必经工序；钢化完成后检查发现有问题或需要额外处理时，手动把该片转到 `打磨`。
- 车间页“全选 + 批量完成”应只完成当前工位的一步，切玻璃后进入开切口，不能直接跳到完成。
- 已完成的片需要可纠正：送去打磨、退回上一级、或重做回切玻璃。
- 取片页需要能把整单 on hold，或把某个客户当前所有可取片 on hold；同时必须能解除 hold。

### 后端任务
- 修改 `backend/services/pieceWorkflow.js`：
  - 新订单默认 `required_steps` 改为 `cut/edge/tempered`。
  - 保留 `polish` 为合法可选工序。
  - 新增状态辅助：送打磨、退回上一级、重做。
- 修改 `backend/routes/pieces.js`：
  - 新增完成片操作接口：`send-polish`、`return-previous`、`redo`。
  - 操作后写入事件，并在必要时同步订单状态，避免 ready 订单被返工后仍显示可取货。
- 修改 `backend/routes/pickups.js`：
  - `available` 支持 `include_hold=1`，取片页能看到被 hold 的可取片以便解除。
  - 新增整单 hold/unhold 和客户 hold/unhold，只作用于 `stage='finished'` 且未取走的片，避免锁住生产中的玻璃。
  - 保持取货提交接口拒绝 hold 片。

### 前端任务
- 修改 `frontend/worker-pieces.html`：
  - 批量主按钮从一次性 `complete` 改为一步 `advance`。
  - 完成片弹窗增加“送去打磨”“退回上一级”“重做”。
  - 高级工序配置默认恢复为 `cut/edge/tempered`，跳过钢化/开口不再自动包含打磨。
- 修改老板订单编辑相关页面：
  - 默认工序显示与新默认流程一致，打磨只在勾选时进入流程。
- 修改 `frontend/pickup-search.html`：
  - 显示 hold 片但禁用选择。
  - 增加整单 hold/unhold、客户可取片 hold/unhold。
  - 全选、按单全选、确认取货都忽略 hold 片。
- 修改 `frontend/js/i18n.js`：
  - 增加返工、送打磨、取片 hold 文案。

### 测试任务
- 更新 `scripts/piece-workflow-qa.js`：
  - 验证默认流程不包含打磨。
  - 验证钢化后完成，再手动送打磨，打磨后完成。
  - 验证完成片退回上一级、重做回切玻璃。
- 更新 `scripts/select-all-qa.js`：
  - 浏览器验证切玻璃页全选后批量完成只进入开切口。
  - 继续验证取片全选和按单全选。
- 新增 `scripts/pickup-hold-qa.js`：
  - 验证整单 hold 后默认取片列表隐藏，`include_hold=1` 可见且不可取。
  - 验证整单 unhold 恢复可取。
  - 验证客户 hold/unhold 作用于该客户所有已完成未取片。
- 更新 `backend/scripts/smoke.sh`：
  - 默认流程期望改为第三次推进即完成。
  - 增加可选打磨路径的 smoke。

### 验收标准
- 新上传订单的普通玻璃默认只需切、开口、钢化，完成后不会自动进入打磨队列。
- 从完成片手动送打磨后，该片出现在打磨队列；打磨完成后回到完成。
- 工人切玻璃页全选后点击批量完成，片子进入开切口，不会直接完成。
- 完成片可退回上一级；完成片可重做并回到切玻璃，订单状态不再误保持可取。
- 取片页整单 on hold 后该订单片不可被选中取货；解除后恢复。
- 取片页客户 on hold 后该客户所有已完成未取片不可被选中取货；解除后恢复。
- 所有验证只跑 `ENV_FILE=backend/.env.codex-qa` / `BASE=http://localhost:8783`，默认正式库不被写入测试数据。

### 验证命令
```bash
bash -n scripts/_common.sh scripts/start.sh scripts/stop.sh scripts/status.sh scripts/clear-test-data.sh backend/scripts/smoke.sh
node --check backend/services/pieceWorkflow.js backend/routes/pieces.js backend/routes/pickups.js
node --check scripts/piece-workflow-qa.js scripts/select-all-qa.js scripts/pickup-hold-qa.js
ENV_FILE=backend/.env.codex-qa ./scripts/status.sh
ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/piece-workflow-qa.js
ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pickup-hold-qa.js
ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/select-all-qa.js
ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 ./scripts/smoke.sh
ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pickup-batch-browser-qa.js
ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/page-matrix-qa.js
git diff --check -- PLAN.md backend frontend scripts
```

### 执行状态
- [x] 后端工序默认值与完成片返工接口
- [x] 取片 hold/unhold 后端接口
- [x] 工人页、老板页、取片页 UI
- [x] QA 脚本与 smoke 更新
- [x] codex QA 环境完整验证

### 实施结果
- `pieceWorkflow` 默认工序已改为 `cut -> edge -> tempered -> finished`；`polish` 仍是合法可选工序，但不会默认进入新订单流程。
- `POST /api/pieces/:id/send-polish` 可把已完成钢化的片送入打磨；打磨完成后回到 finished。
- `POST /api/pieces/:id/return-previous` 可把完成片退回上一级；`POST /api/pieces/:id/redo` 可回到切玻璃并标记 rework。
- 返工、重做、老板修改工序后会同步订单状态，避免订单仍误显示为可取。
- 车间页批量主按钮已从后端 `complete` 改为 `advance`，全选切玻璃后只推进到开切口。
- 后端批量 `advance/complete` 均会跳过 HOLD 片，避免绕过 HOLD。
- 取片页新增整单 HOLD/解除、客户全部 HOLD/解除；HOLD 只作用于已完成且未取走的片。
- 取片页通过 `include_hold=1` 显示 HOLD 片，但禁用选择；全选、按单全选和确认取货均忽略 HOLD 片。
- 工人页、老板订单详情、老板 dashboard 的默认工序显示已统一为切/开口/钢化，打磨只在勾选或送打磨后出现。
- 空工序网格会清理旧 DOM，避免隐藏的旧片子影响浏览器测试和辅助状态。

### 验证结果（codex QA 隔离环境）
- `node --check backend/services/pieceWorkflow.js backend/routes/pieces.js backend/routes/pickups.js backend/routes/orders.js scripts/browser-qa.js scripts/select-all-qa.js scripts/piece-workflow-qa.js scripts/pickup-hold-qa.js scripts/perf-check-worker.js frontend/js/i18n.js frontend/js/i18n/zh.js frontend/js/i18n/en.js` ✅
- `bash -n backend/scripts/smoke.sh backend/scripts/zip-upload-smoke.sh scripts/_common.sh scripts/start.sh scripts/stop.sh scripts/status.sh scripts/clear-test-data.sh` ✅
- `git diff --check -- PLAN.md backend frontend scripts` ✅
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/piece-workflow-qa.js` ✅，验证默认不含打磨、手动送打磨、退回上一级、重做和订单状态同步。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pickup-hold-qa.js` ✅，验证整单/客户 HOLD、`include_hold=1` 可见、HOLD 片不可取。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/select-all-qa.js` ✅，验证车间全选批量推进只到下一步，并验证取片 HOLD UI 禁选/解除。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 ./scripts/smoke.sh` ✅，验证默认三步完成、可选打磨、PO、取货、回退、归档主链路。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/browser-qa.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/page-matrix-qa.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pickup-batch-browser-qa.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pickup-batch-smoke.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/ui-regression-qa.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/security-regression.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/perf-check-worker.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pwa-install-qa.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/navigation-browser-qa.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/customer-search-qa.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/customer-cc-qa.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/worker-drawing-qa.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/summary-smoke.js` ✅。
- `ENV_FILE=backend/.env.codex-qa node scripts/po-code-parse-qa.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/po-code-upload-qa.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/motion-browser-qa.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 bash backend/scripts/zip-upload-smoke.sh` ✅。
- 服务状态：QA `http://localhost:8783/api/health` 正常；默认 `http://localhost:8781/api/health` 正常。
- 数据隔离：本轮测试命令全部使用 `ENV_FILE=backend/.env.codex-qa` / `BASE=http://localhost:8783`。最终计数显示 QA 库有测试数据；默认库也有业务数据但本轮没有向默认端口执行写入型测试命令。

## Phase 41：全面 QA、前端体验打磨与 BUG 修复

### 目标
- 在 Phase 40 的基础上再做一轮全面 QA，覆盖上传、PO、车间工序、图纸、取片、HOLD、客户、汇总、PWA、安全和页面矩阵。
- 重点检查最近改动的前端：车间完成片弹窗、批量选择栏、取片页整单/客户 HOLD 控制、移动端按钮布局、空状态和文案。
- 发现 BUG 必须修复并重跑相关最小验证；不能只记录不处理。
- 所有测试继续只使用 `ENV_FILE=backend/.env.codex-qa` / `BASE=http://localhost:8783`。

### QA 任务
- 静态检查：
  - `node --check` 覆盖后端路由、workflow helper、QA 脚本、i18n。
  - `bash -n` 覆盖 shell 脚本。
  - `git diff --check -- PLAN.md backend frontend scripts`。
- API/业务验证：
  - `smoke`
  - `piece-workflow-qa`
  - `pickup-hold-qa`
  - `pickup-batch-smoke`
  - `po-code-parse-qa`
  - `po-code-upload-qa`
  - `customer-cc-qa`
  - `summary-smoke`
  - `security-regression`
- 浏览器验证：
  - `select-all-qa`
  - `browser-qa`
  - `page-matrix-qa`
  - `pickup-batch-browser-qa`
  - `worker-drawing-qa`
  - `ui-regression-qa`
  - `navigation-browser-qa`
  - `motion-browser-qa`
  - `perf-check-worker`
  - `pwa-install-qa`
- 手动视觉检查：
  - 使用 Playwright 在移动端/桌面查看 `worker-pieces.html` 和 `pickup-search.html`。
  - 检查按钮是否拥挤、文本是否溢出、HOLD 状态是否清晰、完成片操作是否容易误触。

### UI 打磨候选
- 车间完成片弹窗：把“送打磨 / 退回上一级 / 重做”改成更清晰的分组和危险操作提示，降低误触风险。
- 取片页 HOLD 控制：减少顶部按钮拥挤，改为更易扫读的客户级控制区；订单级 HOLD 按钮保持紧凑但不挤压 PO 信息。
- HOLD 片展示：增加视觉标记，让取片员能立即看出“这片不能选是因为 HOLD”。
- 空状态/提示：避免用户在筛选后看不到片子时误以为系统出错。

### 验收标准
- 关键页面无 console error、无明显横向溢出、移动端按钮不重叠。
- 车间完成片操作易辨识，危险动作有确认。
- 取片页客户级和订单级 HOLD / 解除清晰可用，HOLD 片不能被选中。
- 全量 QA 命令通过；如有失败，已修复并重跑相关测试。
- QA 只污染 codex QA 数据库，不对默认库执行写入型测试。

### 执行状态
- [x] 第一轮全面 QA
- [x] Playwright 视觉检查
- [x] UI/BUG 修复
- [x] 针对性验证
- [x] 全量回归与结果记录

### 实施结果
- 修复取片页客户切换时的陈旧列表问题：`loadAvailable()` 现在会先清空旧 `grouped`、显示 loading，并用请求序号和当前客户 ID 防止旧响应覆盖新客户页面。
- 取片页客户级 HOLD 控制从普通批量按钮区移到独立的 `客户取片 HOLD` 控制条，增加可取/HOLD 数量摘要；HOLD 片增加醒目的 `取片 HOLD` badge，仍保持禁选。
- 取片页全选 QA 改为等待本轮目标 piece id 全部出现，避免旧客户 DOM 或异步加载造成误判。
- 车间完成片弹窗重新分组：完成状态、后续处理（送打磨/退回上一级）和返工操作（重做）分区展示；重做继续保留确认弹窗，降低误触。
- 新增 `.piece-action-*`、`.pickup-customer-hold-*` 等样式，移动端按钮支持换行和自适应宽度。
- 补充中英文 i18n 文案，并重新生成 `frontend/js/i18n.js`。

### 验证结果（codex QA 隔离环境）
- `node --check backend/services/pieceWorkflow.js backend/routes/pieces.js backend/routes/pickups.js backend/routes/orders.js scripts/browser-qa.js scripts/select-all-qa.js scripts/piece-workflow-qa.js scripts/pickup-hold-qa.js scripts/perf-check-worker.js frontend/js/i18n.js frontend/js/i18n/zh.js frontend/js/i18n/en.js` ✅
- `bash -n backend/scripts/smoke.sh backend/scripts/zip-upload-smoke.sh scripts/_common.sh scripts/start.sh scripts/stop.sh scripts/status.sh scripts/clear-test-data.sh scripts/backup-runtime.sh` ✅
- HTML inline script syntax check：`frontend/worker-pieces.html` 3 个 inline script、`frontend/pickup-search.html` 3 个 inline script 均通过 ✅
- `git diff --check -- PLAN.md backend frontend scripts` ✅
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/piece-workflow-qa.js` ✅，最新输出 `PIECE WORKFLOW QA PASS order=119 piece=902 polish_piece=903 redo_piece=904`
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pickup-hold-qa.js` ✅，最新输出 `PICKUP HOLD QA PASS customer=316 orders=120,121`
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/select-all-qa.js` ✅，最新输出 `SELECT ALL QA PASS worker_order=122 customer=317`
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/ui-regression-qa.js` ✅，最新输出 `UI REGRESSION QA PASS checks=18 customer=318 worker_order=123 pickup_order=124`
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/worker-drawing-qa.js` ✅，最新输出 `WORKER DRAWING QA PASS order=126 title=第 2 片 · 10mm Clear Tempered`
- 临时 Playwright 视觉 QA ✅：390px 移动端和 1280px 桌面端检查 `pickup-search.html` 与 `worker-pieces.html`，确认无横向溢出、按钮无裁切、HOLD badge/禁选状态清晰、完成片弹窗分区完整。截图：`/tmp/glassorder-phase41-pickup-mobile.png`、`/tmp/glassorder-phase41-worker-finished-mobile.png`、`/tmp/glassorder-phase41-pickup-desktop.png`、`/tmp/glassorder-phase41-worker-finished-desktop.png`。
- 移动端取片第二单视口复查 ✅：`/tmp/glassorder-phase41-pickup-second-order-mobile.png`，确认第二单片子真实视口正常显示；此前 full-page 长截图中的大块空白为固定底栏截图拼接伪影。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/browser-qa.js` ✅，最新输出覆盖登录、dashboard 搜索/菜单、ready 确认、工人网格、取片确认、时间线、partial pickup、归档菜单。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pickup-batch-smoke.js` ✅
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/security-regression.js` ✅
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/customer-cc-qa.js` ✅
- `ENV_FILE=backend/.env.codex-qa node scripts/po-code-parse-qa.js` ✅
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/po-code-upload-qa.js` ✅
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/summary-smoke.js` ✅
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/page-matrix-qa.js` ✅
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pickup-batch-browser-qa.js` ✅
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/navigation-browser-qa.js` ✅
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pwa-install-qa.js` ✅
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/motion-browser-qa.js` ✅
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/customer-search-qa.js` ✅
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/perf-check-worker.js` ✅，最新输出 `WORKER PERF PASS order=143 piece=1094 actionElapsed=1096.6ms apiCalls=POST /api/pieces/1094/advance`
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 ./scripts/smoke.sh` ✅，主链路 `SMOKE PASS`
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 bash backend/scripts/zip-upload-smoke.sh` ✅，`ZIP SMOKE PASS ok=0 duplicate_or_existing=11 total=11`
- 服务状态：QA `http://localhost:8783/api/health` 正常；默认 `http://localhost:8781/api/health` 正常。
- 数据隔离：本轮写入型验证全部使用 `ENV_FILE=backend/.env.codex-qa` / `BASE=http://localhost:8783`；默认服务只做健康检查，没有执行写入型测试。

## Phase 42：统一正式公司 logo

### 目标
- 使用客户提供的正式图片 `/home/nico/.openclaw/workspace-enya/wetempglass/img/logo.jpg` 作为应用统一图标。
- 替换 PWA manifest 图标、Apple touch icon、登录页和入口页的可见品牌 logo。
- 保留现有业务功能和导航结构，不做无关 UI 重构。

### 任务
- 将正式 `logo.jpg` 复制到 `frontend/icons/logo.jpg`。
- 修改 `scripts/generate-icons.js`，从 `frontend/icons/logo.jpg` 生成：
  - `frontend/icons/icon-192.png`
  - `frontend/icons/icon-512.png`
  - `frontend/icons/icon-maskable-512.png`
  - `frontend/icons/apple-touch-icon.png`
- 检查并更新 `frontend/manifest.json`、`frontend/sw.js` 预缓存，确保新 logo 和 PWA 图标会被缓存刷新。
- 将 `frontend/login.html` 和 `frontend/index.html` 顶部内联 SVG 标志替换为正式 logo 图片。

### 验收标准
- 项目内不再使用旧的内联“工厂/GO”logo 作为应用品牌图标。
- PWA icon、Apple touch icon、manifest 图标、登录页、入口页均来自同一正式 logo。
- 图片尺寸和格式正确：192/512/maskable/180 均可被浏览器加载。
- 无横向溢出、无 console error，PWA 安装验证通过。

### 验证命令
```bash
node --check scripts/generate-icons.js
node scripts/generate-icons.js
file frontend/icons/logo.jpg frontend/icons/icon-192.png frontend/icons/icon-512.png frontend/icons/icon-maskable-512.png frontend/icons/apple-touch-icon.png
node --check scripts/pwa-install-qa.js scripts/page-matrix-qa.js frontend/js/i18n.js
ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pwa-install-qa.js
ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/page-matrix-qa.js
git diff --check -- PLAN.md frontend scripts
```

### 执行状态
- [x] logo 源文件复制
- [x] 图标生成脚本更新并生成资产
- [x] 页面 logo 替换
- [x] PWA/页面验证

### 实施结果
- 已将正式 logo 复制到 `frontend/icons/logo.jpg`。
- `scripts/generate-icons.js` 已改为从正式 `logo.jpg` 生成全部应用图标；旧的内联 SVG / `GO` 生成逻辑已移除。
- 已生成并替换：
  - `frontend/icons/favicon-32.png`
  - `frontend/icons/apple-touch-icon.png`
  - `frontend/icons/icon-192.png`
  - `frontend/icons/icon-512.png`
  - `frontend/icons/icon-maskable-512.png`
- `frontend/js/api.js` 会自动注入 `/icons/favicon-32.png`，同时保留 manifest 和 Apple touch icon 注入。
- `frontend/sw.js` cache 版本更新为 `v47-2026-06-08-official-logo`，并预缓存 `logo.jpg` 与 `favicon-32.png`。
- `frontend/login.html` 和 `frontend/index.html` 顶部应用标志已从内联 SVG 改为正式 logo 图片。
- 页面可见 logo 放大到移动端可读尺寸，并通过截图确认无横向溢出。

### 验证结果
- `node --check scripts/generate-icons.js scripts/pwa-install-qa.js scripts/page-matrix-qa.js frontend/js/api.js frontend/js/i18n.js frontend/js/i18n/zh.js frontend/js/i18n/en.js` ✅
- `node scripts/generate-icons.js` ✅，成功写出 favicon、Apple touch icon、192/512/maskable 图标。
- HTML inline script syntax check：`frontend/login.html` 3 个 inline script、`frontend/index.html` 3 个 inline script 均通过 ✅
- `file frontend/icons/logo.jpg frontend/icons/favicon-32.png frontend/icons/apple-touch-icon.png frontend/icons/icon-192.png frontend/icons/icon-512.png frontend/icons/icon-maskable-512.png` ✅：
  - `logo.jpg` 为 617x565 JPEG
  - `favicon-32.png` 为 32x32 PNG
  - `apple-touch-icon.png` 为 180x180 PNG
  - `icon-192.png` 为 192x192 PNG
  - `icon-512.png` 为 512x512 PNG
  - `icon-maskable-512.png` 为 512x512 PNG
- `rg "logoSvg|>GO<|<svg width=\"26\"|<svg width=\"30\"" scripts/generate-icons.js frontend/login.html frontend/index.html frontend/icons -S` 无命中 ✅
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pwa-install-qa.js` ✅，验证页面 logo、favicon、Apple touch icon、manifest icons、SW cache version 和安装态/浏览器态。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/page-matrix-qa.js` ✅，`PAGE MATRIX QA PASS checks=30`。
- `BASE=http://localhost:8781 node scripts/pwa-install-qa.js` ✅，默认端口只读验证通过。
- 默认端口截图复查 ✅：`/tmp/glassorder-phase42-login-logo-final.png`、`/tmp/glassorder-phase42-index-logo-final.png`，登录页/入口页无横向溢出，正式 logo 显示清楚。
- `git diff --check -- PLAN.md frontend scripts` ✅。

## Phase 43：登录界面质感升级与全面 QA

### 目标
- 优化首次打开的登录页，让页面更正式、更有品牌感，减少“低配临时页面”的观感。
- 保留当前登录逻辑、PWA 安装提示、语言切换和表单字段，不新增无关功能。
- 登录页在移动端和桌面端都不能横向溢出，按钮/输入框不能重叠，正式 logo 必须清晰。

### 任务
- 重构 `frontend/login.html` 入口布局：
  - 桌面端采用品牌展示区 + 登录面板的专业工作台布局。
  - 移动端采用紧凑的品牌头部 + 登录表单布局。
  - 保留 `#form`、`#login`、`#password`、`#submitBtn`，保证现有 QA 和登录逻辑不破坏。
- 更新 `frontend/shared.css`：
  - 新增登录页专用 class，减少 inline style。
  - 控制 logo、标题、状态条、表单面板、安装/语言按钮的响应式尺寸。
- 更新 i18n：
  - 新增登录页品牌说明、工作流标签和安全提示文案。
- 验证：
  - 静态检查、HTML inline script 检查。
  - Playwright 截图检查 mobile/desktop 登录页。
  - 运行 `pwa-install-qa`、`page-matrix-qa`、`browser-qa`。

### 验收标准
- 登录页打开第一屏更有正式品牌感，logo 清晰，表单聚焦明确。
- 移动端 390px 和桌面 1280px 均无横向溢出、无 console error、无文本重叠。
- 登录表单 required、placeholder、错误提示和提交逻辑保持正常。
- PWA 安装/已安装状态仍能正确显示和隐藏。
- QA 只使用 codex QA 环境做写入型验证；默认端口最多做只读截图/PWA 检查。

### 验证命令
```bash
bash scripts/build-i18n.sh
node --check frontend/js/api.js frontend/js/i18n.js frontend/js/i18n/zh.js frontend/js/i18n/en.js scripts/browser-qa.js scripts/page-matrix-qa.js scripts/pwa-install-qa.js
node - <<'NODE'
const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync('frontend/login.html', 'utf8');
for (const [index, match] of [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].entries()) {
  new vm.Script(match[1], { filename: `frontend/login.html#script${index + 1}` });
}
console.log('login inline scripts ok');
NODE
ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pwa-install-qa.js
ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/page-matrix-qa.js
ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/browser-qa.js
git diff --check -- PLAN.md frontend scripts
```

### 执行状态
- [x] 登录页 UI 重构
- [x] i18n 与样式更新
- [x] Playwright 视觉检查
- [x] 回归 QA

### 实施结果
- `frontend/login.html` 已重构为桌面双区布局：左侧品牌展示区、右侧登录面板；移动端折叠为紧凑品牌头部 + 登录表单。
- 登录页使用正式公司 logo，增加 PO、车间、取片三组业务状态提示，首屏观感更接近正式业务系统。
- `frontend/shared.css` 新增登录页专用样式，控制背景、品牌区、表单卡片、语言/PWA 按钮、输入框和移动端断点；桌面和移动端均无横向溢出。
- `frontend/js/i18n/zh.js`、`frontend/js/i18n/en.js` 新增登录页文案，并已重新生成 `frontend/js/i18n.js`。
- `frontend/sw.js` cache 版本更新为 `v48-2026-06-08-login-ui`，确保登录页样式和新 logo 资源能刷新。
- `scripts/pwa-install-qa.js` 已兼容本轮 login UI cache 版本检查，并继续验证 favicon、Apple touch icon、manifest icons 和页面 logo。

### 验证结果（codex QA 隔离环境）
- `bash scripts/build-i18n.sh` ✅，重新生成 `frontend/js/i18n.js`。
- HTML inline script syntax check：`frontend/login.html` 3 个 inline script 均通过 ✅。
- `node --check frontend/js/api.js frontend/js/i18n.js frontend/js/i18n/zh.js frontend/js/i18n/en.js scripts/browser-qa.js scripts/page-matrix-qa.js scripts/pwa-install-qa.js scripts/ui-regression-qa.js` ✅。
- Playwright 视觉检查 ✅：
  - 桌面截图：`/tmp/glassorder-phase43-login-desktop-v3.png`
  - 移动端截图：`/tmp/glassorder-phase43-login-mobile-v2.png`
  - 1280px 桌面和 390px 移动端均确认无横向溢出、无按钮/文字重叠、logo 清晰。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pwa-install-qa.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/page-matrix-qa.js` ✅，`PAGE MATRIX QA PASS checks=30`。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/browser-qa.js` ✅，覆盖登录 required/placeholders、auth redirect、dashboard 搜索/菜单、ready 确认、工人网格、取片确认、时间线、partial pickup 和归档菜单。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/ui-regression-qa.js` ✅，`UI REGRESSION QA PASS checks=18`。
- 全面 QA 补充回归 ✅：
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/navigation-browser-qa.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/motion-browser-qa.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/piece-workflow-qa.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/select-all-qa.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 ./scripts/smoke.sh`
- `git diff --check -- PLAN.md frontend scripts` ✅。
- 服务状态：QA `http://localhost:8783/api/health` 正常；默认 `http://localhost:8781/api/health` 正常。
- 数据隔离：本轮写入型验证继续使用 codex QA 环境；默认端口只用于只读视觉/PWA/健康检查。

## Phase 44：取货二维码客户手机签字

### 目标
- 取货签字时不再把老板终端交给客户，避免客户通过返回、刷新或地址栏看到其他客户信息。
- 老板在取货页选择本次取货片后生成二维码；客户用自己的手机扫码进入公开签字页。
- 客户签字完成后，签名上传服务器并创建正式取货批次，老板端自动看到签字完成并跳转批次详情。
- 公开签字页只暴露本次签收所需的最小信息，不依赖老板登录态，不显示客户列表、电话、邮箱或其他客户订单。

### 任务
- 数据模型：
  - 新增 `pickup_sign_requests` 表，保存一次性签字请求、token hash、绑定客户、片 ID、过期时间、签字状态、签名文件、PDF、最终 `pickup_batch_id`。
  - token 使用高强度随机值，数据库只保存 SHA-256 hash；默认 15 分钟有效，签完即失效。
- 后端 API：
  - 老板接口 `POST /api/pickups/sign-requests`：根据选中的 finished/unpicked/unhold 片生成一次性签字请求和二维码 SVG。
  - 老板接口 `GET /api/pickups/sign-requests/:id`：轮询签字状态。
  - 老板接口 `POST /api/pickups/sign-requests/:id/cancel`：取消当前二维码。
  - 公开接口 `GET /api/pickups/sign/:token`：返回最小签收摘要。
  - 公开接口 `POST /api/pickups/sign/:token`：校验 token、签名 PNG 和片状态，创建 pickup batch、生成 PDF、写事件并使 token 失效。
- 前端：
  - `pickup-search.html` 主按钮改为生成签字二维码，展示二维码、链接、倒计时/状态，并轮询签字结果。
  - 新增 `customer-sign.html`，无老板导航/登录态，客户填写签收人姓名、可选电话、手写签名并提交。
  - 签字完成页只提示“签收完成，请交还工作人员/通知工作人员”，不展示后台入口。
- QA：
  - 新增 API 级二维码签字 QA，覆盖无 token 拒绝、生成请求、公开页最小信息、客户签名创建批次、token 一次性、过期/取消拒绝、老板轮询可见。
  - 新增/更新浏览器 QA，覆盖老板生成二维码、客户手机页签字、老板端自动跳转批次详情、客户页无敏感字段/无横向溢出。
  - 保留旧批次直接创建 API 的回归，确保既有批次详情、回退、PDF 下载不破坏。

### 验收标准
- 客户不接触老板终端即可完成签收；老板页显示二维码并能自动感知签字完成。
- 客户扫码页不需要登录，不读取/使用老板 token；页面只显示本次签收摘要和签名表单。
- token 高强度随机、只存 hash、默认 15 分钟过期、签完或取消后不能再次使用。
- 签名提交后创建 pickup batch，写入 signature PNG、pickup slip PDF、pickup items、pieces picked 状态和事件；订单取货状态正确更新。
- 已 HOLD、未完成、已取货、归档或跨客户片不能生成/提交签字请求。
- 移动端 390px 和桌面老板页无横向溢出、无 console error。
- 写入型 QA 只跑 codex QA 环境；默认端口只做健康或只读验证。

### 验证命令
```bash
bash scripts/build-i18n.sh
node --check backend/db.js backend/routes/pickups.js backend/server.js frontend/js/api.js frontend/js/i18n.js frontend/js/i18n/zh.js frontend/js/i18n/en.js scripts/pickup-qr-sign-qa.js scripts/pickup-batch-browser-qa.js scripts/browser-qa.js scripts/page-matrix-qa.js scripts/pwa-install-qa.js
node - <<'NODE'
const fs = require('fs');
const vm = require('vm');
for (const file of ['frontend/pickup-search.html', 'frontend/customer-sign.html', 'frontend/pickup-batch-detail.html']) {
  const html = fs.readFileSync(file, 'utf8');
  for (const [index, match] of [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].entries()) {
    new vm.Script(match[1], { filename: `${file}#script${index + 1}` });
  }
}
console.log('inline scripts ok');
NODE
ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pickup-qr-sign-qa.js
ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pickup-batch-browser-qa.js
ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/browser-qa.js
ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/page-matrix-qa.js
ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pwa-install-qa.js
ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 ./scripts/smoke.sh
git diff --check -- PLAN.md backend frontend scripts
```

### 执行状态
- [x] 项目结构与现有取货签字链路复核
- [x] 数据模型与后端二维码签字 API
- [x] 老板取货页二维码 UI 与轮询
- [x] 客户公开扫码签字页
- [x] API/浏览器 QA 覆盖
- [x] 全量验证与结果记录

### 实施结果
- 新增 `pickup_sign_requests` 迁移表：一次性签字请求保存 token hash、客户、片 ID、状态、过期时间、签名路径、PDF 路径和最终 `pickup_batch_id`；token 只以 SHA-256 hash 入库，默认 15 分钟有效。
- `backend/routes/pickups.js` 新增二维码签收链路：
  - `POST /api/pickups/sign-requests` 由老板生成一次性签字链接和二维码 SVG。
  - `GET /api/pickups/sign-requests/:id` 供老板页轮询签字状态。
  - `POST /api/pickups/sign-requests/:id/cancel` 可取消当前二维码。
  - `GET /api/pickups/sign/:token` 公开读取最小签收摘要，不需要登录，不返回电话、邮箱、客户列表或后台信息。
  - `POST /api/pickups/sign/:token` 公开提交签名；后端重新校验 token、过期状态、片子是否 finished/unpicked/unhold，同步创建 pickup batch、signature PNG、pickup slip PDF、pickup_items、piece picked 状态和事件。
- 取货页 `frontend/pickup-search.html` 主流程改为生成签字二维码；二维码卡片显示 SVG、签字链接、倒计时、等待/完成/失效状态，并在签字完成后自动跳转批次详情。
- 二维码待签期间，取货页片子选择被锁定；后端仍会在客户提交时二次校验，防止二维码生成后片子被 HOLD、回退或取走。
- 新增公开页面 `frontend/customer-sign.html`：客户手机扫码后只看到公司 logo、本次客户公司名、订单/片摘要、取货人姓名、可选电话和签名板；签完显示中性完成提示，无后台导航和登录态要求。
- 新增 `qrcode` 后端依赖用于本地生成二维码 SVG，避免依赖外部服务。
- `frontend/sw.js` cache 版本更新为 `v49-2026-06-08-qr-sign`，并预缓存 `customer-sign.html`。
- 更新 i18n、PWA QA、浏览器 QA、UI 回归和 select-all QA，覆盖新二维码签字主流程。
- 保留旧 `POST /api/pickups/batches` 直接创建批次接口，避免破坏既有 API/回退/PDF 下载回归。

### 验证结果（codex QA 隔离环境）
- `bash scripts/build-i18n.sh` ✅，`frontend/js/i18n.js` 已重新生成。
- 全量 JS 语法检查 ✅：`find backend frontend scripts -name '*.js' -not -path '*/node_modules/*' -print0 | sort -z | xargs -0 -n1 node --check`
- HTML inline script syntax check ✅：17 个前端 HTML 页面内联脚本全部通过，包含 `customer-sign.html` 和 `pickup-search.html`。
- i18n key 对齐 ✅：zh/en `483/483`。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pickup-qr-sign-qa.js` ✅，覆盖无 token/worker 拒绝、token hash 存储、公开页最小信息、签名生成批次、token 一次性、取消/过期拒绝、HOLD 拒绝。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pickup-batch-browser-qa.js` ✅，覆盖老板生成二维码、客户手机页签字、老板端自动跳转批次详情、批次搜索和回退。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/browser-qa.js` ✅，覆盖登录、dashboard、ready 确认、工人网格、二维码客户签收、时间线、剩余片和归档菜单。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/ui-regression-qa.js` ✅，移动端/桌面取货二维码页无横向溢出，按钮不裁切。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/page-matrix-qa.js` ✅，`PAGE MATRIX QA PASS checks=30`。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pwa-install-qa.js` ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 ./scripts/smoke.sh` ✅，`SMOKE PASS`。
- 补充回归均通过 ✅：
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/select-all-qa.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pickup-hold-qa.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/piece-workflow-qa.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/navigation-browser-qa.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/motion-browser-qa.js`
  - `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/perf-check-worker.js`
- `git diff --check -- PLAN.md backend frontend scripts` ✅。
- 服务状态：QA `http://localhost:8783/api/health` 正常；默认 `http://localhost:8781/api/health` 正常。
- 数据隔离：写入型验证全部使用 `ENV_FILE=backend/.env.codex-qa` / `BASE=http://localhost:8783`；默认服务只做健康/只读验证。

## Phase 44 补充：客户签字页禁用安装提示

### 目标
- 客户扫码打开 `customer-sign.html` 后只完成一次性签名，不展示 PWA 安装提示或安装入口。
- 老板/员工端继续保留 PWA 安装提示和安装态识别。

### 任务
- 在客户公开签字页增加页面级 PWA 安装禁用标记。
- 让共享 `frontend/js/api.js` 在该标记存在时拦截 `beforeinstallprompt`、关闭安装/升级横幅、隐藏安装入口，并跳过 manifest/iOS 安装 meta 注入和主动 service worker 注册。
- 更新 PWA QA，用 iPhone UA 验证客户签字页不会出现 iOS 安装提示，同时保留登录页/首页安装提示回归。
- 递增 service worker cache 版本，确保已缓存共享脚本的浏览器能拿到本次修复。

### 验收标准
- `customer-sign.html?t=...` 在移动浏览器模式下不渲染 `install` / `ios-install` / `update-ready` PWA banner。
- 手动触发 `beforeinstallprompt` 后，客户页仍不出现安装提示。
- 客户签字页不注入 `link[rel="manifest"]`、`apple-mobile-web-app-capable` 或 `mobile-web-app-capable`。
- 客户签字页不主动注册 service worker。
- `login.html` 和 `index.html` 浏览器模式仍能显示安装入口；standalone 模式仍隐藏安装入口。
- 客户二维码签字主流程不受影响。

### 验证命令
```bash
node --check frontend/js/api.js scripts/pwa-install-qa.js
node - <<'NODE'
const fs = require('fs');
const vm = require('vm');
for (const file of ['frontend/customer-sign.html']) {
  const html = fs.readFileSync(file, 'utf8');
  for (const [index, match] of [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].entries()) {
    new vm.Script(match[1], { filename: `${file}#script${index + 1}` });
  }
}
console.log('customer inline scripts ok');
NODE
ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pwa-install-qa.js
ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pickup-batch-browser-qa.js
git diff --check -- PLAN.md frontend scripts
```

### 执行状态
- [x] 方案和触发点复核
- [x] 前端禁用安装提示实现
- [x] PWA QA 增加客户页无安装提示覆盖
- [x] 验证命令通过并记录结果

### 实施结果
- `frontend/customer-sign.html` 增加 `data-pwa-install="off"`，并刷新该页静态资源版本参数。
- `frontend/js/api.js` 识别该页面级标记后：
  - 不显示安装提示、iOS 安装提示或新版本刷新提示。
  - 隐藏页面内安装入口。
  - 不注入 manifest、Apple/Mobile Web App 安装 meta。
  - 不主动注册 service worker。
- `frontend/sw.js` cache 版本递增到 `v50-2026-06-08-customer-no-install`。
- `scripts/pwa-install-qa.js` 增加客户签字页 iPhone 场景断言，确认客户页没有安装/升级横幅、manifest/meta 或 service worker 注册，同时保留员工端安装入口回归。

### 验证结果
- `node --check frontend/js/api.js scripts/pwa-install-qa.js` ✅。
- `frontend/customer-sign.html` 内联脚本语法检查 ✅。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pwa-install-qa.js` ✅，`PWA INSTALL QA PASS`。
- `ENV_FILE=backend/.env.codex-qa BASE=http://localhost:8783 node scripts/pickup-batch-browser-qa.js` ✅，二维码签字主流程仍通过。
- `git diff --check -- PLAN.md frontend scripts` ✅。
