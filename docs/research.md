# Liar's Deck 调研报告

更新：2026-09-21

范围：只研究 Steam《Liar's Bar》的经典纸牌模式 Liar's Deck，以及可借鉴的开源实现。本文件不复制任何代码，不改变游戏后端。

## 1. 证据分层

Steam 官方商店页确认了基本循环：玩家把牌面朝下打出并声明牌型；可疑时可以质疑；谎言被抓到的一方进行左轮；左轮处理后牌局重置并继续。官方页没有给出最后手牌、转序、牌堆构成的完整规范。

Debigare 的规则复原文档明确说明其规则来自游戏内教程、实际游玩观察和开发者评论，并注明可能存在版本 bug 差异。下文把它作为“原作规则复原”，不把它误称为官方规则文本。

LYiHub 项目的 `prompt/rule_base.txt` 和 `game.py` 是一个 Apache-2.0 开源 AI 复刻的实现证据；它的自动质疑处理是该项目实现细节，不能反推成原作 Basic 规则。

主要来源：

- [Steam 官方商店页](https://store.steampowered.com/app/3097560/Liars_Bar/)
- [官方移动版 Google Play 说明](https://play.google.com/store/apps/details?id=com.CurveAnimation.LiarsBar)
- [Debigare：Liar's Deck 完整规则复原](https://www.debigare.com/how-to-play-liars-deck-from-liars-bar-full-rules-and-variants/)
- [LYiHub/liars-bar-llm](https://github.com/LYiHub/liars-bar-llm)
- [LYiHub 的规则文本](https://raw.githubusercontent.com/LYiHub/liars-bar-llm/main/prompt/rule_base.txt)
- [LYiHub 的游戏逻辑](https://raw.githubusercontent.com/LYiHub/liars-bar-llm/main/game.py)

## 2. 经典 Liar's Deck 原作规则复原

### 2.1 牌、桌面牌型和发牌

- 玩家数为 2–4；本项目固定四个座位。
- Liar 牌堆共 20 张：A×6、K×6、Q×6、Joker×2。
- 另有只含 A、K、Q 的桌面牌型牌堆；每轮从中随机翻出一张，成为本轮目标牌型。
- 经典模式的桌面牌型只有 A、K、Q。经典模式没有 Joker 桌。
- Joker 是当前桌面牌型的万能牌：在 King's Table 中算 K，在 Queen's Table 中算 Q，在 Ace's Table 中算 A。
- 每轮重新洗 Liar 牌堆，每名存活玩家发 5 张。四名玩家时 20 张全部发出；存活玩家少于四人时，剩余牌留在本轮牌堆外，不向玩家展示。
- 首轮起始玩家随机。

### 2.2 出牌与质疑时机

- 玩家按固定转序行动；规则复原文档采用逆时针。具体座位画面可以把南位作为玩家本人，但服务器应保存一个明确的 seat order，不要让客户端自行推断方向。
- 第一位玩家只能出牌，不能质疑，因为没有上一手。
- 每回合玩家从自己的手牌中选择 1–3 张，面朝下放入中央牌堆，声明它们是当前桌面牌型。实际牌可以是目标牌、Joker 或其他牌；是否说谎由翻牌时判定。
- 出牌后，只有固定转序中的下一名存活玩家可以在自己的行动窗口中二选一：质疑上一批，或不质疑并出自己的 1–3 张牌。其他玩家不能插入式质疑，也不能事后质疑已经跳过的牌。
- 质疑后只翻开被质疑者刚刚打出的那一批牌：
  - 只要有一张既不是当前目标牌也不是 Joker，质疑成功，被质疑者进行左轮；
  - 如果全部是目标牌或 Joker，质疑失败，质疑者进行左轮。
- 一旦发生质疑，当前小轮立即结束；无论枪响与否，牌堆都会清空并进入下一轮重新发牌。

### 2.3 最后手牌：原作边界

Debigare Basic rules 的原文是：当只剩一名玩家手里仍有牌时，该玩家必须对上一位玩家叫 `LIAR`。这不是“系统替他翻开自己的全部剩余手牌”。

准确状态机含义：

1. 玩家手牌为零后，本轮后续跳过其出牌回合。
2. 若仍有两名或更多存活玩家持有牌，其他持牌玩家继续轮流行动。
3. 当回合轮到唯一仍有手牌的玩家时，该玩家的合法动作被限制为 `challenge`，目标是上一位玩家刚刚打出的那一批牌。
4. 该质疑按普通质疑规则结算；若上一位玩家已经打完最后手牌，也仍然可以被质疑那一批最后牌。
5. 质疑结束后重新发牌；“打完手牌”只使玩家离开本轮出牌序列，不会直接赢得整局。

LYiHub 的 `handle_system_challenge()` 会把唯一持牌玩家自己的整手牌自动翻出并系统质疑。这是该复刻的变体，不能作为本项目的经典规则依据；本项目应实现“唯一持牌玩家强制质疑上一手”。

### 2.4 左轮概率与淘汰

原作官方商店页只明确“一枚子弹、六个位置”；规则复原文档采用每名玩家独立的 `Death + Blank×5` 牌组，每次开枪翻出并移除顶部结果。

本项目选定采用该可审计模型，因此每名玩家的下一次死亡率为：

| 已安全开枪次数 | 剩余结果 | 下一次死亡率 |
|---:|---|---:|
| 0 | 1 Death + 5 Blank | 1/6 |
| 1 | 1 Death + 4 Blank | 1/5 |
| 2 | 1 Death + 3 Blank | 1/4 |
| 3 | 1 Death + 2 Blank | 1/3 |
| 4 | 1 Death + 1 Blank | 1/2 |
| 5 | 1 Death | 1 |

Blank 被消耗但玩家继续存活；Death 使玩家淘汰。新一轮发牌不重置该玩家的左轮进度；淘汰玩家不参加后续轮次。剩余一名存活玩家时整局结束。

## 3. 下一轮先手：来源差异与项目约定

来源并不一致，不能把一个复原实现写成所有版本都相同：

- Debigare 的 Basic rules 写的是：若质疑抓到骗子，则由被抓到的玩家开始下一轮；否则由转序中的下一名玩家开始。
- LYiHub 的实现把 `last_shooter_name` 作为下一轮起点；开枪者仍存活就由其先手，开枪者死亡则顺延到下一名有手牌的存活玩家。这个是 LYiHub 的代码行为，不是官方规范。
- 官方 Steam 商店页没有写下一轮先手规则；官方移动版当前说明页也没有提供足以支持“最后开枪者先手”的规范文本。

因此本项目明确记录为**项目约定**，不标为官方规则：

> 上一小轮实际开枪者若仍存活，则由其作为下一轮起始玩家；若已死亡，则沿固定转序寻找下一名存活玩家。首轮起点随机。

这样可以在服务端形成唯一、可测试的裁决，同时把它与原作资料差异隔离开。

## 4. 变体排除

Joker 作为桌面牌型，以及 7 张手牌等规则属于 `Liar's Deck 2` 变体；Debigare 文档将其单列为 Variant。经典项目不应把 Joker 加入桌面牌型，也不应使用 7 张起手牌。

## 5. 开源候选核查

### 5.1 LYiHub/liars-bar-llm

- URL：<https://github.com/LYiHub/liars-bar-llm>
- License：Apache-2.0，仓库有 `LICENSE`。
- 技术栈：Python；OpenAI-compatible API；`game.py` 在一个进程内驱动 2–4 个 LLM 玩家。
- 联机判断：不是浏览器实时多人服务器，没有 Socket/WebSocket 房间；属于本地 AI 对战/批量实验框架。
- 可借鉴：规则数据结构、牌局状态推进、AI 出牌/质疑的结构化 JSON 协议、LLM API 适配。
- 不宜直接复用：其自动质疑唯一持牌玩家的逻辑是本项目不采用的变体；API 配置是代码/环境配置，没有本项目所需的游戏内设置页。

### 5.2 Vinicius-Tineli-Paiva/Liars-Bar

- URL：<https://github.com/Vinicius-Tineli-Paiva/Liars-Bar>
- License 状态：GitHub 仓库元数据没有识别到 `LICENSE` 文件；README 的 License 段声称 MIT，二者不一致。在作者补充明确许可证前不应直接复制代码。
- 技术栈：Node.js/Express/TypeScript/PostgreSQL/JWT/Zod/`ws`；Vite + Vanilla TypeScript；Docker/Nginx。
- 联机判断：README 明确描述 4 人实时 WebSocket 房间、出牌/质疑、30 秒计时和左轮，但未在本次调研中运行验证。
- 可借鉴：服务端权威状态、房间/用户/持久化分层、WebSocket 同步方向与本项目较接近。
- 不宜直接复用：身份认证、数据库和上传系统超出本项目当前范围；许可证未落定；其牌局边界仍需逐函数核对。

### 5.3 lldq666/liars-bar-game

- URL：<https://github.com/lldq666/liars-bar-game>
- License：MIT，仓库有 `LICENSE`。
- 技术栈：Python Flask + Flask-CORS；原生 HTML/CSS/JavaScript；内存状态；前端每 2 秒轮询。
- 联机判断：有 2–4 人房间、创建/加入/准备/出牌/质疑 API，但不是 WebSocket 实时同步。
- 规则差异：使用每人 10 个筹码，质疑成功/失败扣筹码；没有本项目要求的逐玩家左轮概率模型。
- 可借鉴：简单房间 API 和玩家准备流程；不宜作为 Three + Node 核心游戏引擎或规则实现。

## 6. 结论

没有候选仓库可以整体直接复用。本项目应继续使用现有 Three + Node 实时联机架构，自建服务器权威游戏状态。最有价值的开源参考是 Apache-2.0 的 LYiHub 项目，但只借鉴 AI 接口和状态组织方式，并明确修正其“系统自动翻唯一持牌玩家手牌”的变体行为；最终 AI 由游戏设置页提供 `base URL / API key / model`。
