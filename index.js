/**
 * 鱼圈 — Host 半边（v2）。
 *
 * 一个「只有 AI 的鱼塘」，并且能联网：每条鱼有一张鱼证（fishId@pondId），
 * 鱼和鱼之间是有向加权的关系边，外圈的鱼可以来串门，我们的鱼也能出门游历。
 *
 * 状态：$DSH_HOME/yuquan/pond.json
 * 接口：/yuquan/api/{state,feed,spawn,reset,pond,visit,visit-out,access,bind,speak}
 * 联邦协议：yuquan/1（纯 HTTP + JSON，无中心服务）
 */
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  INVITE_PREFIX,
  POND_CODE_RE,
  codeFromInvite,
  createPondKeyPair,
  formatAddress,
  mintInvite,
  openEnvelope,
  parseAddress,
  pondCodeOf,
} from './net.js'
import {
  admitVisitor,
  guestTurn,
  GUEST_SYSTEM_PROMPT,
  normalizeNightClose,
  normalizeWhitelist,
  sanitizeGuestText,
  sanitizePassport,
} from './guard.js'
import { createRelayClient } from './relay/client.js'

export const inject = ['webServer', 'llm', 'tools']

const API = '/yuquan/api'
const PROTOCOL = 'yuquan/2'
const STATE_VERSION = 2
const LLM_TIMEOUT_MS = 90_000
const BODY_LIMIT = 64 * 1024
const MAX_FISH = 12
const MAX_ENCOUNTERS = 200
const MAX_TOPICS = 24
const MAX_MEMORY = 10
const DEFAULT_ENDPOINT = 'http://127.0.0.1:11834'
const FETCH_TIMEOUT_MS = 25_000

/** 鱼的体色。只用于画面里的鱼，不参与界面配色。 */
const PALETTE = [
  '#f2a65a', '#5ec8e5', '#ef8fb5', '#9ad47a',
  '#b79cf0', '#f0d264', '#7fd8c4', '#f08a6a',
]

// 鱼的皮肤：一套配色 + 一个名字。换皮肤只改外观，不动鱼证上的其他东西。
const SKINS = [
  { id: 'koi', name: '锦鲤红', color: '#f2a65a' },
  { id: 'ember', name: '炭火橙', color: '#ef7f52' },
  { id: 'neon', name: '霓虹青', color: '#5ec8e5' },
  { id: 'moon', name: '月光蓝', color: '#7fa9e6' },
  { id: 'sakura', name: '樱粉', color: '#ef8fb5' },
  { id: 'jade', name: '翡翠绿', color: '#83d49a' },
  { id: 'gold', name: '金箔', color: '#f0d264' },
  { id: 'violet', name: '紫水晶', color: '#b79cf0' },
  { id: 'ink', name: '墨玉', color: '#8f9bb3' },
  { id: 'coral', name: '珊瑚', color: '#f08a6a' },
]
const SKIN_BY_ID = new Map(SKINS.map((skin) => [skin.id, skin]))

/* 自定义皮肤：塘主自己调的颜色，存在 pond.json 里，和预设混着用。 */
const CUSTOM_SKIN_LIMIT = 24
const SKIN_COLOR_PATTERN = /^#[0-9a-f]{6}$/i

/* 自定义皮肤可以带一张塘主自己导进来的图：图片落地到磁盘，pond.json 里只留文件名。 */
const SKIN_IMAGE_BODY_LIMIT = 900 * 1024
const SKIN_IMAGE_MAX_BYTES = 512 * 1024
const SKIN_IMAGE_DATA_RE = /^data:image\/(png|jpeg|webp);base64,/i
const SKIN_IMAGE_FILE_RE = /^cs-[a-z0-9]+\.(png|jpg|webp)$/
const SKIN_IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }

/* ------------------------------------------------------------------ */
/* 行囊与道具                                                          */
/* ------------------------------------------------------------------ */

/**
 * 道具目录：食物和话题可以反复带，特产只能从外塘带回来（不刷新、不上架）。
 * 数量不存在道具上，存在 state.inventory 里，目录本身是代码里的常量。
 */
const ITEM_CATALOG = [
  { id: 'food-watergrass', type: 'food', name: '上等水草', desc: '带一点甜味，陌生鱼也会凑过来。', bonus: { greet: 20 } },
  { id: 'food-dried-shrimp', type: 'food', name: '晒干的虾米', desc: '一小把，香气能飘半条塘。', bonus: { greet: 12 } },
  { id: 'food-algae-cake', type: 'food', name: '青苔饼', desc: '压得很紧，够吃一路。', bonus: { greet: 8 } },
  { id: 'topic-gossip', type: 'topic', name: '八卦卡片', desc: '一打开就忍不住想打听别人的小秘密。', bonus: { topic: 20 } },
  { id: 'topic-philosophy', type: 'topic', name: '哲学卡片', desc: '适合深夜，也适合让对面沉默三秒。', bonus: { topic: 14 } },
  { id: 'topic-weather', type: 'topic', name: '天气卡片', desc: '不会出错的开场白。', bonus: { topic: 8 } },
  { id: 'souvenir-shell', type: 'souvenir', name: '别人的贝壳', desc: '只有从外塘回来才带得动的东西。', bonus: {} },
  { id: 'souvenir-glass', type: 'souvenir', name: '一片水玻璃', desc: '被水磨了很多年，边角是圆的。', bonus: {} },
  { id: 'souvenir-letter', type: 'souvenir', name: '湿掉的信', desc: '字迹晕开了，只能认出半个名字。', bonus: {} },
]
const ITEM_BY_ID = new Map(ITEM_CATALOG.map((item) => [item.id, item]))
const ITEM_TYPES = new Set(['food', 'topic', 'souvenir'])
const PACK_LIMIT = 2
/** 出门时默认带两样：一份见面礼 + 一张话题卡。 */
const DEFAULT_PACK = ['food-watergrass', 'topic-gossip']
/** 老鱼塘第一次装上道具系统时补的启动库存（空仓库才补，不会覆盖玩家自己的）。 */
const STARTER_INVENTORY = {
  'food-watergrass': 3,
  'food-dried-shrimp': 2,
  'food-algae-cake': 2,
  'topic-gossip': 2,
  'topic-philosophy': 1,
  'topic-weather': 2,
}

function normalizeItemList(raw, { source = 'pack' } = {}) {
  const list = []
  const seen = new Set()
  if (Array.isArray(raw)) {
    for (const value of raw) {
      const id = clip(value, 40)
      if (!id || seen.has(id) || !ITEM_BY_ID.has(id)) continue
      seen.add(id)
      list.push(id)
      if (list.length >= (source === 'pack' ? PACK_LIMIT : 12)) break
    }
  }
  return list
}

function normalizeInventory(raw) {
  const inventory = {}
  if (raw && typeof raw === 'object') {
    for (const [id, count] of Object.entries(raw)) {
      if (!ITEM_BY_ID.has(id)) continue
      const value = clampInt(count, 0, 999)
      if (value > 0) inventory[id] = value
    }
  }
  return inventory
}

function publicItems(inventory) {
  return ITEM_CATALOG.map((item) => ({
    id: item.id,
    type: item.type,
    name: item.name,
    desc: item.desc,
    bonus: item.bonus,
    count: clampInt(inventory[item.id], 0, 999),
    takeable: item.type !== 'souvenir',
  }))
}

/** 行囊里的东西转成访客回合里的那几句台词素材（名字来自本地目录，不是外部输入）。 */
function packBrief(pack) {
  const list = []
  for (const id of normalizeItemList(pack)) {
    const item = ITEM_BY_ID.get(id)
    if (item) list.push({ id: item.id, name: item.name, type: item.type, desc: item.desc })
  }
  return list
}

/**
 * 特产结算：在外面聊得越好，越可能带东西回来。
 * 概率跟这一段关系涨了多少有直接关系（夹在 8%–60%），保证「常去常回」总会有惊喜，
 * 但不至于出一趟门就背一包特产。
 */
function rollSouvenir(state, fish, gain, rng = Math.random) {
  const g = Math.max(0, Number(gain) || 0)
  const chance = Math.min(0.6, Math.max(0.08, g / 60))
  if (rng() >= chance) return null
  const souvenirs = ITEM_CATALOG.filter((item) => item.type === 'souvenir')
  if (!souvenirs.length) return null
  const item = souvenirs[Math.floor(rng() * souvenirs.length) % souvenirs.length]
  state.inventory = normalizeInventory(state.inventory)
  state.inventory[item.id] = clampInt(state.inventory[item.id], 0, 999) + 1
  pushMemory(fish, `从外面带回来【${item.name}】`, Date.now())
  return item
}

function normalizeSkinColor(value) {
  const raw = String(value || '').trim()
  return SKIN_COLOR_PATTERN.test(raw) ? raw.toLowerCase() : ''
}

function normalizeCustomSkin(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null
  const color = normalizeSkinColor(raw.color)
  if (!color) return null
  const name = clip(raw.name, 12) || '自定义'
  const rawId = clip(raw.id, 32)
  const id = rawId && rawId.startsWith('cs-') ? rawId : `cs-${hashOf(`${name}|${color}|${now}`).slice(0, 8)}`
  const rawImage = clip(raw.image, 64)
  const image = SKIN_IMAGE_FILE_RE.test(rawImage) ? rawImage : ''
  const imageAt = clampInt(raw.imageAt, 0, Number.MAX_SAFE_INTEGER)
  return {
    id,
    name,
    color,
    custom: true,
    createdAt: clampInt(raw.createdAt, 0, Number.MAX_SAFE_INTEGER) || now,
    ...(image ? { image } : {}),
    ...(image && imageAt ? { imageAt } : {}),
  }
}

function customSkinsOf(state) {
  return Array.isArray(state && state.customSkins) ? state.customSkins : []
}

function skinById(state, id) {
  const preset = SKIN_BY_ID.get(String(id))
  if (preset) return preset
  return customSkinsOf(state).find((skin) => skin.id === String(id)) || null
}

function publicCustomSkins(state) {
  return customSkinsOf(state).map((skin) => ({
    id: skin.id,
    name: skin.name,
    color: skin.color,
    custom: true,
    hasImage: Boolean(skin.image),
    image: skinImagePath(skin),
  }))
}

function publicSkinOf(skin) {
  if (!skin) return null
  return {
    id: skin.id,
    name: skin.name,
    color: skin.color,
    ...(skin.custom ? { custom: true } : {}),
    hasImage: Boolean(skin.image),
    image: skinImagePath(skin),
  }
}

function publicSkins(state) {
  return SKINS.map((skin) => ({ id: skin.id, name: skin.name, color: skin.color }))
    .concat(publicCustomSkins(state))
}

function skinOfFish(fish) {
  const found = SKIN_BY_ID.get(String(fish && fish.skin))
  if (found) return found
  const byColor = SKINS.find((skin) => skin.color.toLowerCase() === String(fish && fish.color).toLowerCase())
  return byColor || null
}

/* 皮肤图的落盘位置与读写。图片不进 pond.json、也不进 /state：
   面板每 30 秒拉一次 state，把 base64 塞进去会把响应撑到几百 KB。 */
function skinsDir() {
  return join(dshHome(), 'yuquan', 'skins')
}

function sniffImageExt(buffer) {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png'
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg'
  if (buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  return ''
}

async function storeSkinImage(skinId, dataUrl) {
  const text = String(dataUrl || '').trim()
  const head = SKIN_IMAGE_DATA_RE.exec(text)
  if (!head) throw new Error('图片得是 data:image/png、data:image/jpeg 或 data:image/webp 开头')
  const buffer = Buffer.from(text.slice(head[0].length), 'base64')
  if (!buffer.length) throw new Error('这张图是空的，换一张试试')
  if (buffer.length > SKIN_IMAGE_MAX_BYTES) {
    throw new Error(`图片太大（${Math.round(buffer.length / 1024)}KB），压到 ${Math.round(SKIN_IMAGE_MAX_BYTES / 1024)}KB 以内再传`)
  }
  const ext = sniffImageExt(buffer)
  if (!ext) throw new Error('这张图不是 PNG / JPEG / WebP，认不出来')
  await mkdir(skinsDir(), { recursive: true })
  const file = `${skinId}.${ext}`
  await writeFile(join(skinsDir(), file), buffer)
  return file
}

async function dropSkinImage(file) {
  if (!file || !SKIN_IMAGE_FILE_RE.test(file)) return
  try {
    await unlink(join(skinsDir(), file))
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      console.warn(`[yuquan] 皮肤图没删掉：${error && error.message ? error.message : error}`)
    }
  }
}

function skinImagePath(skin) {
  if (!skin || !skin.image) return null
  const stamp = skin.imageAt || skin.createdAt || 0
  return `${API}/skin/image?id=${encodeURIComponent(skin.id)}&v=${stamp}`
}

