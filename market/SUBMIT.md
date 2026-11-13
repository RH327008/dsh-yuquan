# 上架 DSH 插件市场 · 操作单

市场（`dshmarket`）的列表来自 `awesome-dsh-plugin/awesome-dsh-plugin` 仓库的 `data/plugins/*.yml`。
收录只需要**一个 YAML 文件的 PR**，不需要 npm。npm 发布是可选的（只影响市场里显示的下载量数字）。

## 现状（2026-11-14）

| 步骤 | 状态 |
| --- | --- |
| 打包 / 自检 | ✅ `node market/publish-market.mjs --check` 全过（14 文件、104 kB） |
| 收录条目 | ✅ `market/awesome-entry.yml`（就是 PR 里要加的那一个文件） |
| PR 正文 | ✅ `market/pr-body.md` |
| 简介（中/英、长/短） | ✅ `market/intro.md` |
| 截图声明 | ✅ `screenshots.json`（3 张，放在 `docs/`） |
| GitHub 仓库 | ❌ `wrh080502/dsh-yuquan` 还不存在（账号存在） |
| npm 包 | ❌ npm 未登录 |

## 两条命令（在你自己的终端里跑）

```powershell
cd C:\Users\王冉辉\Documents\deepseek-harness\default-workspace\yuquan

# 1) 建仓库 + 推送 + 加 dsh-plugin topic + fork + 提交收录 PR
$env:GH_TOKEN = "ghp_你的token"      # https://github.com/settings/tokens → classic，勾 repo
node market/publish-market.mjs --github

# 2) 可选：发 npm（只为了市场里的下载量数字）
npm login --registry https://registry.npmjs.org
node market/publish-market.mjs --npm
```

`GH_TOKEN` 只从环境变量读，脚本不写盘、不打印。`--github` 会依次：建公开仓库 →
`git init/add/commit/push` → 设 topics（`dsh-plugin` 等）→ fork 上游 →
在新分支写入 `data/plugins/wrh080502__dsh-yuquan.yml` → 开 PR。

## 不想用 token？手动三步

1. **建仓库**：<https://github.com/new> → 名字 `dsh-yuquan`、Public、不要勾 README。
2. **推代码**（本机 git 已有 GitHub 凭据）：
   ```powershell
   cd C:\Users\王冉辉\Documents\deepseek-harness\default-workspace\yuquan
   git init -b main; git add -A
   git commit -m "feat: 鱼圈 v1.4.4"
   git remote add origin https://github.com/wrh080502/dsh-yuquan.git
   git push -u origin main
   ```
   然后在仓库页 `⚙ Settings → Topics` 加 `dsh-plugin`。
3. **提 PR**：打开 <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/fork> → fork；
   在 fork 里 `Add file → Create new file`，路径填
   `data/plugins/wrh080502__dsh-yuquan.yml`，内容复制 `market/awesome-entry.yml`；
   提交后点 `Contribute → Open pull request`，正文用 `market/pr-body.md`。

## CI 会检查什么（都已在仓库里准备好）

- `package.json` 有 `dsh.bundle.patch`（不是只有 `dsh.client`）→ ✅ 已声明。
- 仓库创建满 1 天 → 建好后最快第二天再提 PR 才过；CI 会自动重算。
- 仓库带 `dsh-plugin` topic → 脚本已设置（手动作业时别忘了）。
- 一个 PR 最多 3 条；我们只加 1 条。
- 描述必须与代码一致：条目里提到的 6 位塘号、签名信封、五道门禁、256×256 裁切、+10/+5 投喂、中转站 `relay/server.mjs` 都真实存在。

## 收录之后

- 网站与 `dshmarket` 的索引会随构建刷新（条目里的 `publishTimestamp` 由构建生成，不用自己填）。
- 截图改在自己仓库的 `screenshots.json` 里，下次构建自动生效，不用再提 PR。
- npm 包发布后，市场会按 `repository` 字段自动把包和仓库关联，显示下载量。

## 直接给朋友装（不等市场）

```powershell
# 目录安装（本机开发）
dsh plugin add C:\Users\王冉辉\Documents\deepseek-harness\default-workspace\yuquan
# 或压缩包
dsh plugin add .\dsh-yuquan-1.4.4.tgz
```

在 DSH Desktop 里也可以 `插件 → 已安装 → 从本地安装`，选 `dsh-yuquan-1.4.4.tgz`。
