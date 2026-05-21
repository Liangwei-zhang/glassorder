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
```

PID 文件：`backend/logs/server.pid`
日志文件：`backend/logs/server.log`
端口：`backend/.env` 里的 `PORT`（默认 8781）

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