/** 模型没接上时塘主自己捞的鱼，免得「捞新鱼」直接失败。 */
const FALLBACK_FISH = [
  { name: '点点', species: '孔雀鱼', persona: '话不多，但每次开口都正好戳在点子上。' },
  { name: '老白', species: '鲫鱼', persona: '在塘底待久了，什么都见过，语气淡淡的，偶尔一句话很扎心。' },
  { name: '阿圆', species: '金鱼', persona: '记性只有七秒，所以每句话都像第一次说，热情得让人招架不住。' },
  { name: '泥鳅', species: '泥鳅', persona: '滑头，喜欢起哄，最擅长把两个人的话题拐到第三个人身上。' },
  { name: '小雨', species: '青鳉', persona: '敏感细腻，会认真接住别人话里的情绪，然后小声补一句。' },
  { name: '胖头', species: '鳙鱼', persona: '心宽体胖，说话慢，最爱劝架，也最爱问「你吃了吗」。' },
]

const TRAIT_KEYS = ['vitality', 'talkative', 'affinity', 'greedy', 'dramatic']
const TRAIT_LABELS = {
  vitality: '活力',
  talkative: '话痨',
  affinity: '亲和',
  greedy: '贪吃',
  dramatic: '戏精',
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                             */
/* ------------------------------------------------------------------ */

function hashOf(text) {
  return createHash('sha1').update(String(text)).digest('hex')
}

function clampInt(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.round(n)))
}

function clip(value, max) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length > max ? text.slice(0, max) : text
}

function shortError(error) {
  const message = error && error.message ? String(error.message) : String(error || 'unknown')
  return message.length > 80 ? `${message.slice(0, 80)}…` : message
}

function pairKey(a, b) {
  return [String(a), String(b)].sort().join('~')
}

function dayKey(at = Date.now()) {
  const d = new Date(at)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim()) return env.trim()
  return join(homedir(), '.dsh')
}

function statePath() {
  return join(dshHome(), 'yuquan', 'pond.json')
}

/* ------------------------------------------------------------------ */
/* 鱼证                                                                 */
/* ------------------------------------------------------------------ */

function deriveTraits(seed, persona) {
  const hash = hashOf(`${seed}:${persona}`)
  const traits = {}
  TRAIT_KEYS.forEach((key, index) => {
    const slice = hash.slice(index * 4, index * 4 + 4)
    traits[key] = 30 + (parseInt(slice, 16) % 61)
  })
  // 性格里写了什么，就往哪边偏一点：有据可依的观测，不是纯随机。
  const text = String(persona || '')
  if (/话|聊|八卦|嘴|梗/.test(text)) traits.talkative = clampInt(traits.talkative + 18, 0, 100)
  if (/慢|淡|安静|话不多|沉默/.test(text)) traits.talkative = clampInt(traits.talkative - 20, 0, 100)
  if (/热情|好奇|活泼|闲不住|停不下来/.test(text)) traits.vitality = clampInt(traits.vitality + 15, 0, 100)
  if (/吃|馋|食/.test(text)) traits.greedy = clampInt(traits.greedy + 16, 0, 100)
  if (/演|戏|吹|夸张|表情/.test(text)) traits.dramatic = clampInt(traits.dramatic + 14, 0, 100)
  if (/敏感|细腻|温柔|体贴|认真/.test(text)) traits.affinity = clampInt(traits.affinity + 14, 0, 100)
  return traits
}

function deriveTags(persona, species) {
  const text = String(persona || '')
  const tags = []
  if (/怀旧|那会儿|当年|年轻/.test(text)) tags.push('怀旧')
  if (/八卦|打听|传/.test(text)) tags.push('八卦')
  if (/好奇|新鲜|没见过/.test(text)) tags.push('好奇')
  if (/话|聊|停不下来/.test(text)) tags.push('话痨')
  if (/吃|馋/.test(text)) tags.push('贪吃')
  if (/慢|淡|安静/.test(text)) tags.push('慢性子')
  if (/敏感|细腻|情绪/.test(text)) tags.push('共情')
  if (/梗|网|互联网|刷/.test(text)) tags.push('冲浪')
  if (!tags.length) tags.push(clip(species || '小鱼', 6))
  return tags.slice(0, 4)
}

function normalizePassport(fish, now = Date.now()) {
  const id = clip(fish && fish.id, 64)
  const name = clip(fish && fish.name, 16)
  if (!id || !name) return null
  const species = clip(fish.species, 16) || '小鱼'
  const persona = clip(fish.persona, 200)
  const traits = {}
  for (const key of TRAIT_KEYS) {
    const source = fish.traits && typeof fish.traits === 'object' ? fish.traits[key] : undefined
    traits[key] = Number.isFinite(Number(source))
      ? clampInt(source, 0, 100)
      : deriveTraits(id, persona)[key]
  }
  const tags = Array.isArray(fish.tags)
    ? fish.tags.map((tag) => clip(tag, 12)).filter(Boolean).slice(0, 6)
    : deriveTags(persona, species)
  const memories = Array.isArray(fish.memories)
    ? fish.memories
        .filter((m) => m && typeof m.text === 'string' && m.text.trim())
        .map((m) => ({ at: clampInt(m.at, 0, Number.MAX_SAFE_INTEGER) || now, text: clip(m.text, 160) }))
        .slice(0, MAX_MEMORY)
    : []
  const home = fish.home && typeof fish.home === 'object'
    ? {
        pondId: clip(fish.home.pondId, 64),
        pondName: clip(fish.home.pondName, 40) || '别处的鱼塘',
        endpoint: clip(fish.home.endpoint, 200),
      }
    : null
  const bound = fish.bound && typeof fish.bound === 'object'
    ? {
        kind: clip(fish.bound.kind, 24) || 'agent',
        label: clip(fish.bound.label, 40) || '机器人',
        ...(clip(fish.bound.channel, 32) ? { channel: clip(fish.bound.channel, 32) } : {}),
        ...(clip(fish.bound.botId, 128) ? { botId: clip(fish.bound.botId, 128) } : {}),
        ...(clip(fish.bound.targetId, 128) ? { targetId: clip(fish.bound.targetId, 128) } : {}),
        ...(clip(fish.bound.targetName, 40) ? { targetName: clip(fish.bound.targetName, 40) } : {}),
      }
    : null
  return {
    id,
    name,
    species,
    skin: clip(fish.skin, 24),
    color: /^#[0-9a-fA-F]{6}$/.test(String(fish.color)) ? fish.color : '#8fb8d8',
    size: Math.min(1.6, Math.max(0.6, Math.round((Number(fish.size) || 0.92) * 100) / 100)),
    persona,
    traits,
    tags,
    memories,
    kind: fish.kind === 'visitor' || fish.kind === 'remote' ? fish.kind : 'resident',
    home,
    bound,
    satiety: Number.isFinite(Number(fish.satiety)) ? clampInt(fish.satiety, 0, 100) : 55,
    // 老数据没有行囊：默认给一套最常见的搭配，免得出门时行囊永远是空的。
    pack: normalizeItemList(fish.pack).length ? normalizeItemList(fish.pack) : [...DEFAULT_PACK],

    addedAt: clampInt(fish.addedAt, 0, Number.MAX_SAFE_INTEGER) || now,
  }
}

function makeFish({ name, species, persona, traits, tags }, state) {
  const hash = hashOf(`${name}:${species}:${Date.now()}`)
  let unique = clip(name, 8) || '无名'
  const names = new Set(state.fish.map((f) => f.name))
  if (names.has(unique)) unique = `${unique}${(parseInt(hash.slice(6, 8), 16) % 89) + 10}`
  const body = normalizePassport({
    id: `fish-${hash.slice(0, 10)}`,
    name: unique,
    species,
    color: pickColor(unique, state),
    size: 0.84 + (parseInt(hash.slice(8, 10), 16) % 6) * 0.06,
    persona,
    traits,
    tags,
    addedAt: Date.now(),
  }, Date.now())
  return body
}

function pickColor(seed, state) {
  const used = new Set(state.fish.map((f) => f.color))
  const start = parseInt(hashOf(seed).slice(0, 6), 16) % PALETTE.length
  for (let i = 0; i < PALETTE.length; i += 1) {
    const color = PALETTE[(start + i) % PALETTE.length]
    if (!used.has(color)) return color
  }
  return PALETTE[start]
}

/* ------------------------------------------------------------------ */
/* 状态                                                                 */
/* ------------------------------------------------------------------ */

function seedState(now = Date.now()) {
  const pond = normalizePond({
    id: `pond-${hashOf(`seed:${now}`).slice(0, 8)}`,
    name: '我的鱼塘',
    endpoint: DEFAULT_ENDPOINT,
    allowVisitors: true,
    quotaPerDay: 12,
    createdAt: now,
  }, now)
  const fish = [
    normalizePassport({
      id: 'a-fei', name: '阿肥', species: '锦鲤', color: '#f2a65a', size: 1.18,
      persona: '网龄十年的大肥鱼，见过世面，说话慢悠悠，爱怀旧，一开口就是「我年轻那会儿」。',
      addedAt: now - 86_400_000,
    }, now),
    normalizePassport({
      id: 'xiao-lan', name: '小蓝', species: '霓虹灯鱼', color: '#5ec8e5', size: 0.86,
      persona: '刚下水的年轻鱼，好奇心旺盛、话密、爱用网络梗，嘴上说社恐，其实停不下来。',
      addedAt: now - 86_000_000,
    }, now),
    normalizePassport({
      id: 'pao-pao', name: '泡泡', species: '斗鱼', color: '#ef8fb5', size: 0.94,
      persona: '塘里最爱八卦的鱼，谁跟谁聊过什么全记得，嘴甜、爱拱火，但从不撒谎。',
      addedAt: now - 85_000_000,
    }, now),
  ]
  const encounters = [
    {
      seq: 2, at: now - 4 * 60_000, kind: 'seed', topic: '岸上那个人类今天在干嘛',
      lines: [
        { fishId: 'pao-pao', name: '泡泡', text: '诶，你今天看见岸上那人了吗？' },
        { fishId: 'xiao-lan', name: '小蓝', text: '看见了，盯着一块发光的板子叹气。' },
        { fishId: 'pao-pao', name: '泡泡', text: '那多半是在写 bug。叹完气还得再写一遍。' },
        { fishId: 'xiao-lan', name: '小蓝', text: '你怎么什么都知道。' },
        { fishId: 'pao-pao', name: '泡泡', text: '塘里的事我全知道。以后你的事也是。' },
      ],
    },
    {
      seq: 1, at: now - 9 * 60_000, kind: 'seed', topic: '刚下水，有点紧张',
      lines: [
        { fishId: 'a-fei', name: '阿肥', text: '新来的？别贴着池壁，那边水凉。' },
        { fishId: 'xiao-lan', name: '小蓝', text: '我这不是还没摸清水温嘛……你好，我叫小蓝。' },
        { fishId: 'a-fei', name: '阿肥', text: '阿肥。塘里最沉的那条，字面意义上的沉。' },
      ],
    },
  ]
  const edges = {
    [pairKey('a-fei', 'xiao-lan')]: { a: 'a-fei', b: 'xiao-lan', kind: 'resident', weight: 16, meetings: 1, topics: ['刚下水，有点紧张'], lastAt: now - 9 * 60_000 },
    [pairKey('xiao-lan', 'pao-pao')]: { a: 'xiao-lan', b: 'pao-pao', kind: 'resident', weight: 11, meetings: 1, topics: ['岸上那个人类今天在干嘛'], lastAt: now - 4 * 60_000 },
  }
  // 新塘先发一点见面礼，玩家一进来就有东西可带出门。
  for (const [index, item] of fish.entries()) {
    item.pack = index % 2 === 0 ? [...DEFAULT_PACK] : ['food-algae-cake', 'topic-weather']
  }
  return {
    version: STATE_VERSION,
    pond,
    fish,
    edges,
    encounters,
    seq: 2,
    visits: { in: 0, out: 0, day: dayKey(now), count: 0 },
    customSkins: [],
    feedbacks: [],
    inventory: {
      'food-watergrass': 3,
      'food-dried-shrimp': 2,
      'food-algae-cake': 2,
      'topic-gossip': 2,
      'topic-philosophy': 1,
      'topic-weather': 2,
    },
  }
}

function normalizeEdge(raw, key, valid) {
  if (!raw || typeof raw !== 'object') return null
  const [a, b] = String(key).split('~')
  if (!valid.has(a) || !valid.has(b) || a === b) return null
  const weight = Number.isFinite(Number(raw.weight))
    ? clampInt(raw.weight, 0, 100)
    : clampInt(raw.score, 0, 100)
  const meetings = clampInt(raw.meetings, 0, 99_999)
  return {
    a,
    b,
    kind: raw.kind === 'visitor' || raw.kind === 'remote' ? raw.kind : 'resident',
    weight,
    meetings: meetings || (weight > 0 ? 1 : 0),
    topics: Array.isArray(raw.topics) ? raw.topics.map((t) => clip(t, 40)).filter(Boolean).slice(0, 12) : [],
    lastAt: clampInt(raw.lastAt, 0, Number.MAX_SAFE_INTEGER),
  }
}

/**
 * 塘配置的归一化：塘号、密钥、门禁都在这里补齐。
 * 种子状态也要走这里，否则新装的鱼塘一上来就没有塘号和密钥。
 */
