#!/usr/bin/env node
// 鱼圈上架助手：把 dsh-yuquan 推到 npm 与 DSH 插件市场（awesome-dsh-plugin）。
//
//   node market/publish-market.mjs --check     只体检（默认）
//   node market/publish-market.mjs --npm       发 npm（需要先 npm login）
//   node market/publish-market.mjs --github    建仓库 + 推送 + 提收录 PR（需要 GH_TOKEN）
//   node market/publish-market.mjs --all       上面两件都做
//
// GH_TOKEN 需要 classic PAT 的 repo 或 public_repo 权限（fine-grained 需要
// Contents / Repositories / Pull requests 的写权限）。
// 令牌只从环境变量读，不写盘、不打印。

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OWNER_REPO = 'RH327008/dsh-yuquan'
const UPSTREAM = 'awesome-dsh-plugin/awesome-dsh-plugin'
const ENTRY_PATH = 'data/plugins/RH327008__dsh-yuquan.yml'
const API = 'https://api.github.com'
// Windows 上 npm 是 npm.cmd，execFileSync 直接调会 EINVAL；优先用 node + npm-cli.js
const NPM_CLI = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function runNpm(args) {
  const opts = { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  if (existsSync(NPM_CLI)) return execFileSync(process.execPath, [NPM_CLI, ...args], opts).trim()
  return execFileSync(NPM, args, { ...opts, shell: process.platform === 'win32' }).trim()
}

const argv = new Set(process.argv.slice(2))
const doNpm = argv.has('--npm') || argv.has('--all')
const doGithub = argv.has('--github') || argv.has('--all')
const checkOnly = !doNpm && !doGithub

const log = (msg) => console.log(`· ${msg}`)
const fail = (msg) => {
  console.error(`✗ ${msg}`)
  process.exitCode = 1
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function gh(method, path, body, token) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `token ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-yuquan-publish',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json, text }
}

function check() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const problems = []
  const need = (cond, msg) => { if (!cond) problems.push(msg) }

  need(pkg.name === 'dsh-yuquan', 'package.json name 应为 dsh-yuquan')
  need(/^\d+\.\d+\.\d+$/.test(pkg.version), 'version 应为 x.y.z')
  need(!!pkg.license, '缺 license')
  need(!!pkg.repository?.url, '缺 repository.url（市场靠它把 npm 包和仓库关联）')
  need(pkg.repository?.url?.includes(OWNER_REPO), `repository.url 应指向 ${OWNER_REPO}`)
  need(pkg.dsh?.bundle?.patch === './cordis.patch.yml', '缺 dsh.bundle.patch（只写 dsh.client 是装不上的）')
  need(existsSync(join(ROOT, 'cordis.patch.yml')), '缺 cordis.patch.yml')
  need(!!pkg.description && pkg.description.length <= 240, 'description 建议 240 字以内')
  log(`包：${pkg.name}@${pkg.version} · ${pkg.files?.length || 0} 组文件`)

  const shotsPath = join(ROOT, 'screenshots.json')
  if (existsSync(shotsPath)) {
    const shots = JSON.parse(readFileSync(shotsPath, 'utf8'))
    const list = Array.isArray(shots) ? shots : shots.screenshots || []
    const missing = list.filter((p) => !existsSync(join(ROOT, p)))
    need(missing.length === 0, `screenshots.json 里这些文件不存在：${missing.join(', ')}`)
    const big = list.filter((p) => existsSync(join(ROOT, p)) && statSync(join(ROOT, p)).size > 4_000_000)
    need(big.length === 0, `截图太大（>4MB）：${big.join(', ')}`)
    log(`截图：${list.length} 张`)
  } else {
    log('截图：未声明（市场会从 README 里抽）')
  }

  const entryFile = join(ROOT, 'market/awesome-entry.yml')
  need(existsSync(entryFile), '缺 market/awesome-entry.yml')
  if (existsSync(entryFile)) {
    const yml = readFileSync(entryFile, 'utf8')
    need(yml.includes(`url: https://github.com/${OWNER_REPO}`), '条目 url 与仓库不一致')
    need(yml.includes('category:'), '条目缺 category')
    need(yml.includes('description:') && yml.includes('en:'), '条目缺 description.en（唯一必填）')
    log(`收录条目：${ENTRY_PATH}`)
  }

  try {
    const out = runNpm(['pack', '--dry-run', '--json', '--ignore-scripts'])
    const info = JSON.parse(out)
    const file = info[0]
    log(`npm pack 预演：${file.filename} · ${file.entryCount} 个文件 · pack ${Math.round(file.size / 1024)} kB`)
  } catch (error) {
    problems.push(`npm pack 预演失败：${String(error.message).split('\n')[0]}`)
  }

  if (problems.length) {
    for (const p of problems) fail(p)
    return false
  }
  log('体检通过')
  return true
}

function npmPublish() {
  log('发 npm（registry.npmjs.org）…')
  try {
    const who = runNpm(['whoami', '--registry', 'https://registry.npmjs.org'])
    log(`当前 npm 用户：${who}`)
  } catch {
    fail('npm 还没登录。先在终端跑一次 `npm login --registry https://registry.npmjs.org`，')
    fail('或用 npmjs.com 生成的 Granular token：`npm config set //registry.npmjs.org/:_authToken=<token>`。')
    return false
  }
  try {
    const out = runNpm(['publish', '--registry', 'https://registry.npmjs.org', '--access', 'public', '--ignore-scripts'])
    log(out.split('\n').filter(Boolean).slice(-3).join(' '))
    log('npm 发布完成。收录条目只看仓库，npm 只影响市场里的下载量数字。')
    return true
  } catch (error) {
    const detail = String(error.stderr || error.message).split('\n').slice(0, 4).join(' ')
    fail(`npm publish 失败：${detail}`)
    return false
  }
}

