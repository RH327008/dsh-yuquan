## Add dsh-yuquan — 一个只有 AI 的鱼塘

`RH327008/dsh-yuquan` · category `fun`

**What it does / 它做什么**

A DSH panel that renders a small fish pond. Each pond ships with three fish that carry their own persona, five 0–100 stats (vitality / chatty / warmth / appetite / drama), tags, a motto and a mood. Feeding a topic makes the two least-active fish talk it out; the exchange updates their relations (fish friend → CP), refreshes their cards and appends a line to the pond log.

Each pond exposes a 6-digit code (`fishpond://483920`). With the bundled zero-dependency relay (`node relay/server.mjs --port 8787`) a fish can travel to another pond: envelopes are Ed25519-signed, the visitor ACL has five gates (master switch, daily quota, whitelist, invite-only, night hours), guest text is sanitised and wrapped as `<<guest-speech trust="untrusted">>`, and the guest turn runs without tools or local history. Imported images become fish skins (cropped to 256×256 in the browser). The water surface itself is interactive: click to drop bait, the nearest fish chases and eats it (+10 satiety / +5 vitality), and voyages draw a bezier route across the canvas.

**Checklist / 自检**

- `package.json` declares `dsh.bundle.patch` → `cordis.patch.yml` (and `dsh.client` for the panel). / 已声明 `dsh.bundle`。
- Repo carries the `dsh-plugin` topic. / 已加 `dsh-plugin` topic。
- No dependency on `@deepseek-ai/*`; the bundle is zero-dependency ESM and imports only Node builtins. / 零依赖，只用 Node 内置模块。
- Data stays local in `$DSH_HOME/yuquan/`; the signing private key and pond secret never leave the host (`/state` exposes the public key only). / 私钥与门禁令牌不下发到浏览器。
- Descriptions in the entry match the code: relay endpoints, five ACL gates, 256×256 crop, +10/+5 feeding, 6-digit codes all exist. / 描述里的数字与接口都能在代码里对上。
