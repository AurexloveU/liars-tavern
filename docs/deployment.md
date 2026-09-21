# Liar's Tavern 独立上线方案

更新：2026-09-21

本文只准备上线产物和可审查的变更方案；本轮已完成只读远端预检，没有上传文件、安装 systemd、修改 Caddy、重启服务或执行部署。

## 目标边界

| 项目 | 固定值 |
|---|---|
| 远端 release 根目录 | `/opt/liars-tavern` |
| 当前 release | `/opt/liars-tavern/current`（原子切换的符号链接） |
| systemd | `liars-tavern.service` |
| 服务账号 | `liars-tavern:liars-tavern`，无登录 shell |
| 监听 | `127.0.0.1:3279` |
| 公网入口 | `https://aurexaevi.xyz/tavern/` |
| 上游路径处理 | Caddy `handle_path` 去掉 `/tavern` 后代理到 `127.0.0.1:3279` |

本服务是独立 Node 进程。计划不会写入、替换、重启或读取运行数据中的 `/opt/aevi-home`、`aevi-home.service`、人格文件或 Aevi `data/`；只在 Caddy 主站点块增加带标记的 `/tavern` 路由。

## 现有发布路径核查结论

结论：仓库有可复用的**纪律和模式**，没有可直接复用的通用“新增独立服务 + Caddy 路由”发布管线。

- `scripts/deploy-lock-lib.sh` 是通用互斥锁库。它使用本地 `/tmp/aevi-deploy.lock.d` 和 VPS `/run/aevi-deploy.lock.d`，持锁时应等待，不能手工破锁；只有明确确认持锁进程已经死亡时才允许人工使用 `AEVI_LOCK_BREAK=1`。
- `scripts/safe-deploy.sh` 是 `/opt/aevi-home` 的点名文件发布器，默认目标是 `aevi-home.service`，默认健康地址是 `/health`。它虽然有环境变量覆盖目录、服务和健康地址，但本身不负责创建独立服务账号、安装新 systemd unit、原子切换独立 release，或备份/修改 Caddy，因此不能把它当作本项目的完整部署器，也不能拿环境变量绕过既有边界。
- `scripts/deploy-lean-in.sh`、`scripts/deploy-tasogare-coread.sh` 和 `scripts/deploy-coread-caddy-route.sh` 展示了独立侧车的正确形态：先拿同一部署锁，隔离暂存，备份 unit/Caddy/旧目录，验证后提升，`caddy validate` 后 reload，失败恢复；但这些脚本把产品名、路径、端口、健康接口和 Caddy 锚点写死，不能原样用于 Liar's Tavern。

因此本轮不复用既有产品专用脚本，也不执行远端动作；已在隔离项目内准备并完成静态审查的 `ops/deploy-candidate.sh`，它是本项目的独立发布候选。root 取得本次具体上线确认后，只需在源码冻结、manifest 切成 frozen、测试通过的前提下执行这条候选；候选本身还会再次拒绝 draft manifest 和 `AEVI_LOCK_BREAK=1`。

## 已准备的上线产物

