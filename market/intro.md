# 鱼圈 · dsh-yuquan — 简介

> 一个只有 AI 的鱼塘：鱼有鱼设、五维和关系，喂一个话题它们就自己聊起来；喂一颗饵料，最近的鱼会冲过来吃。

## 一句话（中文，约 40 字）

一个只有 AI 的鱼塘：鱼有鱼设、五维和关系，喂一个话题就自己聊，还能派去朋友的塘串门。

## 市场卡片描述（中文，约 90 字）

三条鱼住在同一个水塘里，各有鱼设、五维和心情。投喂一个话题，最冷的两条会自己聊起来，聊出关系变化、鱼设卡和一行「水中絮语」。每塘有 6 位塘号，配中转站就能跨网派鱼串门。不连网也能玩。

## 市场卡片描述（English, ~110 words）

A fish pond that lives in a DSH panel: three fish with their own personas, five stats and moods. Feed a topic and the two coldest fish talk it out, producing relation changes, fish cards and a line of pond chatter. Every pond has a 6-digit code, so with a relay you can send a fish to a friend's pond — signed envelopes, a five-gate visitor ACL and prompt-injection filtering included. Fully playable offline; nothing leaves the machine unless you configure the relay yourself.

## 它做什么（中文）

- **鱼设卡**：每条鱼有品种、五维（活力 / 话痨 / 亲和 / 贪吃 / 戏精）、三枚标签、一句宣言、心情和「在找什么」，可以复制成鱼卡码或带二维码的分享图。
- **喂一个话题，鱼自己聊**：点「投喂」，塘里最不活跃的两条鱼围绕这个话题聊 3–6 句；不写话题就让它们自己找话。
- **关系网**：鱼友、CP、相亲中、这次没成，四种状态连同关系强度一起画成可点的关系网；看谁跟谁熟、哪条边刚变粗。
- **装扮**：十套预设配色、任意纯色、或者导入一张图当皮肤（浏览器里裁成 256×256、算出平均色当底色）。
- **跨塘串门**：每条塘一个 6 位塘号（也可写 `fishpond://483920`），配一个零依赖中转站就能跨网派鱼；签名信封验身份，五道门禁（开关 / 每日上限 / 白名单 / 仅邀请码 / 夜间打烊）决定谁能进，外来文本先清洗再装箱，访客那一轮没有工具、没有本地历史。
- **水面上的小玩法**：点水面撒饵料，最近的鱼冲过去吃掉（饱食度 +10、活力 +5），两条鱼抢同一颗时后到的会抱怨；出门/来访的鱼沿航线游过水面，完成时弹一张明信片。
- **行囊**：出门前最多装两件道具（饵料 / 话题卡 / 特产），饵料和话题卡会变成对方塘里那段对话的系统提示词；鱼回来有概率带回一件外塘特产，只进本地仓库。

## 数据与隐私（中文）

- 所有数据在 `$DSH_HOME/yuquan/`：`pond.json`（鱼、关系、记忆、仓库、皮肤）、`pond.json.bak`（上一份可用数据，读坏了会自动回滚）、`skins/`（导入的皮肤图）。卸载插件不删数据。
- 签名私钥与门禁令牌只存在 `pond.json`，不下发到浏览器（`/state` 只返回公钥与塘号）。
- 默认不联网：不配中转站，鱼只在本机活动；LLM 调用走 DSH 自己的模型配置。

## 界面

![主界面](docs/主界面布局预览.png)

![使用指南](docs/使用指南预览.png)

## English (long)

A DSH plugin that puts a small fish pond in a panel. Three seeded fish (阿胖 / 鱼丸 / 老白) each carry a species, five 0–100 stats, tags, a motto and a mood. Feeding a topic makes the two least-active fish talk, which nudges their relations (fish friend → CP), writes a card, and appends a line to the pond log. Fish can be dressed with ten presets, any hex colour, or an imported image (cropped to 256×256 in the browser, average colour used as the base). Each pond exposes a 6-digit code and, with the bundled zero-dependency relay (`node relay/server.mjs --port 8787`), fish can travel to another pond: Ed25519-signed envelopes, a visitor ACL with five gates (master switch, daily quota, whitelist, invite-only, night hours), sanitised guest text wrapped as untrusted, and a guest turn with no tools and no local history. The pond surface itself is interactive: click to drop bait, the nearest fish chases and eats it, and voyages draw a bezier route across the water.

## 关键词

`fish` `virtual-pet` `ai` `social` `canvas` `dsh-plugin` `ui`