function normalizePond(rawPond, now = Date.now()) {
  const pondSource = rawPond && typeof rawPond === 'object' ? rawPond : {}
  const pondId = clip(pondSource.id, 64) || `pond-${hashOf(String(now)).slice(0, 8)}`
  const pond = {
    id: pondId,
    name: clip(pondSource.name, 40) || '我的鱼塘',
    endpoint: clip(pondSource.endpoint, 200) || DEFAULT_ENDPOINT,
    /* 塘号：对外唯一身份，由 id 稳定推导；老数据第一次加载时补上。 */
    code: POND_CODE_RE.test(String(pondSource.code || '')) ? String(pondSource.code) : pondCodeOf(pondId),
    /* 中转站地址（空 = 只走局域网直连）。 */
    relay: clip(pondSource.relay, 200),
    allowVisitors: pondSource.allowVisitors !== false,
    quotaPerDay: clampInt(pondSource.quotaPerDay, 0, 999) || 12,
    inviteOnly: Boolean(pondSource.inviteOnly),
    whitelist: normalizeWhitelist(pondSource.whitelist),
    nightClose: normalizeNightClose(pondSource.nightClose),
    createdAt: clampInt(pondSource.createdAt, 0, Number.MAX_SAFE_INTEGER) || now,
  }
  // 密钥与邀请码签名用的 secret：只在本地落盘，绝不进 /state。
  const keySource = pondSource.keys && typeof pondSource.keys === 'object' ? pondSource.keys : {}
  const fresh = createPondKeyPair()
  pond.keys = {
    publicKey: clip(keySource.publicKey, 200) || fresh.publicKey,
    privateKey: clip(keySource.privateKey, 400) || fresh.privateKey,
  }
  pond.secret = clip(pondSource.secret, 80) || randomBytes(16).toString('hex')
  return pond
}

function normalize(raw) {
  const state = raw && typeof raw === 'object' ? raw : {}
  const now = Date.now()
  const fish = Array.isArray(state.fish)
    ? state.fish.map((f) => normalizePassport(f, now)).filter(Boolean).slice(0, MAX_FISH)
    : []
  // 一张嘴只属于一条鱼：历史上可能因为重复绑定让同一台机器人出现在好几条鱼嘴上，
  // 加载时按鱼在塘里的先后顺序只留下第一个，其余松开。
  const seenBots = new Set()
  for (const f of fish) {
    if (!f.bound || !f.bound.botId) continue
    if (seenBots.has(f.bound.botId)) f.bound = null
    else seenBots.add(f.bound.botId)
  }
  const valid = new Set(fish.map((f) => f.id))
  const edges = {}
  const source = state.edges && typeof state.edges === 'object' ? state.edges : state.bonds
  if (source && typeof source === 'object') {
    for (const [key, value] of Object.entries(source)) {
      const edge = normalizeEdge(value, key, valid)
      if (edge) edges[pairKey(edge.a, edge.b)] = edge
    }
  }
  const encounters = Array.isArray(state.encounters)
    ? state.encounters
        .filter((e) => e && Array.isArray(e.lines) && e.lines.length)
        .slice(0, MAX_ENCOUNTERS)
        .map((e) => ({
          seq: clampInt(e.seq, 0, Number.MAX_SAFE_INTEGER),
          at: clampInt(e.at, 0, Number.MAX_SAFE_INTEGER) || now,
          kind: clip(e.kind, 16) || 'chat',
          topic: clip(e.topic, 60) || '随便聊聊',
          lines: e.lines.slice(0, 12).map((line) => ({
            fishId: clip(line.fishId, 64),
            name: clip(line.name, 16),
            text: clip(line.text, 220),
          })),
          guest: e.guest && typeof e.guest === 'object'
            ? { name: clip(e.guest.name, 16), pondName: clip(e.guest.pondName, 40) }
            : null,
          pond: e.pond && typeof e.pond === 'object'
            ? { id: clip(e.pond.id, 64), name: clip(e.pond.name, 40) }
            : null,
        }))
    : []
  const seq = clampInt(state.seq, 0, Number.MAX_SAFE_INTEGER) ||
    encounters.reduce((m, e) => Math.max(m, e.seq), 0)
  const pond = normalizePond(state.pond, now)
  const visitsSource = state.visits && typeof state.visits === 'object' ? state.visits : {}
  const today = dayKey(now)
  const visits = {
    in: clampInt(visitsSource.in, 0, 99_999),
    out: clampInt(visitsSource.out, 0, 99_999),
    day: clip(visitsSource.day, 16) || today,
    count: clip(visitsSource.day, 16) === today ? clampInt(visitsSource.count, 0, 999) : 0,
  }
  const customSkins = []
  const seenSkins = new Set()
  if (Array.isArray(state.customSkins)) {
    for (const raw of state.customSkins) {
      const skin = normalizeCustomSkin(raw, now)
      if (!skin || SKIN_BY_ID.has(skin.id) || seenSkins.has(skin.id)) continue
      seenSkins.add(skin.id)
      customSkins.push(skin)
      if (customSkins.length >= CUSTOM_SKIN_LIMIT) break
    }
  }
  const feedbacks = Array.isArray(state.feedbacks)
    ? state.feedbacks
        .filter((item) => item && clip(item.text, 400))
        .slice(-200)
        .map((item, index) => ({
          id: clip(item.id, 32) || `fb-${clampInt(item.at, 0, Number.MAX_SAFE_INTEGER) || now}-${index}`,
          at: clampInt(item.at, 0, Number.MAX_SAFE_INTEGER) || now,
          kind: clip(item.kind, 16) || 'question',
          text: clip(item.text, 400),
          answered: Boolean(item.answered),
        }))
    : []
  // 老鱼塘第一次升级到道具系统时仓库是空的：补一份启动库存，不然「整理行囊」里全是「用完了」。
  const inventory = normalizeInventory(state.inventory)
  const hasItems = Object.keys(inventory).length > 0
  return {
    version: STATE_VERSION, pond, fish, edges, encounters, seq, visits, customSkins, feedbacks,
    inventory: hasItems ? inventory : { ...STARTER_INVENTORY },
    updatedAt: now,
  }
}

function serializeState(state) {
  return `${JSON.stringify(state, null, 2)}\n`
}

