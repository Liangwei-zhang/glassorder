# Glass Order

玻璃厂订单管理 v1：Express + SQLite 后端，同源服务 vanilla JS 前端。

## 启动

### 方式 A：项目脚本（推荐，后台守护）

```bash
./scripts/start.sh      # 后台启动（首次会自动 npm install + 写随机 JWT_SECRET 的 .env）
./scripts/status.sh     # 看进程 + 健康检查
./scripts/logs.sh       # 实时 tail 日志（Ctrl+C 退出；不会停服务）
./scripts/logs.sh 200   # 只打印最后 200 行
./scripts/restart.sh    # 重启
./scripts/stop.sh       # 停止
./scripts/smoke.sh      # 跑烟测（必要时自动起停）
./scripts/start.sh -f   # 前台运行（调试用，Ctrl+C 结束）
./scripts/init-demo-env.sh             # 生成独立 demo profile
ENV_FILE=backend/.env.demo ./scripts/start.sh
./scripts/backup-runtime.sh            # 备份当前 profile 的 DB 和 uploads
./scripts/clear-test-data.sh           # 预演清空业务测试数据
CONFIRM_CLEAR_TEST_DATA=1 ./scripts/clear-test-data.sh --apply   # 备份后清空业务测试数据，保留账号
```

PID 文件：`backend/logs/server.pid`
日志文件：`backend/logs/server.log`
端口：`backend/.env` 里的 `PORT`（默认 8781）

如果用 `ENV_FILE=backend/.env.demo` 之类的独立 profile 运行，PID 和日志会自动切到对应文件名，
例如 `backend/logs/server-demo.pid`、`backend/logs/server-demo.log`。

### 方式 B：直接 npm（前台）

```bash
cd backend
npm install
npm start
```

浏览器打开 `http://localhost:8781`。

初始账号：

- 老板：`admin` / `admin123`
- 工人：`worker` / `worker123`

## 验收路径

1. 登录 admin。
2. 进入客户管理，新增客户。
3. 新建订单，选择客户并上传仓库根目录的样品 PDF：`Glass Order - 2605011 Inspire --8 Heritage Cove.pdf`。
4. 进入工人视图，确认能看到 8 片，点单片能查看图纸。
5. 对片子执行完成、碎了、HOLD/解除 HOLD。
6. 所有片完成后在订单详情点击可取货（需模态确认）。
7. 进入取货签字，签名并二次确认后生成 pickup PDF。
8. 回到订单详情可看到事件时间线，以及「下载取货凭证 PDF」入口。

## 自动烟测

```bash
cd backend
npm run smoke
```

烟测覆盖登录、401、客户 CRUD、XSS 输入持久化、非 PDF 拦截、无效 customer_id 清理、
样品 PDF 解析、重复订单（独立目录）、片子流转、ready/pickup 和 PDF 生成，连跑两次仍全绿。

浏览器 QA 脚本依赖 Playwright，依赖已声明在 `backend/package.json`；首次安装后可运行根目录
`scripts/*browser-qa.js` 相关脚本。

## 发布前 QA 清单

交付或演示前建议在仓库根目录按下面分层执行。

必跑检查，失败就不要交付：

```bash
bash scripts/status.sh
cd backend && npm run smoke
cd ..
node scripts/security-regression.js
node scripts/page-matrix-qa.js
node scripts/navigation-browser-qa.js
```

浏览器主流程覆盖，适合每次 UI 或入口调整后运行：

```bash
node scripts/browser-qa.js
node scripts/pickup-batch-browser-qa.js
```

专项回归，覆盖取货、汇总、动效和工人高频操作：

```bash
node scripts/pickup-batch-smoke.js
node scripts/summary-smoke.js
node scripts/motion-browser-qa.js
node scripts/perf-check-worker.js
```

其中 `security-regression.js` 覆盖权限、上传访问和错误输入回归；`page-matrix-qa.js`、
`navigation-browser-qa.js`、`browser-qa.js` 覆盖主要页面可打开和基础流程；取货、汇总、
动画和工人性能分别由对应专项脚本覆盖。

## 测试数据说明

项目脚本默认复用同一套运行目录：

- 数据库：`backend/glass.db`
- 上传文件：`backend/uploads/`
- 日志和 PID：`backend/logs/`

smoke 和浏览器 QA 会写入测试客户、订单、取货批次、签名和 PDF。长期演示或交付前，
建议先备份或清理 `backend/glass.db` 与 `backend/uploads/`，避免把历史 QA 数据混入正式验收。

如果你需要把演示环境和默认环境彻底分开，直接生成并使用独立 profile：

```bash
./scripts/init-demo-env.sh
ENV_FILE=backend/.env.demo ./scripts/start.sh
ENV_FILE=backend/.env.demo ./scripts/backup-runtime.sh
CONFIRM_CLEAR_TEST_DATA=1 ENV_FILE=backend/.env.demo ./scripts/clear-test-data.sh --apply
```

`DB_PATH` 和 `UPLOADS_DIR` 都会跟随该 profile 切换，避免默认库和默认上传目录被污染。

清理脚本默认只 dry-run，真正执行必须同时加 `--apply` 和 `CONFIRM_CLEAR_TEST_DATA=1`。执行时会先停止当前 profile、备份 DB/uploads、
清空业务表和上传文件、保留 `users` 与 `schema_migrations`，最后重启当前 profile 并校验清理结果。
脚本会拒绝未知表和异常 uploads 路径，避免后续新增业务表后漏清，或误删非上传目录。
为降低误操作风险，清理脚本也会拒绝非 `glass*.db` 数据库文件名、拒绝非空备份目录；如果在停服务后、
真正清理前失败，会尝试恢复原本正在运行的 profile。
