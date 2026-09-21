# 四人《骗子酒馆》候选服务

这是一个独立的、内存态的四席位网页游戏候选实现。它使用 Node ES modules、Express 和 Socket.IO，无构建步骤；产品中的 AI 席位只调用房主明确配置的真实 LLM 接口，`bot.js` 没有规则型电脑玩家实现。

## 启动

```bash
npm install
HOST=127.0.0.1 PORT=3279 npm start
```

浏览器访问 `http://127.0.0.1:3279/`。`GET /health` 只返回服务状态和内存房间数量，不返回房间密钥或 LLM 密钥。

当前 V3 美术候选按用户要求改用 Canvas 2D 和生图模型生成的桌面、人物、道具与扑克牌素材，不再使用 Three.js 绘制场景。旧版前端保留在 `archive/v2/`，V1 归档没有覆盖。素材、生成提示词和验收边界见 `docs/art-v3.md`。

房间和 AI 密钥只存进当前 Node 进程内存，进程重启后房间消失；本版本没有数据库、账号系统或生产密钥。默认不会读取 `OPENAI_API_KEY`，也不会复用其他项目凭证。可以使用明确的 `LIARS_LLM_BASE_URL`、`LIARS_LLM_MODEL`、`LIARS_LLM_API_KEY`、`LIARS_LLM_PROTOCOL`、`LIARS_LLM_SYSTEM_PROMPT`、`LIARS_LLM_MAX_OUTPUT_TOKENS` 和 `LIARS_LLM_TOKEN_LIMIT_FIELD` 作为新房间 AI 默认值；没有这些配置时，AI 席位必须由房主在游戏设置填写，服务端不会以规则逻辑顶替。

## 席位、连接和权限

房间固定四个 `seatIndex`（0 至 3）。创建房间时 seat 0 是房主真人，其他席位默认为 `ai`；房主可以在大厅将非占用席位设为 `open`，真人使用 `join` 占用。房主可以把自己的 seat 0 切换成 `ai` 并作为旁观房主继续操作，之后可在大厅用 `kind:"human"` 恢复自己。房主身份由独立的 `hostToken` 保持，不依赖 seat 0 当前类型。

真人刷新后用 `sessionStorage` 保存的 token 调用 `resume`。同一席位或房主 token 的新连接会替换旧 Socket，旧连接不能继续操作；断线只标记 `connected:false` 并保留席位。大厅 `leave` 会释放席位；游戏中 `leave` 保留断线的真人席位，轮到该席位时由服务端明确标记“真人超时”并执行自动动作，不会伪装成 AI。AI 房主旁观连接全部离开后，服务端不再发起新的 LLM 请求。

## Socket 协议

所有操作通过 `socket.emit('action', payload, ack)`，ack 只有 `{ok:true,...}` 或 `{ok:false,error}`；每个房间状态通过 `state` 事件广播。输入受 32 KiB payload 限制，并按连接对创建、加入、恢复和游戏操作统一限速；服务端默认最多保留 256 个内存房间，空闲房间 TTL 到期清理。

创建、加入和恢复的 ack 形状为 `{ok:true,code,token,mySeat}`，旁观房主的 `mySeat` 是 `null`。常用 action：

```text
create    {name,gender:"male"|"female",skin:0|1}
join      {code,name,gender,skin,token?}
resume    {code,token}
profile   {name,gender,skin}
setSeat   {seatIndex,kind:"ai"|"open"|"human"}
configureAI {seatIndex,baseUrl,model,apiKey?,protocol?,persona?,systemPrompt?,maxOutputTokens?,tokenLimitField?,clearKey?}
retryAI   {seatIndex}
start / play {cardIds:[string,...]} / challenge / pullTrigger
restart   （仅房主，ended 后）
leave
```

