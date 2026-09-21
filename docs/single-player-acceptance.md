# 本机 Codex 单机局验收记录

日期：2026-09-21。范围：`experiments/liars-tavern-20260921` 本机 Codex entry。未修改 Aevi 生产、人格、聊天或用户数据。

## 入口与状态协议

- `GET /api/config` 返回 `soloMode: true`。
- `soloStart` 创建唯一的本机局，固定真人 seat0，首轮 `turnSeat=0`，立即进入 `playing`。
- `soloResume` 无参数恢复本机唯一局；无存档返回 `{ok:true,empty:true}`。恢复只绑定 seat0，不自动解除暂停。
- `soloPause` 暂停服务器调度；`soloContinue` 才恢复当前 AI 请求或轮盘计时。
- state 对本机局公开 `soloMode`、`paused`，`code` 为 `null`；真人回合 `deadline` 为 `null`。

## 已观察到的浏览器行为

CUA 实际操作验证：首局真人 seat0 获得 5 张牌；点击暂停后刷新页面，仍是同一局、`paused=true`、同一手 5 张牌；点击继续，选择 1 张并点击 Return，手牌从 5 张变为 4 张，回合转到 AI1。刷新前后的私有手牌保持在真人自己的 state 中。

此前已经复现的回归是：暂停后刷新曾因 `soloResume` 自动调用 `resumeSolo` 而解除暂停并启动 AI。现行语义将恢复连接与继续游戏分开，刷新不会偷偷开始 AI。

## 自动测试

root 最终运行记录：`npm test` 37/37 通过。单机专项覆盖：

- 单机启动、唯一连接和第二 tab 恢复；
- 暂停状态保持、排队的 play/challenge/pullTrigger/timeout 被规则层拒绝；
- 无本地连接时不发起新的 AI 请求；
- 跨进程快照恢复、暂停恢复和 API key 擦除；
- 普通多人 Socket 隔离、轮盘计时和已有规则回归。

存档只写游戏自己的 `ops/codex-runtime/solo-state.json`；测试使用临时目录。修改前备份为 `ops/before-solo/20260921-053950/`。

## 验收边界

本记录没有真实 Codex 模型 turn 验收，也没有把确定性 provider、零模型测试或浏览器状态转移当作模型博弈质量证据。真实模型的多轮出牌、质疑、轮盘、错误重试和延迟仍需另行记录。

## Final local acceptance

- 2026-09-21 (Asia/Shanghai): `npm test` passed 37/37.
- Browser: closing the test tab and opening a new one restored seat 0, the same four remaining cards, and paused state.
- Isolated live test on port 3282: one actual GPT-5.6 Luna Max call, zero format retries; human hand 5 -> 4, AI seat 1 played, then paused. Model latency: 26886 ms. Evidence: `ops/solo-live-verification.log`; runnable check: `ops/verify-solo-codex.mjs`. This is one real AI decision, not a whole-match live acceptance.
- Local user preview at http://127.0.0.1:3280/ now runs solo mode. Browser verified one human and three Codex seats, five human cards, round 1, human seat 0 first. No human cards played in the delivered game.
- No Aevi production, personality, conversation, domain or VPS changes.