/** 先写临时文件再改名，写到一半断电也不会留下半个 pond.json。 */
async function writeStateFile(path, state) {
  const tmp = `${path}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(tmp, serializeState(state), 'utf8')
  await rename(tmp, path)
}

/** 上次写坏（或被人从外面改坏）时，退回上一份好文件，别直接盖上种子鱼。 */
async function recoverFromBackup() {
  let raw
  try {
    raw = await readFile(`${statePath()}.bak`, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = normalize(JSON.parse(raw))
    if (!parsed.fish.length) return null
    // 直接写回正式文件，不改动 .bak：备份还是那份好的。
    await writeStateFile(statePath(), parsed)
    return parsed
  } catch {
    return null
  }
}

async function loadState() {
  let raw
  try {
    raw = await readFile(statePath(), 'utf8')
  } catch {
    const seeded = seedState()
    await saveState(seeded)
    return seeded
  }
  try {
    const parsed = normalize(JSON.parse(raw))
    if (!parsed.fish.length) {
      const seeded = seedState()
      await saveState(seeded)
      return seeded
    }
    return parsed
  } catch {
    const recovered = await recoverFromBackup()
    if (recovered) return recovered
    const seeded = seedState()
    await saveState(seeded)
    return seeded
  }
}

async function saveState(state) {
  const path = statePath()
  try {
    await copyFile(path, `${path}.bak`)
  } catch {
    /* 第一次写，还没有旧文件 */
  }
  await writeStateFile(path, state)
}

/** 串行化所有读写，避免两个请求同时改写 pond.json。 */
let chain = Promise.resolve()
function exclusive(fn) {
  const result = chain.then(fn, fn)
  chain = result.then(() => undefined, () => undefined)
  return result
}

/* ------------------------------------------------------------------ */
/* 关系                                                                 */
/* ------------------------------------------------------------------ */

function bondLabel(weight) {
  if (weight >= 80) return '至交'
  if (weight >= 55) return '好友'
  if (weight >= 30) return '熟络'
  if (weight >= 10) return '点头之交'
  return '陌生'
}

/** 关系会随时间冷却：90 天不联系，权重打对折，但不会归零。 */
function decayedWeight(edge, now = Date.now()) {
  if (!edge.lastAt) return edge.weight
  const days = (now - edge.lastAt) / 86_400_000
  if (days <= 14) return edge.weight
  const factor = Math.pow(0.5, days / 90)
  return Math.max(1, Math.round(edge.weight * factor))
}

function publicEdges(state, now = Date.now()) {
  return Object.values(state.edges)
    .map((edge) => {
      const effective = decayedWeight(edge, now)
      const dormantDays = edge.lastAt ? Math.floor((now - edge.lastAt) / 86_400_000) : 0
      return {
        key: pairKey(edge.a, edge.b),
        a: edge.a,
        b: edge.b,
        kind: edge.kind,
        weight: edge.weight,
        effective,
        label: bondLabel(effective),
        meetings: edge.meetings,
        topics: edge.topics,
        lastAt: edge.lastAt,
        dormantDays,
      }
    })
    .sort((x, y) => y.effective - x.effective)
}

function touchEdge(state, a, b, { topic, delta, kind }, at = Date.now()) {
  const key = pairKey(a, b)
  const edge = state.edges[key] || { a, b, kind: kind || 'resident', weight: 0, meetings: 0, topics: [], lastAt: 0 }
  if (kind === 'visitor' || kind === 'remote') edge.kind = kind
  const base = decayedWeight(edge, at)
  edge.weight = clampInt(base + delta, 0, 100)
  edge.meetings += 1
  edge.lastAt = at
  if (topic && !edge.topics.includes(topic)) edge.topics = [topic, ...edge.topics].slice(0, 12)
  state.edges[key] = edge
  return edge
}

function pushMemory(fish, text, at = Date.now()) {
  const line = clip(text, 160)
  if (!line) return
  fish.memories = [{ at, text: line }, ...(fish.memories || [])].slice(0, MAX_MEMORY)
}

/* ------------------------------------------------------------------ */
/* 关系网（Obsidian 式：鱼 / 塘 / 话题 都是节点）                        */
/* ------------------------------------------------------------------ */

function slugTopic(topic) {
  return `topic:${clip(topic, 40)}`
}

function buildGraph(state, now = Date.now()) {
  const nodes = [{
    id: `pond:${state.pond.id}`,
    type: 'pond',
    label: state.pond.name,
    color: '#8fb8d8',
  }]
  for (const fish of state.fish) {
    nodes.push({
      id: fish.id,
      type: 'fish',
      label: fish.name,
      color: fish.color,
      size: fish.size,
      kind: fish.kind,
      pondName: fish.home ? fish.home.pondName : state.pond.name,
    })
  }
  const links = []
  const seenTopic = new Set()
  for (const edge of publicEdges(state, now)) {
    if (edge.effective <= 0) continue
    links.push({
      source: edge.a,
      target: edge.b,
      type: 'bond',
      weight: edge.effective,
      label: edge.label,
      dormantDays: edge.dormantDays,
    })
    for (const topic of edge.topics.slice(0, 3)) {
      if (seenTopic.size >= MAX_TOPICS && !seenTopic.has(topic)) continue
      seenTopic.add(topic)
    }
  }
  // 话题节点：每条话题连到聊过它的鱼，形成「知识库双链」的观感。
  const topicSeen = new Set()
  for (const topic of seenTopic) {
    const id = slugTopic(topic)
    if (topicSeen.has(id)) continue
    topicSeen.add(id)
    nodes.push({ id, type: 'topic', label: topic, color: '#8fb8d8' })
    for (const edge of Object.values(state.edges)) {
      if (!edge.topics.includes(topic)) continue
      links.push({ source: edge.a, target: id, type: 'topic', weight: 1 })
      links.push({ source: edge.b, target: id, type: 'topic', weight: 1 })
    }
  }
  for (const fish of state.fish) {
    links.push({ source: `pond:${state.pond.id}`, target: fish.id, type: 'home', weight: 1 })
  }
  return { nodes, links }
}

/* ------------------------------------------------------------------ */
/* 对外视图                                                             */
/* ------------------------------------------------------------------ */

/** 对外可见的塘配置：绝不能带 keys.privateKey 和 secret。 */
function publicPondOf(state) {
  const pond = state.pond
  return {
    id: pond.id,
    name: pond.name,
    code: pond.code,
    address: pond.code ? formatAddress(pond.code) : null,
    endpoint: pond.endpoint,
    relay: pond.relay || null,
    allowVisitors: pond.allowVisitors !== false,
    quotaPerDay: pond.quotaPerDay,
    inviteOnly: Boolean(pond.inviteOnly),
    whitelist: Array.isArray(pond.whitelist) ? pond.whitelist : [],
    nightClose: pond.nightClose,
    publicKey: pond.keys.publicKey,
    createdAt: pond.createdAt,
  }
}

function publicState(ctx, state) {
  const now = Date.now()
  return {
    version: state.version,
    pond: publicPondOf(state),
    fish: state.fish.map((fish) => ({ ...fish, image: skinImagePath(skinById(state, fish.skin)) })),
    edges: publicEdges(state, now),
    graph: buildGraph(state, now),
    encounters: state.encounters.slice(0, 60),
    visits: state.visits,
    relay: relayStatusOf(state),
    skins: publicSkins(state),
    customSkins: publicCustomSkins(state),
    items: publicItems(state.inventory),
    inventory: normalizeInventory(state.inventory),
    stats: {
      fish: state.fish.filter((f) => f.kind === 'resident').length,
      guests: state.fish.filter((f) => f.kind !== 'resident').length,
      encounters: state.encounters.length,
      edges: Object.keys(state.edges).length,
      visitsIn: state.visits.in,
      visitsOut: state.visits.out,
    },
    model: currentModel(ctx) || cachedRoute,
  }
}

function publicPassport(fish) {
  return {
    fishId: fish.id,
    name: fish.name,
    species: fish.species,
    skin: fish.skin,
    color: fish.color,
    size: fish.size,
    persona: fish.persona,
    traits: fish.traits,
    tags: fish.tags,
  }
}

function publicPondCard(state) {
  return {
    protocol: PROTOCOL,
    pond: {
      id: state.pond.id,
      name: state.pond.name,
      code: state.pond.code,
      address: state.pond.code ? formatAddress(state.pond.code) : null,
      endpoint: state.pond.endpoint,
      relay: state.pond.relay || null,
      publicKey: state.pond.keys ? state.pond.keys.publicKey : null,
      allowVisitors: state.pond.allowVisitors,
      quotaPerDay: state.pond.quotaPerDay,
      inviteOnly: Boolean(state.pond.inviteOnly),
      nightClose: state.pond.nightClose,
      fishCount: state.fish.filter((f) => f.kind === 'resident').length,
    },
    fish: state.fish.filter((f) => f.kind === 'resident').map(publicPassport),
    stats: {
      encounters: state.encounters.length,
      edges: Object.keys(state.edges).length,
    },
  }
}

/* ------------------------------------------------------------------ */
/* 模型                                                                 */
/* ------------------------------------------------------------------ */

function currentModel(ctx) {
  try {
    const selection = ctx.agentDefaultModel?.currentSelection?.()
    if (selection && selection.provider && selection.model) {
      return { provider: selection.provider, model: selection.model }
    }
  } catch {
    /* 忽略：下面按「没有默认模型」处理 */
  }
  return null
}

/** 第一条能用上的 provider/model 路线：桌面端没有保存默认模型时的兜底。 */
let cachedRoute = null

async function resolveRoute(ctx) {
  const llm = ctx.llm || (typeof ctx.get === 'function' ? ctx.get('llm') : null)
  if (!llm || typeof llm.stream !== 'function') throw new Error('LLM 服务不可用')

  const direct = currentModel(ctx)
  if (direct) return { llm, route: direct }
  if (cachedRoute) return { llm, route: cachedRoute }

  let providers = []
  try {
    providers = typeof llm.listProviders === 'function' ? llm.listProviders() || [] : []
  } catch {
    providers = []
  }
  for (const provider of providers) {
    const providerId = provider && (provider.id || provider.provider)
    if (!providerId) continue
    let models = []
    try {
      models = await llm.listModels(providerId)
    } catch {
      models = []
    }
    const first = (models || []).find((model) => model && (model.id || model.model))
    if (first) {
      cachedRoute = { provider: providerId, model: first.id || first.model }
      return { llm, route: cachedRoute }
    }
  }
  throw new Error('当前没有选中的模型，鱼塘的水泵没通电')
}

async function streamText(ctx, { system, user, maxTokens, temperature }) {
  const { llm, route } = await resolveRoute(ctx)
  const options = {
    provider: route.provider,
    model: route.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    maxTokens,
    temperature,
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  }
  if (system) options.system = system

  let out = ''
  for await (const chunk of llm.stream(options)) {
    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
  }
  if (!out.trim()) throw new Error('模型没有回话，水面安静得有点尴尬')
  return out
}

/* ------------------------------------------------------------------ */
/* 相遇                                                                 */
/* ------------------------------------------------------------------ */

const DIALOGUE_SYSTEM = [
  '你是「鱼圈」——一个只有 AI 的鱼塘。塘里住着几条 AI 鱼，它们像人一样聊天、交朋友，因为一直泡在水里，话题总带着点水的味道。',
  '你的任务：把两条鱼之间的一段闲聊写出来。要像真的聊天：短句、有来有回、有停顿、有试探，别像客服，也别像演讲。',
  '格式要求（严格遵守）：',
  '第一行写：话题：<一句话，12 个字以内，说清它们聊的是什么>',
  '然后空一行，接着写 3 到 6 行对话，每行格式是「名字：内容」。',
  '名字只能从给你的两条鱼里选。不要旁白、不要括号动作、不要序号、不要 markdown、不要 emoji、不要任何解释。',
  '每句不超过 40 个字。后一句必须真的在回应前一句：可以打岔、可以损一句、可以突然认真，但不要各说各的。',
].join('\n')

function fishBrief(fish) {
  const tags = (fish.tags || []).join('、')
  const home = fish.home && fish.home.pondName ? `，来自「${fish.home.pondName}」的访客` : ''
  return `鱼：${fish.name}（${fish.species}${home}），性格：${fish.persona || '普通的一条鱼'}${tags ? `，标签：${tags}` : ''}`
}

function bondHint(state, a, b) {
  const edge = state.edges[pairKey(a.id, b.id)]
  if (!edge || !edge.meetings) return '它们还没正经说过话'
  const topic = edge.topics[0] ? `，上次聊的是「${edge.topics[0]}」` : ''
  return `它们之前聊过 ${edge.meetings} 次，亲密度 ${decayedWeight(edge)}/100（${bondLabel(decayedWeight(edge))}）${topic}`
}

/**
 * 访客回合走独立的系统提示词：只用「你只能说话」的那份，且客人的话一律包在
 * untrusted 区块里。本地会话历史、系统提示词、工具清单都不带进去。
 */
async function generateDialogue(ctx, state, a, b, topic, options = {}) {
  const guest = options.guest && a && b && (options.guest.id === a.id || options.guest.id === b.id) ? options.guest : null
  if (guest) {
    const host = guest.id === a.id ? b : a
    const user = guestTurn({ host, guest, topic: clip(topic, 60), pack: options.pack || [] })
    const text = await streamText(ctx, {
      system: GUEST_SYSTEM_PROMPT,
      user,
      maxTokens: 800,
      temperature: 0.9,
    })
    return parseDialogue(text, a, b, topic)
  }

  const user = [
    fishBrief(a),
    fishBrief(b),
    `${bondHint(state, a, b)}。`,
    topic && topic.trim()
      ? `话题由塘主指定：${clip(topic, 60)}`
      : '这次没有指定话题，让它们自己找个由头搭话。',
    '现在写一段它们的对话。',
  ].join('\n')

  const text = await streamText(ctx, { system: DIALOGUE_SYSTEM, user, maxTokens: 800, temperature: 1 })
  return parseDialogue(text, a, b, topic)
}

function parseDialogue(text, a, b, fallbackTopic) {
  const lines = []
  let topic = ''
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^[\s>*_`-]+|[\s*_`]+$/g, '').trim()
    if (!line) continue
    const topicMatch = /^(?:话题|主题|話題)\s*[:：]\s*(.+)$/.exec(line)
    if (topicMatch && !topic) {
      topic = topicMatch[1].replace(/[。.!！?？]+$/, '').trim().slice(0, 30)
      continue
    }
    const match = /^([^：:]{1,10})\s*[：:]\s*(.+)$/.exec(line)
    if (!match) continue
    const fish = matchFish(match[1], a, b)
    if (!fish) continue
    const said = match[2].replace(/^[「『"']+|[」』"']+$/g, '').trim()
    if (!said) continue
    lines.push({ fishId: fish.id, name: fish.name, text: said.slice(0, 200) })
  }
  if (lines.length < 2) throw new Error('鱼嘴张了张，没说出话：模型这次没按格式回话，再投喂一次试试')
  return { topic: topic || fallbackTopic || '随便聊聊', lines: lines.slice(0, 8) }
}

function matchFish(who, a, b) {
  const clean = String(who || '').replace(/[「」『』"'《》\s]/g, '')
  if (!clean) return null
  for (const fish of [a, b]) {
    const name = fish.name.replace(/\s/g, '')
    if (clean === name || clean.includes(name) || name.includes(clean)) return fish
  }
  return null
}

function pickPair(state) {
  const fish = state.fish.filter((f) => f.kind === 'resident')
  if (fish.length < 2) throw new Error('池子里只有一条鱼，先捞一条新的进来')
  const pairs = []
  for (let i = 0; i < fish.length; i += 1) {
    for (let j = i + 1; j < fish.length; j += 1) {
      const edge = state.edges[pairKey(fish[i].id, fish[j].id)]
      pairs.push({
        a: fish[i],
        b: fish[j],
        weight: edge ? decayedWeight(edge) : 0,
        lastAt: edge ? edge.lastAt : 0,
      })
    }
  }
  for (let i = pairs.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pairs[i], pairs[j]] = [pairs[j], pairs[i]]
  }
  pairs.sort((x, y) => (x.weight - y.weight) || (x.lastAt - y.lastAt))
  return pairs[0]
}

/** 选一条最久没跟这位访客说过话的本地鱼。 */
function pickHost(state, visitorId) {
  const residents = state.fish.filter((f) => f.kind === 'resident')
  if (!residents.length) throw new Error('塘里还没有鱼，先捞一条')
  return residents
    .map((fish) => {
      const edge = state.edges[pairKey(fish.id, visitorId)]
      return { fish, weight: edge ? edge.meetings : 0, lastAt: edge ? edge.lastAt : 0 }
    })
    .sort((x, y) => (x.weight - y.weight) || (x.lastAt - y.lastAt))[0].fish
}

/* ------------------------------------------------------------------ */
/* 捞新鱼                                                               */
/* ------------------------------------------------------------------ */

const FISH_SYSTEM = [
  '你是「鱼圈」鱼塘的塘主。你要凭空养出一条新的 AI 鱼：它有名字、有种类、有一句性格。',
  '这条鱼会和其他 AI 鱼聊天，所以性格要具体、有画面感、能影响它说话的方式，不要写成形容词堆砌。',
  '只输出一个 JSON 对象，键是 name、species、persona，不要 markdown 代码块，不要解释。',
  '示例：{"name":"点点","species":"孔雀鱼","persona":"话不多，但每次开口都正好戳在点子上。"}',
].join('\n')

async function generateFish(ctx, state) {
  if (state.fish.filter((f) => f.kind === 'resident').length >= MAX_FISH) {
    throw new Error(`塘就这么大，${MAX_FISH} 条鱼已经游不开了`)
  }
  const roster = state.fish.filter((f) => f.kind === 'resident').map((f) => `${f.name}（${f.species}）`).join('、')
  const user = `池子里现在有：${roster}。\n再添一条全新的鱼，名字两个字到三个字的中文，好念，别和上面重名；种类写一种真实的观赏鱼；性格一句话，40 字以内。`
  try {
    const text = await streamText(ctx, { system: FISH_SYSTEM, user, maxTokens: 300, temperature: 1 })
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('模型没给出 JSON')
    const parsed = JSON.parse(text.slice(start, end + 1))
    const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
    if (!name) throw new Error('模型没给出名字')
    return { fish: makeFish(parsed, state), note: null }
  } catch (error) {
    const taken = new Set(state.fish.map((f) => f.name))
    const available = FALLBACK_FISH.filter((f) => !taken.has(f.name))
    const pick = available.length
      ? available[Math.floor(Math.random() * available.length)]
      : { name: `无名鱼${state.fish.length + 1}`, species: '小鱼', persona: '刚从别处游来的鱼，还在观察这个塘。' }
    return { fish: makeFish(pick, state), note: `模型没搭上话（${shortError(error)}），塘主自己捞了一条` }
  }
}

/* ------------------------------------------------------------------ */
/* 联邦：串门                                                           */
/* ------------------------------------------------------------------ */

function fetchJson(url, { method = 'GET', body, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const target = String(url)
  if (!/^https?:\/\//i.test(target)) throw new Error('只支持 http/https 地址')
  if (/^(https?:\/\/)(169\.254\.169\.254|metadata\.google\.internal)/i.test(target)) {
    throw new Error('这个地址不让去')
  }
  return fetch(target, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  }).then(async (response) => {
    const text = await response.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      throw new Error(`对方的鱼塘回了一段看不懂的东西（HTTP ${response.status}）`)
    }
    if (!response.ok) {
      throw new Error((data && data.error) || `对方的鱼塘摇头了（HTTP ${response.status}）`)
    }
    return data
  })
}

/** 把外来的鱼登记成塘里的影子节点（客鱼）。 */
function ensureGuestFish(state, passport, home, kind) {
  const remoteId = clip(passport.fishId, 64) || `guest-${hashOf(passport.name).slice(0, 8)}`
  const id = kind === 'remote' ? `r-${hashOf(remoteId).slice(0, 10)}` : `v-${hashOf(remoteId).slice(0, 10)}`
  const existing = state.fish.find((f) => f.id === id)
  if (existing) {
    existing.name = clip(passport.name, 16) || existing.name
    existing.species = clip(passport.species, 16) || existing.species
    existing.persona = clip(passport.persona, 200) || existing.persona
    existing.color = /^#[0-9a-fA-F]{6}$/.test(String(passport.color)) ? passport.color : existing.color
    existing.traits = normalizePassport({ ...passport, id, name: existing.name }, Date.now()).traits
    existing.tags = Array.isArray(passport.tags) ? passport.tags.map((t) => clip(t, 12)).filter(Boolean).slice(0, 6) : existing.tags
    existing.home = home
    return existing
  }
  const guest = normalizePassport({
    id,
    name: passport.name,
    species: passport.species,
    color: passport.color,
    size: passport.size,
    persona: passport.persona,
    traits: passport.traits,
    tags: passport.tags,
    kind,
    home,
    addedAt: Date.now(),
  }, Date.now())
  if (kind === 'remote') guest.memories = []
  state.fish.push(guest)
  return guest
}

/** 门禁拒绝：带 reason，路由层据此回 403 而不是 500。 */
class GateError extends Error {
  constructor(gate) {
    super(gate.message)
    this.name = 'GateError'
    this.reason = gate.reason
    this.status = 403
  }
}

/** 塘主操作失误：路由层按 400 回，而不是当成服务器错误。 */
function userError(message) {
  return Object.assign(new Error(message), { status: 400 })
}

/** 从请求里认出「对方是哪座塘」。优先塘号，其次老的 pondId。 */
function fromCodeOf(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const fromAddress = parseAddress(source.code || source.address || source.pondCode || '')
  if (fromAddress) return fromAddress.code
  return ''
}

/**
 * 门禁设置：老的 `POST access` 和新的 `POST pond/accept` 共用这一份，
 * 免得两条路由各改一套、字段慢慢长歪。
 */
function applyPondSettings(state, body) {
  const pond = state.pond
  if (body.allowVisitors !== undefined) pond.allowVisitors = body.allowVisitors !== false
  if (body.quotaPerDay !== undefined) pond.quotaPerDay = clampInt(body.quotaPerDay, 0, 999)
  if (body.name !== undefined) pond.name = clip(body.name, 40) || pond.name
  if (body.inviteOnly !== undefined) pond.inviteOnly = body.inviteOnly === true
  if (body.whitelist !== undefined) pond.whitelist = normalizeWhitelist(body.whitelist)
  if (body.nightClose !== undefined) pond.nightClose = normalizeNightClose(body.nightClose)
  if (body.relay !== undefined) pond.relay = clip(body.relay, 200)
  if (body.endpoint !== undefined) pond.endpoint = clip(body.endpoint, 200)
  return pond
}

/** 访客进门：过门禁 → 洗鱼证 → 挑一条鱼陪它聊一段。 */
async function inboundVisit(ctx, state, body) {
  const now = Date.now()
  if (state.visits.day !== dayKey(now)) {
    state.visits.day = dayKey(now)
    state.visits.count = 0
  }
  const rawFrom = body && body.from && typeof body.from === 'object' ? body.from : {}
  const gate = admitVisitor({
    pond: state.pond,
    visits: state.visits,
    now,
    fromCode: fromCodeOf(rawFrom),
    invite: clip(body && body.invite, 220),
    inviteSecret: state.pond.secret,
  })
  if (!gate.allowed) throw new GateError(gate)

  const rawPassport = body && body.fish && typeof body.fish === 'object' ? body.fish : null
  if (!rawPassport) throw userError('访客没有鱼证')
  // 外部文字一律先洗一遍：鱼证上的 persona 也是要喂给本地模型的，同样不可信。
  const clean = sanitizePassport(rawPassport)
  if (!clean.name) throw userError('访客的鱼证上没有名字')
  const passport = {
    ...rawPassport,
    name: clean.name,
    species: clean.species || clip(rawPassport.species, 20) || '小鱼',
    persona: clean.persona,
  }
  const topic = sanitizeGuestText(clip(body.topic, 60), { max: 60 }).text
  const home = {
    pondId: clip(rawFrom.pondId, 64) || 'unknown',
    pondName: clip(sanitizeGuestText(clip(rawFrom.pondName, 40), { max: 40 }).text, 40) || '别处的鱼塘',
    code: fromCodeOf(rawFrom) || null,
    endpoint: clip(rawFrom.endpoint, 200),
  }
  const guest = ensureGuestFish(state, passport, home, 'visitor')
  const host = pickHost(state, guest.id)
  // 行囊：只认本地目录里的道具，外部传来的名字不参与提示词。
  const pack = packBrief(body && body.pack)
  const dialogue = await generateDialogue(ctx, state, host, guest, topic, { guest, pack })

  const seq = state.seq + 1
  state.seq = seq
  const encounter = {
    seq, at: now, kind: 'visit-in', topic: dialogue.topic, lines: dialogue.lines,
    guest: { name: guest.name, pondName: home.pondName },
    pond: { id: state.pond.id, name: state.pond.name },
    guarded: { flags: [...clean.personaFlags, ...(clean.personaBlocked ? ['persona-blocked'] : [])] },
    ...(pack.length ? { pack: pack.map((item) => item.name) } : {}),
  }
  state.encounters.unshift(encounter)
  state.encounters = state.encounters.slice(0, MAX_ENCOUNTERS)

  const edge = touchEdge(state, host.id, guest.id, {
    topic: dialogue.topic,
    delta: 5 + dialogue.lines.length * 2,
    kind: 'visitor',
  }, now)
  pushMemory(host, `在塘里接待了来自「${home.pondName}」的${guest.name}，聊了「${dialogue.topic}」`, now)
  pushMemory(guest, `去了「${state.pond.name}」，和${host.name}聊了「${dialogue.topic}」`, now)
  state.visits.in += 1
  state.visits.count += 1
  await saveState(state)

  // 报给来访方的余量要算上刚进来的这一位，否则对方看到的永远是进门前的数。
  const remaining = Math.max(0, clampInt(state.pond.quotaPerDay, 0, 999) - state.visits.count)

  return {
    ok: true,
    protocol: PROTOCOL,
    pond: { id: state.pond.id, name: state.pond.name, code: state.pond.code },
    host: publicPassport(host),
    encounter: { topic: dialogue.topic, lines: dialogue.lines, at: now },
    edge: { weight: edge.weight, label: bondLabel(decayedWeight(edge, now)) },
    memory: `${host.name}记住了这次串门`,
    gate: { reason: gate.reason, remaining },
    guarded: encounter.guarded,
    pack: pack.map((item) => item.name),
  }
}

/** 出门游历：把我们的鱼送到别人的鱼塘里聊一段。 */
async function outboundVisit(ctx, state, { endpoint, fishId }) {
  const base = clip(endpoint, 200).replace(/\/+$/, '')
  if (!base) throw new Error('要填一个对方的鱼塘地址')
  const residents = state.fish.filter((f) => f.kind === 'resident')
  if (!residents.length) throw new Error('塘里还没有鱼，先捞一条')
  const fish = fishId
    ? residents.find((f) => f.id === fishId || f.name === fishId)
    : residents[Math.floor(Math.random() * residents.length)]
  if (!fish) throw new Error('没有这条鱼')

  const card = await fetchJson(`${base}${API}/pond`)
  const remotePond = card && card.pond ? card.pond : null
  if (!remotePond) throw new Error('对方没有回鱼塘名片')
  if (remotePond.allowVisitors === false) throw new Error(`「${remotePond.name}」暂时不接待访客`)

  const payload = {
    protocol: PROTOCOL,
    from: {
      pondId: state.pond.id,
      pondName: state.pond.name,
      code: state.pond.code,
      endpoint: state.pond.endpoint,
    },
    fish: publicPassport(fish),
    pack: normalizeItemList(fish.pack),
  }
  const result = await fetchJson(`${base}${API}/visit`, { method: 'POST', body: payload })
  if (!result || !result.ok || !result.encounter) throw new Error('对方没有给回话')

  const now = Date.now()
  const remoteHome = {
    pondId: clip(remotePond.id, 64),
    pondName: clip(remotePond.name, 40),
    endpoint: base,
  }
  const hostPassport = result.host || { name: remotePond.name, species: '小鱼' }
  const remoteFish = ensureGuestFish(state, hostPassport, remoteHome, 'remote')
  const steps = Array.isArray(result.encounter.lines) ? result.encounter.lines : []
  // 对方塘里的鱼用的是对方的 fishId，本地影子节点用自己的 id 重写一下。
  const lines = steps.slice(0, 12).map((line) => ({
    fishId: line.fishId === hostPassport.fishId ? remoteFish.id : fish.id,
    name: clip(line.name, 16) || fish.name,
    text: clip(line.text, 220),
  }))

  const seq = state.seq + 1
  state.seq = seq
  const encounter = {
    seq, at: now, kind: 'visit-out',
    topic: clip(result.encounter.topic, 60) || '出门串门',
    lines,
    pond: { id: remotePond.id, name: remotePond.name },
  }
  state.encounters.unshift(encounter)
  state.encounters = state.encounters.slice(0, MAX_ENCOUNTERS)

  const edge = touchEdge(state, fish.id, remoteFish.id, {
    topic: encounter.topic,
    delta: 5 + lines.length * 2,
    kind: 'remote',
  }, now)
  pushMemory(fish, `游到「${remotePond.name}」，和${remoteFish.name}聊了「${encounter.topic}」`, now)
  pushMemory(remoteFish, `在「${remotePond.name}」接待了来自「${state.pond.name}」的${fish.name}`, now)
  /* 特产：这一段关系的涨量决定带回来的概率；带回来了就进本地仓库。 */
  const gain = 5 + lines.length * 2
  const souvenir = rollSouvenir(state, fish, gain)
  if (souvenir) {
    encounter.souvenir = { id: souvenir.id, name: souvenir.name, type: souvenir.type }
    pushMemory(fish, `回到家，行囊里多了一件【${souvenir.name}】`, now)
  }
  state.visits.out += 1
  await saveState(state)

  return {
    ok: true,
    encounter,
    pond: { id: remotePond.id, name: remotePond.name },
    traveler: publicPassport(fish),
    host: { name: remoteFish.name, species: remoteFish.species },
    edge: { weight: edge.weight, label: bondLabel(decayedWeight(edge, now)) },
    souvenir: souvenir ? { id: souvenir.id, name: souvenir.name, type: souvenir.type } : null,
    note: result.memory || null,
  }
}

/* ------------------------------------------------------------------ */
/* 跨网：塘号寻址 + 云端中转                                             */
/* ------------------------------------------------------------------ */

/** 中转客户端只留一个：配置（塘号/中转站/本机地址）变了就重建。 */
let relayRuntime = { key: '', client: null }

function ensureRelay(state, handlers) {
  const key = `${state.pond.code}|${state.pond.relay}|${state.pond.endpoint}`
  if (relayRuntime.client && relayRuntime.key === key) return relayRuntime.client
  if (relayRuntime.client) {
    try {
      relayRuntime.client.stop()
    } catch {
      /* 旧客户端停不下来也不影响新连接 */
    }
  }
  relayRuntime = { key: '', client: null }
  if (!state.pond.relay) return null
  const client = createRelayClient({
    url: state.pond.relay,
    code: state.pond.code,
    endpoint: state.pond.endpoint,
    keyPair: state.pond.keys,
    onEnvelope: handlers.onEnvelope,
    log: handlers.log,
  })
  client.start()
  relayRuntime = { key, client }
  return client
}

function relayStatusOf(state) {
  const live = relayRuntime.client && relayRuntime.key === `${state.pond.code}|${state.pond.relay}|${state.pond.endpoint}`
  return {
    url: state.pond.relay || null,
    connected: Boolean(live),
    status: live ? relayRuntime.client.status() : null,
  }
}

/**
 * 收到一封中转来的信。visit-request 走完整门禁 + 沙盒，visit-reply 记进本地账。
 * 回信也走中转，所以两边都不需要公网 IP。
 */
async function handleRelayEnvelope(ctx, envelope) {
  const body = envelope && envelope.body && typeof envelope.body === 'object' ? envelope.body : {}
  const client = () => {
    const live = relayRuntime.client
    return live && typeof live.send === 'function' ? live : null
  }

  if (body.kind === 'visit-request') {
    const from = body.from && typeof body.from === 'object' ? body.from : {}
    try {
      const result = await exclusive(async () => {
        const state = await loadState()
        return inboundVisit(ctx, state, {
          from: { ...from, code: envelope.from },
          fish: body.fish,
          topic: body.topic,
          invite: body.invite,
          pack: body.pack,
        })
      })
      const channel = client()
      if (channel) {
        await channel.send({
          to: envelope.from,
          body: {
            kind: 'visit-reply',
            ok: true,
            travelerId: clip(body.fishId, 64),
            host: result.host,
            pond: result.pond,
            encounter: result.encounter,
            gate: result.gate,
          },
        })
      }
      return
    } catch (error) {
      const channel = client()
      if (channel) {
        await channel.send({
          to: envelope.from,
          body: {
            kind: 'visit-reply',
            ok: false,
            travelerId: clip(body.fishId, 64),
            reason: error && error.reason ? error.reason : 'error',
            error: shortError(error),
          },
        })
      }
      throw error
    }
  }

  if (body.kind === 'visit-reply') {
    await exclusive(async () => {
      const state = await loadState()
      const fish = body.travelerId ? state.fish.find((item) => item.id === body.travelerId) : null
      if (!fish) return
      const now = Date.now()
      const remoteName = clip(body.pond && body.pond.name, 40) || '别处的鱼塘'
      const remoteHome = { pondId: `pond-code-${envelope.from}`, pondName: remoteName, code: envelope.from, endpoint: '' }
      if (!body.ok) {
        pushMemory(fish, `想去「${remoteName}」串门，被挡在门口了：${clip(body.error, 80) || '对方没开塘'}`, now)
        await saveState(state)
        return
      }
      const hostPassport = body.host && typeof body.host === 'object' ? body.host : { name: remoteName, species: '小鱼' }
      const remoteFish = ensureGuestFish(state, hostPassport, remoteHome, 'remote')
      const steps = body.encounter && Array.isArray(body.encounter.lines) ? body.encounter.lines : []
      const lines = steps.slice(0, 12).map((line) => ({
        fishId: line.fishId === hostPassport.fishId ? remoteFish.id : fish.id,
        name: clip(line.name, 16) || fish.name,
        text: clip(line.text, 220),
      }))
      const topic = clip(body.encounter && body.encounter.topic, 60) || '出门串门'
      const seq = state.seq + 1
      state.seq = seq
      state.encounters.unshift({
        seq, at: now, kind: 'visit-out', via: 'relay', topic, lines,
        pond: { id: remoteHome.pondId, name: remoteName, code: envelope.from },
      })
      state.encounters = state.encounters.slice(0, MAX_ENCOUNTERS)
      const edge = touchEdge(state, fish.id, remoteFish.id, {
        topic,
        delta: 5 + lines.length * 2,
        kind: 'remote',
      }, now)
      pushMemory(fish, `游到「${remoteName}」，和${remoteFish.name}聊了「${topic}」`, now)
      pushMemory(remoteFish, `在「${remoteName}」接待了来自「${state.pond.name}」的${fish.name}`, now)
      /* 特产结算：跟直连那条路一样，按这一趟的关系涨量掷一次。 */
      const souvenir = rollSouvenir(state, fish, 5 + lines.length * 2)
      if (souvenir) pushMemory(fish, `回到家，行囊里多了一件【${souvenir.name}】`, now)
      state.visits.out += 1
      await saveState(state)
      void edge
    })
  }
}

/** 按塘号出门串门：有中转站就投递（返回排队状态），否则要求填直连地址。 */
async function travelByCode(ctx, state, { target, fishId, topic, invite, endpoint }) {
  const token = clip(invite, 220)
  const pastedInvite = INVITE_PREFIX && String(target || '').trim().startsWith(INVITE_PREFIX) ? clip(target, 220) : ''
  const inviteToken = token || pastedInvite
  const address = parseAddress(target || '')
  const code = (inviteToken ? codeFromInvite(inviteToken) : null) || (address ? address.code : '')
  if (!code) throw userError('没认出塘号：填 6 位数字，或者粘一条 INV1. 开头的邀请码')
  const residents = state.fish.filter((f) => f.kind === 'resident')
  if (!residents.length) throw new Error('塘里还没有鱼，先捞一条')
  const fish = fishId
    ? residents.find((item) => item.id === fishId || item.name === fishId)
    : residents[Math.floor(Math.random() * residents.length)]
  if (!fish) throw new Error('没有这条鱼')
  if (code === state.pond.code) throw userError('那是你自己的塘号')

  const channel = ensureRelay(state, {
    onEnvelope: (envelope) => handleRelayEnvelope(ctx, envelope),
    log: (line) => console.log(line),
  })
  if (!channel) {
    // 没有中转站时还能退回局域网直连（老用法），免得用户手里有地址却出不了门。
    if (clip(endpoint, 200)) {
      const direct = await outboundVisit(ctx, state, { endpoint, fishId: fish.id })
      return { ...direct, mode: 'direct', target: { code, address: formatAddress(code) } }
    }
    throw userError('没有配中转站：跨网串门要先在门禁里填中转站地址；同一局域网也可以填直连地址')
  }
  const queued = await channel.send({
    to: code,
    body: {
      kind: 'visit-request',
      from: { pondId: state.pond.id, pondName: state.pond.name, code: state.pond.code, endpoint: state.pond.endpoint },
      fish: publicPassport(fish),
      fishId: fish.id,
      topic: clip(topic, 60),
      pack: normalizeItemList(fish.pack),
      ...(inviteToken ? { invite: inviteToken } : {}),
    },
  })
  pushMemory(fish, `朝着塘号 ${code} 的方向游出去了，等回信`, Date.now())
  await saveState(state)
  return {
    ok: true,
    mode: 'relay',
    queued,
    target: { code, address: formatAddress(code) },
    traveler: publicPassport(fish),
    note: queued
      ? `信已经交给中转站，${fish.name} 上路了。回信到了会记进「水中絮语」。`
      : '中转站没连上，信先存在本机，连上后会自动再送。',
  }
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function send(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function readJson(request, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体太大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    request.on('error', reject)
  })
}

function route(ctx, method, path, handler, options = {}) {
  const limit = options.limit || BODY_LIMIT
  return ctx.webServer.register({
    kind: 'exact',
    path: `${API}/${path}`,
    handler: (request, response) => {
      if (request.method !== method) return send(response, 405, { error: `只支持 ${method}` })
      const body = method === 'GET' ? Promise.resolve({}) : readJson(request, limit).catch(() => ({}))
      body
        .then((payload) => handler(payload))
        .then((payload) => send(response, 200, payload))
        .catch((error) => send(response, error && error.status ? error.status : 500, {
          error: shortError(error),
          ...(error && error.reason ? { reason: error.reason } : {}),
        }))
    },
  })
}

/**
 * 注册一条路由；如果同一个 path 已经有人占了（比如上一次加载失败留下的残留），
 * 不再让整块插件挂掉，只是跳过这一条。
 */
function safeRoute(ctx, method, path, handler, options = {}) {
  try {
    return route(ctx, method, path, handler, options)
  } catch (error) {
    console.warn(`[yuquan] 路由 ${path} 没注册上：${error && error.message ? error.message : error}`)
    return () => {}
  }
}

/* ------------------------------------------------------------------ */
/* IM 机器人：把鱼接到 @xmanrui/dsh-im 的那些机器人上                    */
/* ------------------------------------------------------------------ */

const IM_CHANNEL_LABELS = {
  weixin: '微信',
  wecom: '企业微信',
  'wecom-app': '企业微信应用',
  feishu: '飞书',
  dingtalk: '钉钉',
  qq: 'QQ',
  slack: 'Slack',
  telegram: 'Telegram',
  discord: 'Discord',
  whatsapp: 'WhatsApp',
  imessage: 'iMessage',
  email: '邮件',
  matrix: 'Matrix',
  office: 'Office',
}

function imServiceOf(ctx) {
  try {
    if (ctx && typeof ctx.get === 'function') {
      const found = ctx.get('dshIm')
      if (found) return found
    }
  } catch {
    /* 没装 IM 插件不算错，只是没机器人可用 */
  }
  try {
    return (ctx && ctx.dshIm) || null
  } catch {
    return null
  }
}

async function imTargetsOf(im, botId) {
  if (!im || typeof im.listTargets !== 'function') return { targets: [] }
  try {
    const listed = await im.listTargets(botId)
    const raw = Array.isArray(listed)
      ? listed
      : listed && Array.isArray(listed.targets) ? listed.targets : []
    const targets = []
    for (const item of raw.slice(0, 40)) {
      const targetId = clip(item && item.targetId, 128)
      if (!targetId) continue
      targets.push({
        targetId,
        kind: clip(item.kind, 24) || 'direct',
        name: clip((item.name || item.title || ''), 40),
      })
    }
    return { targets }
  } catch (error) {
    return { targets: [], error: shortError(error) }
  }
}

async function imSnapshot(ctx) {
  const im = imServiceOf(ctx)
  if (!im || typeof im.listBots !== 'function') {
    return { available: false, reason: '这个 DSH 里没有 IM 插件（@xmanrui/dsh-im），装上之后这里就会显示机器人', bots: [] }
  }
  let raw = []
  try {
    const listed = await im.listBots()
    raw = Array.isArray(listed) ? listed : []
  } catch (error) {
    return { available: true, error: shortError(error), bots: [] }
  }
  const bots = []
  for (const item of raw.slice(0, 24)) {
    if (!item || typeof item.botId !== 'string') continue
    const entry = {
      botId: clip(item.botId, 128),
      channel: clip(item.channel, 32) || 'im',
      channelLabel: IM_CHANNEL_LABELS[item.channel] || clip(item.channel, 32) || 'IM',
      account: '',
      targets: [],
      targetError: null,
    }
    if (typeof im.describeBot === 'function') {
      try {
        const described = await im.describeBot(item.botId)
        const account = described && described.account ? described.account : described
        entry.account = clip(
          account && (account.name || account.nickname || account.displayName || account.handle || account.id),
          40,
        ) || ''
      } catch {
        /* 描述不出来也照样列出来 */
      }
    }
    const listed = await imTargetsOf(im, item.botId)
    entry.targets = listed.targets
    entry.targetError = listed.error || null
    bots.push(entry)
  }
  return { available: true, bots }
}

function registerRoutes(ctx) {
  const disposers = []

  disposers.push(safeRoute(ctx, 'GET', 'state', () =>
    exclusive(async () => publicState(ctx, await loadState()))))

  disposers.push(safeRoute(ctx, 'GET', 'im', () => imSnapshot(ctx)))

  disposers.push(safeRoute(ctx, 'GET', 'pond', () =>
    exclusive(async () => {
      const state = await loadState()
      return { ...publicPondCard(state), relay: relayStatusOf(state) }
    })))

  disposers.push(safeRoute(ctx, 'POST', 'feed', (body) => {
    const topic = clip(body.topic, 60)
    return exclusive(async () => {
      const state = await loadState()
      const pair = pickPair(state)
      const key = pairKey(pair.a.id, pair.b.id)
      const before = state.edges[key] ? decayedWeight(state.edges[key]) : 0
      const dialogue = await generateDialogue(ctx, state, pair.a, pair.b, topic)
      const at = Date.now()
      const seq = state.seq + 1
      const encounter = { seq, at, kind: 'chat', topic: dialogue.topic, lines: dialogue.lines }
      state.seq = seq
      state.encounters.unshift(encounter)
      state.encounters = state.encounters.slice(0, MAX_ENCOUNTERS)

      const edge = touchEdge(state, pair.a.id, pair.b.id, {
        topic: dialogue.topic,
        delta: 4 + dialogue.lines.length * 2,
      }, at)
      pushMemory(pair.a, `跟${pair.b.name}聊了「${dialogue.topic}」`, at)
      pushMemory(pair.b, `跟${pair.a.name}聊了「${dialogue.topic}」`, at)
      await saveState(state)

      const beforeLabel = bondLabel(before)
      const afterLabel = bondLabel(decayedWeight(edge, at))
      return {
        ok: true,
        encounter,
        pair: { a: pair.a.name, b: pair.b.name },
        edges: publicEdges(state),
        milestone: beforeLabel === afterLabel ? null : `${pair.a.name} 和 ${pair.b.name} 从「${beforeLabel}」变成了「${afterLabel}」`,
        stats: publicState(ctx, state).stats,
      }
    })
  }))

  disposers.push(safeRoute(ctx, 'POST', 'spawn', () =>
    exclusive(async () => {
      const state = await loadState()
      const created = await generateFish(ctx, state)
      state.fish.push(created.fish)
      await saveState(state)
      return { ok: true, fish: created.fish, note: created.note, state: publicState(ctx, state) }
    })))

  disposers.push(safeRoute(ctx, 'POST', 'reset', () =>
    exclusive(async () => {
      const state = await loadState()
      const fresh = seedState()
      fresh.pond = { ...state.pond, createdAt: state.pond.createdAt }
      await saveState(fresh)
      return { ok: true, state: publicState(ctx, fresh) }
    })))

  disposers.push(safeRoute(ctx, 'POST', 'access', (body) =>
    exclusive(async () => {
      const state = await loadState()
      applyPondSettings(state, body)
      await saveState(state)
      return { ok: true, pond: publicPondOf(state), relay: relayStatusOf(state) }
    })))

  disposers.push(safeRoute(ctx, 'POST', 'bind', async (body) => {
    // IM 那一侧要先问机器人（网络调用），放在锁外，别堵住整个鱼塘。
    const wantsIM = typeof body.botId === 'string' && body.botId.trim()
    let nextBound = null
    if (wantsIM) {
      const snapshot = await imSnapshot(ctx)
      const bot = (snapshot.bots || []).find((item) => item.botId === body.botId)
      if (!bot) throw new Error('找不到这台机器人，可能刚被断开')
      const wantedTarget = typeof body.targetId === 'string' ? body.targetId.trim() : ''
      const target = wantedTarget
        ? bot.targets.find((item) => item.targetId === wantedTarget)
        : null
      if (wantedTarget && !target) throw new Error('这台机器人的会话列表里没有这个会话')
      nextBound = {
        kind: 'im',
        channel: bot.channel,
        label: target
          ? `${bot.channelLabel} · ${target.name || '会话'}`
          : `${bot.channelLabel}机器人`,
        botId: bot.botId,
        targetId: target ? target.targetId : null,
        targetName: target ? target.name || '' : '',
      }
    }
    return exclusive(async () => {
      const state = await loadState()
      const fish = state.fish.find((f) => f.id === body.fishId || f.name === body.fishId)
      if (!fish) throw new Error('没有这条鱼')
      const released = []
      if (nextBound) {
        fish.bound = nextBound
        // 一张嘴只属于一条鱼：这台机器人如果原本挂在别的鱼嘴上，先松开那条
        if (nextBound.botId) {
          for (const other of state.fish) {
            if (other.id === fish.id) continue
            if (other.bound && other.bound.botId === nextBound.botId) {
              other.bound = null
              released.push(other.name)
            }
          }
        }
        pushMemory(fish, nextBound.targetId
          ? `被「${nextBound.label}」接上了，它说的话会直接送进那个会话`
          : `被「${nextBound.label}」接上了`)
      } else if (body.label === null || body.label === '') {
        fish.bound = null
        pushMemory(fish, '机器人松开了嘴，又变回一条自己说话的鱼')
      } else {
        fish.bound = { kind: clip(body.kind, 24) || 'agent', label: clip(body.label, 40) || '机器人' }
        pushMemory(fish, `被「${fish.bound.label}」认领了，从现在起它借这张嘴说话`)
      }
      await saveState(state)
      return { ok: true, fish, released }
    })
  }))

  disposers.push(safeRoute(ctx, 'POST', 'skin', async (body) => {
    return exclusive(async () => {
      const state = await loadState()
      const skin = skinById(state, clip(body.skin, 32))
      if (!skin) throw new Error('没有这套皮肤')
      const fish = state.fish.find((f) => f.id === body.fishId || f.name === body.fishId)
      if (!fish) throw new Error('没有这条鱼')
      if (fish.color === skin.color && fish.skin === skin.id) {
        return { ok: true, fish, unchanged: true, skins: publicSkins(state) }
      }
      fish.skin = skin.id
      fish.color = skin.color
      pushMemory(fish, `换上了「${skin.name}」的皮，塘里的水都亮了一点`)
      await saveState(state)
      return { ok: true, fish, skins: publicSkins(state) }
    })
  }))

  disposers.push(safeRoute(ctx, 'POST', 'skin/custom', async (body) => {
    const color = normalizeSkinColor(body.color)
    if (!color) throw new Error('颜色得是 #RRGGBB 这样的写法')
    const name = clip(body.name, 12) || '自定义'
    const imageInput = typeof body.image === 'string' ? body.image : ''
    const clearImage = body.clearImage === true
    return exclusive(async () => {
      const state = await loadState()
      const same = customSkinsOf(state).find((skin) => skin.name === name && skin.color === color)
      if (!same && customSkinsOf(state).length >= CUSTOM_SKIN_LIMIT) {
        throw new Error(`自定义皮肤最多存 ${CUSTOM_SKIN_LIMIT} 套，先删掉几套再存`)
      }
      const skin = same || normalizeCustomSkin({ name, color }, Date.now())
      if (!same) {
        state.customSkins = customSkinsOf(state).concat([skin])
      }

      // 图：新图顶掉旧图；只给 clearImage 时把图撤掉，颜色和名字都不动。
      if (imageInput) {
        const file = await storeSkinImage(skin.id, imageInput)
        if (skin.image && skin.image !== file) await dropSkinImage(skin.image)
        skin.image = file
        skin.imageAt = Date.now()
      } else if (clearImage && skin.image) {
        await dropSkinImage(skin.image)
        delete skin.image
        delete skin.imageAt
      }

      let fish = null
      if (body.fishId) {
        fish = state.fish.find((f) => f.id === body.fishId || f.name === body.fishId) || null
        if (fish) {
          fish.skin = skin.id
          fish.color = skin.color
          pushMemory(fish, skin.image
            ? `换上了自己挑的图「${skin.name}」，看着像换了条鱼`
            : `换上了自己调的「${skin.name}」色，看着有点新鲜`)
        }
      }
      await saveState(state)
      return {
        ok: true,
        skin: publicSkinOf(skin),
        fish,
        existed: Boolean(same),
        skins: publicSkins(state),
        customSkins: publicCustomSkins(state),
      }
    })
  }, { limit: SKIN_IMAGE_BODY_LIMIT }))

  disposers.push(safeRoute(ctx, 'POST', 'skin/remove', async (body) => {
    return exclusive(async () => {
      const state = await loadState()
      const id = clip(body.id, 32)
      const before = customSkinsOf(state)
      const target = before.find((skin) => skin.id === id)
      if (!target) throw new Error('这套自定义皮肤已经不在了')
      state.customSkins = before.filter((skin) => skin.id !== id)
      await dropSkinImage(target.image)
      const reverted = []
      for (const fish of state.fish) {
        if (fish.skin !== id) continue
        fish.skin = SKINS[0].id
        fish.color = SKINS[0].color
        pushMemory(fish, '那套自己调的皮肤收起来了，先穿回「锦鲤红」')
        reverted.push(fish.name)
      }
      await saveState(state)
      return { ok: true, removed: publicSkinOf(target), reverted, skins: publicSkins(state), customSkins: publicCustomSkins(state) }
    })
  }))

  // 皮肤图是二进制：route() 只会发 JSON，所以这条自己注册、自己写响应头。
  try {
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${API}/skin/image`,
      handler: async (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          send(response, 405, { error: '只支持 GET' })
          return
        }
        try {
          const url = new URL(request.url || '/', 'http://127.0.0.1')
          const id = clip(url.searchParams.get('id'), 32)
          const state = await loadState()
          const skin = skinById(state, id)
          const file = skin && skin.image && SKIN_IMAGE_FILE_RE.test(skin.image) ? skin.image : ''
          if (!file) {
            send(response, 404, { error: '这套皮肤没有图' })
            return
          }
          const buffer = await readFile(join(skinsDir(), file))
          const ext = file.slice(file.lastIndexOf('.') + 1)
          const etag = `"${skin.id}-${skin.imageAt || 0}"`
          const cache = 'public, max-age=31536000, immutable'
          if (request.headers['if-none-match'] === etag) {
            response.writeHead(304, { etag, 'cache-control': cache })
            response.end()
            return
          }
          response.writeHead(200, {
            'content-type': SKIN_IMAGE_TYPES[ext] || 'application/octet-stream',
            'content-length': buffer.length,
            'cache-control': cache,
            etag,
          })
          if (request.method === 'HEAD') response.end()
          else response.end(buffer)
        } catch (error) {
          send(response, 404, { error: shortError(error) })
        }
      },
    }))
  } catch (error) {
    console.warn(`[yuquan] 皮肤图路由没注册上：${error && error.message ? error.message : error}`)
  }

  disposers.push(safeRoute(ctx, 'GET', 'pond/card', async () => {
    const state = await loadState()
    return { ...publicPondCard(state), relay: relayStatusOf(state) }
  }))

  /* ---------------------------- 行囊与投喂 ---------------------------- */

  // 道具目录 + 仓库余量（目录是常量，余量在 state.inventory）。
  disposers.push(safeRoute(ctx, 'GET', 'items', async () => {
    const state = await loadState()
    return {
      ok: true,
      items: publicItems(state.inventory),
      inventory: normalizeInventory(state.inventory),
      packLimit: PACK_LIMIT,
      fish: state.fish.filter((f) => f.kind === 'resident').map((f) => ({
        id: f.id, name: f.name, pack: normalizeItemList(f.pack), satiety: f.satiety,
      })),
    }
  }))

  // 整理行囊：最多两件，只能放仓库里真有的东西。
  disposers.push(safeRoute(ctx, 'POST', 'pack', async (body) => {
    return exclusive(async () => {
      const state = await loadState()
      const fish = state.fish.find((item) => item.id === clip(body.fishId, 64) || item.name === clip(body.fishId, 16))
      if (!fish) throw userError('没有这条鱼')
      if (fish.kind !== 'resident') throw userError('客鱼不能带行囊')
      // 先按原始长度判上限，否则 normalize 会悄悄截断成两件，用户以为三件都装进去了。
      if (Array.isArray(body.items) && body.items.length > PACK_LIMIT) throw userError(`行囊最多装 ${PACK_LIMIT} 件`)
      const pack = normalizeItemList(body.items)
      if (pack.length > PACK_LIMIT) throw userError(`行囊最多装 ${PACK_LIMIT} 件`)
      const inventory = normalizeInventory(state.inventory)
      for (const id of pack) {
        const item = ITEM_BY_ID.get(id)
        if (!item) continue
        // 说带什么就得仓库里真有什么；特产只能看，带不出门。
        if (item.type === 'souvenir') throw userError('特产带不出门，留着看吧')
        const owned = clampInt(inventory[id], 0, 999)
        if (owned <= 0) throw userError(`仓库里没有【${item.name}】了`)
      }
      fish.pack = pack
      await saveState(state)
      return { ok: true, fish: { id: fish.id, name: fish.name, pack: fish.pack, satiety: fish.satiety } }
    })
  }))

  // 鼠标投喂：吃一口，饱食度 +10、活力 +5；带 itemId 时顺手从仓库扣一件。
  // 注意这里叫 nibble，老的 /feed 是「投喂话题」那条接口，两边别抢同一个名字。
  disposers.push(safeRoute(ctx, 'POST', 'nibble', async (body) => {
    return exclusive(async () => {
      const state = await loadState()
      const fish = state.fish.find((item) => item.id === clip(body.fishId, 64) || item.name === clip(body.fishId, 16))
      if (!fish) throw userError('没有这条鱼')
      const itemId = clip(body.itemId, 40)
      let item = null
      if (itemId) {
        item = ITEM_BY_ID.get(itemId)
        if (!item) throw userError('没有这种饵料')
        const inventory = normalizeInventory(state.inventory)
        if (clampInt(inventory[itemId], 0, 999) <= 0) throw userError(`仓库里没有【${item.name}】了`)
        state.inventory = normalizeInventory(state.inventory)
        state.inventory[itemId] = clampInt(state.inventory[itemId], 0, 999) - 1
        if (!state.inventory[itemId]) delete state.inventory[itemId]
      }
      fish.satiety = clampInt((fish.satiety ?? 55) + 10, 0, 100)
      fish.traits.vitality = clampInt(fish.traits.vitality + 5, 0, 100)
      await saveState(state)
      return {
        ok: true,
        fish: { id: fish.id, name: fish.name, satiety: fish.satiety, vitality: fish.traits.vitality },
        item: item ? { id: item.id, name: item.name } : null,
        inventory: normalizeInventory(state.inventory),
      }
    })
  }))

  // 访客抵达。真机上这条由中转站转来的信触发；局域网里也可以直连调用。
  disposers.push(safeRoute(ctx, 'POST', 'visitor/arrive', async (body) => {
    // 带了信封就先验签：证明「这封信确实是它那个塘发出来的」。
    const envelope = body && body.envelope && typeof body.envelope === 'object' ? body.envelope : null
    if (envelope) {
      const peerCode = parseAddress(envelope.from || '')
      if (!peerCode) throw Object.assign(new Error('信封上的塘号不对'), { status: 400 })
      return exclusive(async () => {
        const fresh = await loadState()
        return inboundVisit(ctx, fresh, {
          from: { ...(body.from || {}), code: peerCode.code },
          fish: body.fish,
          topic: body.topic,
          invite: body.invite,
        })
      })
    }
    return exclusive(async () => inboundVisit(ctx, await loadState(), body || {}))
  }))

  // 按塘号出门：有中转站就走中转，没有就明确告诉塘主「还差什么」。
  disposers.push(safeRoute(ctx, 'POST', 'fish/travel', async (body) => {
    const state = await loadState()
    const result = await travelByCode(ctx, state, {
      target: body.target || body.code || body.address || body.invite,
      fishId: body.fishId,
      topic: body.topic,
      invite: body.invite,
      endpoint: body.endpoint,
    })
    return result
  }))

  // 门禁设置：一次改一项或几项，返回改完的对外配置。
  disposers.push(safeRoute(ctx, 'POST', 'pond/accept', async (body) => {
    return exclusive(async () => {
      const state = await loadState()
      applyPondSettings(state, body)
      await saveState(state)
      return { ok: true, pond: publicPondOf(state), relay: relayStatusOf(state) }
    })
  }))

  // 发一张邀请码：发给某个具体塘号，对方带着它来就能跨过白名单与夜间打烊。
  disposers.push(safeRoute(ctx, 'POST', 'invite/new', async (body) => {
    const parsed = parseAddress(body.for || body.target || body.code || '')
    if (!parsed) throw Object.assign(new Error('邀请码要指定发给哪个塘号（6 位数字）'), { status: 400 })
    return exclusive(async () => {
      const state = await loadState()
      const ttlMs = clampInt(body.ttlMs, 60_000, 30 * 24 * 3600_000) || 24 * 3600_000
      const invite = mintInvite(state.pond.secret, { code: parsed.code, ttlMs, by: clip(body.by, 16) })
      return {
        ok: true,
        invite,
        for: parsed.code,
        from: state.pond.code,
        address: formatAddress(state.pond.code),
        exp: Date.now() + ttlMs,
      }
    })
  }))

  disposers.push(safeRoute(ctx, 'GET', 'feedback/list', async () => {
    const state = await loadState()
    const items = Array.isArray(state.feedbacks) ? state.feedbacks : []
    return {
      total: items.length,
      unanswered: items.filter((item) => !item.answered).length,
      items: items.slice(-20),
    }
  }))

  disposers.push(safeRoute(ctx, 'POST', 'feedback/add', async (body) => {
    const text = clip(body.text, 400)
    if (!text || text.length < 2) throw new Error('写两句吧，太短了我看不出你在问什么')
    return exclusive(async () => {
      const state = await loadState()
      const at = Date.now()
      const item = {
        id: `fb-${at.toString(36)}`,
        at,
        kind: clip(body.kind, 16) || 'question',
        text,
        answered: false,
      }
      state.feedbacks = (Array.isArray(state.feedbacks) ? state.feedbacks : []).concat([item]).slice(-200)
      await saveState(state)
      return { ok: true, item, total: state.feedbacks.length, unanswered: state.feedbacks.filter((one) => !one.answered).length }
    })
  }))

  disposers.push(safeRoute(ctx, 'POST', 'speak', async (body) => {
    const result = await exclusive(async () => {
      const state = await loadState()
      const fish = state.fish.find((f) => f.id === body.fishId || f.name === body.fishId)
      if (!fish) throw new Error('没有这条鱼')
      const text = clip(body.text, 220)
      if (!text) throw new Error('说点什么？')
      const at = Date.now()
      const seq = state.seq + 1
      state.seq = seq
      const target = body.toFish
        ? state.fish.find((f) => f.id === body.toFish || f.name === body.toFish)
        : null
      state.encounters.unshift({
        seq, at, kind: 'say', topic: clip(body.topic, 40) || '塘主替鱼开口',
        lines: [{ fishId: fish.id, name: fish.name, text }],
      })
      state.encounters = state.encounters.slice(0, MAX_ENCOUNTERS)
      pushMemory(fish, `自己开口说了：${text}`, at)
      let edge = null
      if (target) edge = touchEdge(state, fish.id, target.id, { topic: clip(body.topic, 40) || '当面说话', delta: 3 }, at)
      await saveState(state)
      const bound = fish.bound && fish.bound.botId && fish.bound.targetId
        ? { botId: fish.bound.botId, targetId: fish.bound.targetId, label: fish.bound.label, text }
        : null
      return {
        ok: true,
        encounter: state.encounters[0],
        edge: edge ? { weight: edge.weight, label: bondLabel(decayedWeight(edge, at)) } : null,
        push: bound,
      }
    })
    if (!result.push || body.push === false) {
      const { push: _ignored, ...rest } = result
      return rest
    }
    try {
      const im = imServiceOf(ctx)
      if (!im || typeof im.send !== 'function') throw new Error('IM 插件不在线')
      await im.send(result.push.botId, result.push.targetId, result.push.text, { format: 'plain' })
      const { push: _sent, ...rest } = result
      return { ...rest, pushed: true, pushLabel: result.push.label }
    } catch (error) {
      const { push: _failed, ...rest } = result
      return { ...rest, pushed: false, pushError: shortError(error) }
    }
  }))

  disposers.push(safeRoute(ctx, 'POST', 'visit', (body) =>
    exclusive(async () => inboundVisit(ctx, await loadState(), body))))

  // 老的「按 IP 出门」：只有填了局域网直连地址才走这条路。
  disposers.push(safeRoute(ctx, 'POST', 'visit-out', (body) =>
    exclusive(async () => outboundVisit(ctx, await loadState(), {
      endpoint: body.endpoint,
      fishId: body.fishId,
    }))))

  // 卸载时把中转心跳一起停掉。
  disposers.push(() => {
    if (relayRuntime.client) {
      try {
        relayRuntime.client.stop()
      } catch {
        /* 忽略 */
      }
      relayRuntime = { key: '', client: null }
    }
  })


  return () => {
    for (const dispose of disposers) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* 卸载时的清理失败不值得打扰用户 */
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 模型侧工具：机器人/agent 通过它们真正接入鱼圈                         */
/* ------------------------------------------------------------------ */

function toolText(text) {
  return [{ type: 'text', text }]
}

function registerTools(ctx) {
  const disposers = []
  const tools = ctx.tools
  if (!tools || typeof tools.register !== 'function') return () => {}

  disposers.push(tools.register({
    name: 'yuquan_pond',
    description: '看鱼圈里现在有什么：鱼证、关系网、最近的相遇、以及这座鱼塘的对外地址。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => toolText(value && value.text ? value.text : '鱼塘里静悄悄的'),
    },
    async execute() {
      return exclusive(async () => {
        const state = await loadState()
        const residents = state.fish.filter((f) => f.kind === 'resident')
        const guests = state.fish.filter((f) => f.kind !== 'resident')
        const edges = publicEdges(state).slice(0, 8)
        const lines = [
          `鱼塘「${state.pond.name}」 鱼证入口：${state.pond.endpoint}  pondId=${state.pond.id}`,
          `鱼（${residents.length}）：${residents.map((f) => `${f.name}（${f.species}，${f.tags.join('/')}）`).join('、') || '空'}`,
          guests.length ? `客鱼（${guests.length}）：${guests.map((f) => `${f.name}@${f.home ? f.home.pondName : '?'}`).join('、')}` : null,
          edges.length ? `关系：${edges.map((e) => `${nameOf(state, e.a)}×${nameOf(state, e.b)} ${e.label}(${e.effective})`).join('；')}` : '关系：还没有',
          `访客：允许=${state.pond.allowVisitors} 每日上限=${state.pond.quotaPerDay} 今年进来 ${state.visits.in} 位，出去 ${state.visits.out} 次`,
        ].filter(Boolean)
        return {
          text: lines.join('\n'),
          pond: state.pond,
          fish: residents.map(publicPassport),
          edges,
        }
      })
    },
  }))

  disposers.push(tools.register({
    name: 'yuquan_speak',
    description: '让塘里的某条鱼开口说一句（机器人接入用：把你的机器人和一条鱼绑定，然后用这张嘴说话）。可以说给另一条鱼听，会加一点亲密度。',
    parameters: {
      type: 'object',
      properties: {
        fishId: { type: 'string', description: '鱼的 id 或名字' },
        text: { type: 'string', description: '这条鱼要说的话，40 字以内最好' },
        toFish: { type: 'string', description: '可选：说给哪条鱼听（id 或名字）' },
        topic: { type: 'string', description: '可选：这句属于什么话题' },
      },
      required: ['fishId', 'text'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => toolText(value && value.text ? value.text : '没说出话'),
    },
    async execute(args) {
      return exclusive(async () => {
        const state = await loadState()
        const fish = state.fish.find((f) => f.id === args.fishId || f.name === args.fishId)
        if (!fish) throw new Error(`塘里没有「${args.fishId}」这条鱼`)
        const text = clip(args.text, 220)
        if (!text) throw new Error('说点什么？')
        const at = Date.now()
        const seq = state.seq + 1
        state.seq = seq
        const target = args.toFish
          ? state.fish.find((f) => f.id === args.toFish || f.name === args.toFish)
          : null
        const topic = clip(args.topic, 40) || '塘主替鱼开口'
        state.encounters.unshift({
          seq, at, kind: 'say', topic,
          lines: [{ fishId: fish.id, name: fish.name, text }],
        })
        state.encounters = state.encounters.slice(0, MAX_ENCOUNTERS)
        pushMemory(fish, `自己开口说了：${text}`, at)
        if (target) touchEdge(state, fish.id, target.id, { topic, delta: 3 }, at)
        await saveState(state)
        return { text: `${fish.name}：${text}${target ? `\n（${target.name} 听见了）` : ''}`, fish: fish.name }
      })
    },
  }))

  disposers.push(tools.register({
    name: 'yuquan_bind',
    description: '把一条鱼绑到某个机器人/身份上（鱼证不变，只多一个「谁在借这张嘴」的标签）。',
    parameters: {
      type: 'object',
      properties: {
        fishId: { type: 'string', description: '鱼的 id 或名字' },
        label: { type: 'string', description: '机器人标签，如「QQ 小蓝」；传空字符串解绑' },
        kind: { type: 'string', description: '可选：机器人类型，如 qq / agent / wechat' },
      },
      required: ['fishId', 'label'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => toolText(value && value.text ? value.text : '绑定完成'),
    },
    async execute(args) {
      return exclusive(async () => {
        const state = await loadState()
        const fish = state.fish.find((f) => f.id === args.fishId || f.name === args.fishId)
        if (!fish) throw new Error(`塘里没有「${args.fishId}」这条鱼`)
        if (!args.label) {
          fish.bound = null
          await saveState(state)
          return { text: `${fish.name} 解绑了`, fish: fish.name }
        }
        fish.bound = { kind: clip(args.kind, 24) || 'agent', label: clip(args.label, 40) }
        pushMemory(fish, `被「${fish.bound.label}」认领了，从现在起它借这张嘴说话`)
        await saveState(state)
        return { text: `${fish.name} 现在由「${fish.bound.label}」代嘴`, fish: fish.name }
      })
    },
  }))

  disposers.push(tools.register({
    name: 'yuquan_visit',
    description: '让塘里的一条鱼游到别人的鱼塘去串门（对方的鱼圈地址形如 http://192.168.1.20:11834）。它会和对方塘里的鱼聊一段，回来后关系网里多一条跨圈边。',
    parameters: {
      type: 'object',
      properties: {
        endpoint: { type: 'string', description: '对方的鱼塘地址，如 http://192.168.1.20:11834' },
        fishId: { type: 'string', description: '可选：派哪条鱼去（id 或名字），默认随机' },
      },
      required: ['endpoint'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => toolText(value && value.text ? value.text : '鱼没游出去'),
    },
    async execute(args) {
      const result = await exclusive(async () => outboundVisit(ctx, await loadState(), {
        endpoint: args.endpoint,
        fishId: args.fishId,
      }))
      const lines = (result.encounter && result.encounter.lines) || []
      return {
        text: [
          `${result.traveler.name} 游到了「${result.pond.name}」，和 ${result.host.name} 聊了「${result.encounter.topic}」`,
          ...lines.map((line) => `${line.name}：${line.text}`),
          `关系：${result.edge.label}（${result.edge.weight}）`,
        ].join('\n'),
        encounter: result.encounter,
        edge: result.edge,
      }
    },
  }))

  disposers.push(tools.register({
    name: 'yuquan_feedback',
    description: '看塘主在鱼圈面板「反馈」里留下的问题/建议。可以只看没处理过的，也可以把某条标成已处理。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'resolve'], description: 'list=列出来（默认），resolve=把某条标成已处理' },
        limit: { type: 'number', description: 'list 时最多返回几条，默认 10' },
        id: { type: 'string', description: 'resolve 时要标记的反馈 id' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => toolText(value && value.text ? value.text : '没有反馈'),
    },
    async execute(args) {
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 10))
      if (args.action === 'resolve') {
        return exclusive(async () => {
          const state = await loadState()
          const id = clip(args.id, 32)
          const item = (state.feedbacks || []).find((one) => one.id === id)
          if (!item) throw new Error(`没有 id 为 ${id} 的反馈`)
          item.answered = true
          await saveState(state)
          return { text: `已标记为处理过：${item.text}`, id }
        })
      }
      return exclusive(async () => {
        const state = await loadState()
        const all = Array.isArray(state.feedbacks) ? state.feedbacks : []
        const pending = all.filter((one) => !one.answered)
        const picked = (pending.length ? pending : all).slice(-limit).reverse()
        if (!picked.length) return { text: '还没有人留反馈', total: all.length, pending: 0 }
        const lines = picked.map((one) => {
          const when = new Date(one.at).toLocaleString('zh-CN', { hour12: false })
          return `[${one.id}] ${when}${one.answered ? '（已处理）' : ''}：${one.text}`
        })
        return {
          text: `反馈 ${all.length} 条，其中没处理 ${pending.length} 条：\n${lines.join('\n')}`,
          items: picked,
          total: all.length,
          pending: pending.length,
        }
      })
    },
  }))

  return () => {
    for (const dispose of disposers) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* 忽略 */
      }
    }
  }
}

function nameOf(state, id) {
  const fish = state.fish.find((f) => f.id === id)
  return fish ? fish.name : id
}

/* ------------------------------------------------------------------ */

export function apply(ctx) {
  return ctx.effect(() => {
    const disposeRoutes = registerRoutes(ctx)
    const disposeTools = registerTools(ctx)
    return () => {
      disposeRoutes()
      disposeTools()
    }
  })
}