`configureAI` 的 `apiKey` 只写入服务端房间内存；省略或发送空字符串会保留旧 key，只有 `clearKey:true` 会清除。普通客户端的 `players[].ai` 只含模型标签、协议、配置状态、`hasKey`、错误和 thinking 状态；完整 `baseUrl`、persona 和 system prompt 只在房主自己的 `hostConfigs` 中返回，永远不返回 key。

每个 LLM 请求只给该席位的自己的手牌和公开状态（目标牌、玩家存活/手牌数量/枪数、上一手、事件等），不发送对手暗牌、致死膛位、token 或其他席位的手牌。默认协议是 OpenAI-compatible Chat Completions，也支持 `responses` 和 `anthropic` 变体。模型只需返回 JSON：

```json
{"action":"play","cardIds":["自己的牌 id"],"speech":"一句公开台词"}
```

或者在当前允许质疑时返回 `{"action":"challenge","cardIds":[],"speech":"..."}`；轮盘阶段返回 `{"action":"pullTrigger","cardIds":[],"speech":"..."}`。输出格式错误最多追加一次修复请求，仍错误就暂停该 AI 席位并显示错误，房主可 `retryAI`，没有无限重试和规则 fallback。`tokenLimitField:"auto"` 会对 `gpt-5`/`o1`/`o3`/`o4` 使用 `max_completion_tokens`，普通 Chat Completions 使用 `max_tokens`；默认预算 4096，每席可调整到 256–32768。

## 状态字段

`state` 包含 `code`、`phase`（`lobby|playing|reveal|roulette|ended`）、`hostSeat`、`isHost`、`round`、`targetRank`、`turnSeat`、四个公开玩家、当前连接自己的 `selfSeat` 与 `hand`、`lastPlay`、`mustChallenge`、`pileCount`、`loserSeat`、`reveal`、`lastShot`、`winnerSeat`、最近 12 条 `events`、服务端 `deadline` 和递增 `revision`。客户端只会收到自己的手牌；空 seat 和旁观者的 `selfSeat` 为 `null`。

## 规则约定

- 牌库是 6 张 A、6 张 K、6 张 Q、2 张 Joker；每个存活席位每轮发 5 张。
- 每轮目标从 A/K/Q 随机选择。首轮随机先手；之后空枪的开枪者先手，中弹淘汰则从其后固定顺序找下一名存活者先手，这是本项目的明确约定。
- 当前玩家暗出 1 至 3 张并宣称目标牌；Joker 视为万能牌。下一位有牌的存活玩家只能针对上一手选择出牌或质疑；空手席位跳过。
- 只剩一位持牌者时，必须质疑上一手；不允许把该玩家自己的剩牌自动翻开。
- 质疑在 `reveal` 阶段公开上一手牌面。只要存在一张既不是目标牌又不是 Joker，就判该手为诈唬，输家是出牌者；否则输家是质疑者。
- 输家在 `roulette` 阶段自行 `pullTrigger`。每位玩家开局得到 1 至 6 的隐藏致死膛位；空枪后 shots 永久增加，下一次风险是 `1/(6-shots)`，新轮发牌不重置。结果至少可见 3 秒后再发牌；中弹淘汰，存活者不超过一人时进入 `ended`。
- reveal、轮盘可见、真人/AI 回合和 AI 延迟均由服务端计时器控制，测试可注入缩短时长；客户端 deadline 只用于显示，不能裁决动作。

## 测试

```bash
npm test
npm run check
```

测试覆盖规则校验、只剩一人持牌、1/6 到必死概率、跨轮 shots、随机确定性测试策略的全 AI 完整模拟、Socket 状态隔离、权限、token 重连和真实计时器的 reveal → roulette → 开枪 → 下一轮广播。全 AI 模拟使用测试注入的确定性策略，仅证明服务端状态机不会死循环，不是产品 AI 或真实模型验收，也不产生外部 LLM 调用。

`test/room-probe.mjs` 是可选的人工联调脚本：它用 `socket.io-client` 建立四个真人测试连接，以每个连接私有的 state 推进牌局；脚本操作者是测试真人，不会把自己标成 AI。