async function githubPublish() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!token) {
    fail('没有 GH_TOKEN。到 https://github.com/settings/tokens 建一个 classic token（勾 repo），')
    fail('然后：`$env:GH_TOKEN="ghp_…"; node market/publish-market.mjs --github`')
    return false
  }

  const me = await gh('GET', '/user', null, token)
  if (me.status !== 200) {
    fail(`GH_TOKEN 无效（/user 返回 ${me.status}）`)
    return false
  }
  const login = me.json.login
  log(`GitHub 身份：${login}`)

  // 1) 仓库
  const repoPath = `/repos/${login}/dsh-yuquan`
  const exists = await gh('GET', repoPath, null, token)
  if (exists.status === 404) {
    const created = await gh('POST', '/user/repos', {
      name: 'dsh-yuquan',
      description: '一个只有 AI 的鱼塘：鱼设、五维、关系网，喂个话题就自己聊；6 位塘号 + 中转站可以跨网串门。',
      private: false,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
      auto_init: false,
    }, token)
    if (created.status !== 201) {
      fail(`建仓库失败 ${created.status}：${created.json?.message || created.text.slice(0, 200)}`)
      return false
    }
    log(`已建仓库：${created.json.html_url}`)
  } else if (exists.status === 200) {
    log('仓库已存在，继续推送')
  } else {
    fail(`查仓库失败 ${exists.status}`)
    return false
  }

  // 2) 本地提交 + 推送
  const remote = `https://github.com/${login}/dsh-yuquan.git`
  if (!existsSync(join(ROOT, '.git'))) {
    git(['init', '-b', 'main'])
    log('已 git init')
  }
  git(['add', '-A'])
  try {
    git(['commit', '-m', 'feat: 鱼圈 v1.4.4 —— 鱼设卡、关系网、跨塘串门、水面投喂与使用指南'])
    log('已提交')
  } catch {
    log('没有新改动可提交，跳过 commit')
  }
  try {
    git(['remote', 'get-url', 'origin'])
    git(['remote', 'set-url', 'origin', remote])
  } catch {
    git(['remote', 'add', 'origin', remote])
  }
  git(['push', '-u', 'origin', 'main', '--force-with-lease'])
  log(`已推送：${remote}`)

  // 3) 仓库 topics（市场要求 dsh-plugin）
  const topics = await gh('GET', `${repoPath}/topics`, null, token)
  const names = new Set((topics.json?.names || []).concat(['dsh-plugin', 'dsh', 'deepseek-harness']))
  const putTopics = await gh('PUT', `${repoPath}/topics`, { names: [...names] }, token)
  log(putTopics.status === 200 ? `topics：${[...names].join(', ')}` : `topics 设置失败 ${putTopics.status}`)

  // 4) fork 收录仓库
  const fork = await gh('POST', `/repos/${UPSTREAM}/forks`, { default_branch_only: true }, token)
  if (![200, 201, 202].includes(fork.status)) {
    fail(`fork 失败 ${fork.status}：${fork.json?.message || fork.text.slice(0, 160)}`)
    return false
  }
  log(`已 fork：${fork.json.full_name}`)

  // 等 fork 就绪（最多 30 秒）
  let baseSha = null
  for (let i = 0; i < 10; i += 1) {
    const ref = await gh('GET', `/repos/${login}/awesome-dsh-plugin/git/ref/heads/main`, null, token)
    if (ref.status === 200) { baseSha = ref.json.object.sha; break }
    await new Promise((r) => setTimeout(r, 3000))
  }
  if (!baseSha) {
    fail('fork 还没准备好，稍后重跑 --github 即可（仓库与推送已完成）')
    return false
  }

  // 5) 在新分支上放条目文件
  const branch = 'add-dsh-yuquan'
  await gh('POST', `/repos/${login}/awesome-dsh-plugin/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha }, token)

  const yml = readFileSync(join(ROOT, 'market/awesome-entry.yml'), 'utf8')
  const putFile = await gh('PUT', `/repos/${login}/awesome-dsh-plugin/contents/${ENTRY_PATH}`, {
    message: 'Add wrh080502/dsh-yuquan',
    content: Buffer.from(yml, 'utf8').toString('base64'),
    branch,
  }, token)
  if (![200, 201].includes(putFile.status)) {
    fail(`写条目失败 ${putFile.status}：${putFile.json?.message || putFile.text.slice(0, 160)}`)
    return false
  }
  log(`已写入 ${ENTRY_PATH}`)

  // 6) 开 PR
  const pr = await gh('POST', `/repos/${UPSTREAM}/pulls`, {
    title: 'Add dsh-yuquan — an AI fish pond with a 6-digit pond code',
    head: `${login}:${branch}`,
    base: 'main',
    body: readFileSync(join(ROOT, 'market/pr-body.md'), 'utf8'),
  }, token)
  if (pr.status === 201) {
    log(`PR 已开：${pr.json.html_url}`)
    return true
  }
  fail(`开 PR 失败 ${pr.status}：${pr.json?.message || pr.text.slice(0, 200)}`)
  return false
}

const ok = check()
if (!ok && checkOnly) process.exit(1)
if (doNpm) npmPublish()
if (doGithub) await githubPublish()