- `ops/systemd/liars-tavern.service`：只监听回环地址，以专用无登录账号运行；使用 `NoNewPrivileges`、`PrivateTmp`、`ProtectSystem=strict`、`ProtectHome`，没有写入权限需求。
- `ops/caddy/aurexaevi.xyz.tavern.caddy`：应插入现有 `aurexaevi.xyz` 站点块；精确匹配 `/tavern`、`/tavern/*`，把无尾斜杠入口重定向到 `/tavern/`，再用 `handle_path` 去前缀代理。Socket.IO 的 `/tavern/socket.io/*` 也因此转成上游 `/socket.io/*`，WebSocket upgrade 由 `reverse_proxy` 处理。
- `ops/deploy-candidate.sh`：候选独立发布管线；本地打包后取得共享部署锁，执行 VPS 只读预检，上传固定 artifact 到隔离暂存，校验后原子切换 release，安装独立 unit，先验证 Caddy 临时文件，再写入同目录 `.next` 文件并用 `mv -Tf` 原子替换后 reload，检查 Aevi MainPID/NRestarts 不变，失败恢复新服务、current、unit 和 Caddy 备份。
- Caddy 语法依据官方 [`handle_path` 文档](https://caddyserver.com/docs/caddyfile/directives/handle_path)：`handle_path` 只接受内联单一路径 matcher，故片段使用字面 `handle_path /tavern/*`，没有使用命名 matcher。
- `ops/release-manifest.json`：已冻结为 `liars-tavern-20260921-v1`，包含本次点名文件的 SHA-256；打包及部署时均验证工作区与清单一致。
- `ops/package-release.sh`：仅本地运行；先执行 `npm run check` 和 `npm test`，再逐文件校验 manifest，制作不含 `node_modules` 的 tar.gz 和 SHA-256 sidecar。它没有 SSH、rsync、systemctl、Caddy 或远端路径操作。

生产依赖在 release 中重新安装，不把当前 macOS 的 `node_modules` 打包到 VPS：

- Node.js 22，且 `/usr/bin/node` 可用；
- npm、`tar`、`curl`、`rsync`、systemd、Caddy；
- 可创建或已经存在 `liars-tavern:liars-tavern`；
- `127.0.0.1:3279` 在最终发布前仍为空；
- Caddy 当前配置包含 `aurexaevi.xyz, www.aurexaevi.xyz` 主站点块，且 `/tavern` 标记尚不存在或与审核片段完全一致。

LLM API key 不写入 systemd、manifest、release tar 或仓库；房主在游戏设置页填写已有接口配置。

## 取得上线确认后的精确步骤

### 1. 本地冻结和打包

在本项目目录执行：

```sh
npm ci
ops/package-release.sh
```

源文件冻结、manifest 刷新为明确 v1 并且所有测试通过后，脚本应生成：

```text
ops/dist/liars-tavern-20260921-v1.tar.gz
ops/dist/liars-tavern-20260921-v1.tar.gz.sha256
```

发布前记录 tar、manifest、每个文件的 SHA-256；如果工作区内容与 manifest 不符，停止并重新冻结审核版本，不修改代码或跳过校验来掩盖差异。

### 2. 加锁和 VPS 预检

专用 pipeline 必须先 source 仓库的 `scripts/deploy-lock-lib.sh` 并取得本地、远端锁。预检只读核对：

```sh
node --version
command -v /usr/bin/node npm caddy curl tar rsync systemctl
systemctl is-active caddy
systemctl is-active aevi-home.service
ss -ltnp | grep -E '127\.0\.0\.1:3279|:::3279' || true
test ! -e /etc/systemd/system/liars-tavern.service || sed -n '1,220p' /etc/systemd/system/liars-tavern.service
```

若 3279 已被占用、Node 不是目标版本、Caddy 不 active、已有 unit 与本次 manifest 不一致，停止，不覆盖。预检同时记录 `aevi-home.service` 的 `MainPID`、`NRestarts`、`ActiveEnterTimestamp`，用于证明独立服务上线没有重启 Aevi。

### 3. 隔离暂存和 release 安装

在锁内把固定 tar 上传到 `/opt/liars-tavern-incoming/<releaseId>/`，校验 sidecar 和 manifest，然后解压到该暂存目录。暂存检查至少包括：

```sh
cd /opt/liars-tavern-incoming/<releaseId>
npm ci --omit=dev --no-audit --no-fund
node --check server.js
node --check game.js
node --check ai.js
node --check bot.js
HOST=127.0.0.1 PORT=3279 node server.js
```

最后一条只用于短暂 smoke test，需由 pipeline 捕获进程并清理；不能让它和 systemd 同时占用 3279。更稳妥的 pipeline 可以先用临时端口运行 `/health`，再停止临时进程。

安装前备份已有 `/opt/liars-tavern`、`/etc/systemd/system/liars-tavern.service`（如果存在）和 `/etc/caddy/Caddyfile` 到带 release id 的 `/var/backups/aevi/` 文件，备份设置为 `0600` 并用 `tar -tzf`/哈希验证可读。确认暂存 manifest 后，将暂存目录提升为 `/opt/liars-tavern/releases/<releaseId>`，以临时链接再 `mv -Tf` 原子更新 `/opt/liars-tavern/current`。

### 4. 安装并启动独立 systemd 服务

仅安装本项目 manifest 中的 unit：

```sh
install -m 0644 ops/systemd/liars-tavern.service /etc/systemd/system/liars-tavern.service
systemctl daemon-reload
systemctl enable liars-tavern.service
systemctl restart liars-tavern.service
systemctl is-active --quiet liars-tavern.service
```

服务应以 `liars-tavern` 用户运行，并只能看到 `/opt/liars-tavern/current` 的代码；不应使用 root，不应把 API key 放进 unit。

### 5. 受保护地加入 Caddy 路由

先保存完整 Caddyfile。只在现有主站点块中插入 `ops/caddy/aurexaevi.xyz.tavern.caddy` 的标记块；标记已存在但正文不完全相同则停止，不能盲目替换。然后：

```sh
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
systemctl is-active --quiet caddy
```

这里只 reload Caddy，不 restart `aevi-home.service`，也不触碰其 unit、代码或 data。

### 6. 分层验收

先验收独立服务：

```sh
systemctl is-active liars-tavern.service
systemctl show liars-tavern.service -p User -p Group -p MainPID -p NRestarts
ss -ltnp | grep '127.0.0.1:3279'
curl -fsS http://127.0.0.1:3279/health
```

预期 `/health` 含 `"ok":true` 和 `"service":"liars-tavern"`。再验收 Caddy 去前缀和 Socket.IO 入口：

```sh
curl -fsS --resolve aurexaevi.xyz:443:127.0.0.1 \
  https://aurexaevi.xyz/tavern/ | grep -q "Liar"
curl -fsS --resolve aurexaevi.xyz:443:127.0.0.1 \
  'https://aurexaevi.xyz/tavern/socket.io/?EIO=4&transport=polling' | grep -q 'sid'
```

最后复核既有服务和公网路径：

```sh
systemctl is-active --quiet aevi-home.service
systemctl is-active --quiet caddy
curl -fsS https://aurexaevi.xyz/health | grep -q '"ok":true'
curl -fsS https://aurexaevi.xyz/tavern/ | grep -q "Liar"
```

记录新服务 PID、`NRestarts`、监听地址、Caddy reload 时间和所有返回码；把发布前后 `aevi-home.service` 的 MainPID/NRestarts 对照写入发布记录。服务 active、HTTP 200、文件哈希只证明对应层，不代替浏览器真实打开、建房、加入、Socket.IO 双向消息和 AI 设置页的用户可见验收。

## 回滚

回滚仍在同一部署锁内完成，不破锁、不执行裸 SSH/rsync：

1. 暂存或 manifest 校验失败：删除暂存目录，保持现网不变。
2. systemd 安装/启动或本机 `/health` 失败：停止新服务；恢复旧 `current` 符号链接和旧 unit（没有旧版本则移除本次新 unit），`daemon-reload` 后恢复原服务状态。
3. Caddy 插入、validate、reload 或 `/tavern/` 验收失败：从本次备份恢复完整 Caddyfile，重新 `caddy validate`，只 reload Caddy。
4. 任何公网验收失败：先回滚 Caddy 和 Liar's Tavern，再重新验收 `aevi-home.service` 与 `https://aurexaevi.xyz/health`；不为修复新服务重启 Aevi。
5. 保留本次 tar、manifest、备份路径和失败日志；不要删除旧 release，直到新服务和回滚点都被核验。

## 本轮静态验证

- `bash -n ops/deploy-candidate.sh`、`bash -n ops/package-release.sh` 通过。
- 已把候选中的两段远程 `sh -s` heredoc 单独抽出，用 `sh -n` 检查通过；这不会连接 VPS，也不会执行 heredoc。
- `node --check game.js ai.js bot.js server.js` 和 manifest JSON 解析通过。
- 最近一次 `npm test` 观察到 16 项通过、0 项失败；源码仍需在最终冻结后再重跑一次，才能把这次结果绑定到 v1 manifest。因此本轮仍没有生成 release archive，也没有把 draft 标成上线版本。
- 本机没有 Caddy 二进制，片段未在本地 full Caddyfile 上运行 `caddy validate`；`handle_path` 语法已按官方文档核对，最终 validate 仍必须在 VPS 现有完整 Caddyfile 上完成。

## 当前候选状态

源码和文件清单已冻结为 `liars-tavern-20260921-v1`。`ops/package-release.sh` 会重新运行检查和测试、校验所有点名文件哈希，再生成本地 tar.gz 和 SHA-256 sidecar。部署候选的两个本地 shell 脚本和两段远程 heredoc 均已通过语法检查；这些检查没有执行远程写入。

真正上线前仍需按 AGENTS 第 11 条，针对这一次独立新服务、专用部署 pipeline、Caddy 路由及其可见影响取得明确确认。目前没有部署。
