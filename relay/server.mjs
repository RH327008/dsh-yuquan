/**
 * 鱼圈中转站（最小可用版）：给没有公网 IP 的鱼塘做「地址簿 + 信箱」。
 *
 *   POST /v1/hello            心跳：登记 塘号 → {endpoint, 公钥}
 *   GET  /v1/peers/:code      查地址簿（对方在线吗、公钥是什么）
 *   POST /v1/deliver          投递一个签名信封到对方的信箱
 *   GET  /v1/inbox?code=      取信（取走即删）
 *   GET  /v1/health           健康检查
 *
 * 它不读信封内容、不验签（验签在收信方本地做，因此中转站被攻破也伪造不了鱼证），
 * 只负责「谁在哪」和「把包裹放到对方门口」。内存存储，重启即清空。
 *
 * 跑起来：node relay/server.mjs --port 8787
 */
import { createServer } from 'node:http'

const PEER_TTL_MS = 90_000      // 心跳 30 秒一次，90 秒没动静就当它下线
const MAIL_TTL_MS = 10 * 60_000 // 信件最多躺 10 分钟
const MAIL_MAX = 50             // 每个塘最多压 50 封，防止被灌满
const BODY_LIMIT = 64 * 1024
const CODE_RE = /^\d{6}$/

const peers = new Map()   // code -> {code, name, endpoint, pub, at}
const inbox = new Map()   // code -> [{env, at}]

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('bad json'))
      }
    })
    req.on('error', reject)
  })
}

function sweep(now = Date.now()) {
  for (const [code, peer] of peers) {
    if (now - peer.at > PEER_TTL_MS) peers.delete(code)
  }
  for (const [code, list] of inbox) {
    const kept = list.filter((item) => now - item.at <= MAIL_TTL_MS)
    if (kept.length) inbox.set(code, kept)
    else inbox.delete(code)
  }
}

function queueFor(code) {
  let list = inbox.get(code)
  if (!list) {
    list = []
    inbox.set(code, list)
  }
  return list
}

export function createRelayServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://relay.local')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    sweep()
    try {
      if (path === '/v1/health' && req.method === 'GET') {
        return json(res, 200, { ok: true, peers: peers.size, now: Date.now() })
      }

      if (path === '/v1/hello' && req.method === 'POST') {
        const body = await readJson(req)
        const code = String(body.code || '').trim()
        if (!CODE_RE.test(code)) return json(res, 400, { error: '塘号得是 6 位数字' })
        const endpoint = String(body.endpoint || '').slice(0, 200)
        const pub = String(body.pub || '').slice(0, 200)
        if (!endpoint || !pub) return json(res, 400, { error: '缺 endpoint 或公钥' })
        peers.set(code, {
          code,
          name: String(body.name || '').slice(0, 40),
          endpoint,
          pub,
          at: Date.now(),
        })
        return json(res, 200, { ok: true, ttl: PEER_TTL_MS, peers: peers.size })
      }

      if (path.startsWith('/v1/peers/') && req.method === 'GET') {
        const code = path.slice('/v1/peers/'.length)
        const peer = peers.get(code)
        if (!peer) return json(res, 404, { error: '这个塘号现在不在线' })
        return json(res, 200, { ok: true, peer })
      }

      if (path === '/v1/deliver' && req.method === 'POST') {
        const body = await readJson(req)
        const to = String(body.to || '').trim()
        const env = body.envelope
        if (!CODE_RE.test(to)) return json(res, 400, { error: '收信塘号不合法' })
        if (!env || typeof env !== 'object' || env.to !== to) {
          return json(res, 400, { error: '信封和收信塘号对不上' })
        }
        const list = queueFor(to)
        if (list.length >= MAIL_MAX) return json(res, 429, { error: '对方信箱满了，晚点再送' })
        list.push({ env, at: Date.now() })
        return json(res, 200, { ok: true, queued: list.length, online: peers.has(to) })
      }

      if (path === '/v1/inbox' && req.method === 'GET') {
        const code = String(url.searchParams.get('code') || '').trim()
        if (!CODE_RE.test(code)) return json(res, 400, { error: '塘号不合法' })
        const list = inbox.get(code) || []
        inbox.delete(code)
        return json(res, 200, { ok: true, messages: list.map((item) => item.env) })
      }

      return json(res, 404, { error: '没有这个接口' })
    } catch (error) {
      return json(res, 400, { error: String((error && error.message) || error).slice(0, 120) })
    }
  })
}

const isMain = process.argv[1] && /relay[\\/]server\.mjs$/.test(process.argv[1])
if (isMain) {
  const portFlag = process.argv.indexOf('--port')
  const port = portFlag > 0 ? Number(process.argv[portFlag + 1]) : 8787
  const server = createRelayServer()
  server.listen(port, () => {
    console.log(`鱼圈中转站起来了：http://127.0.0.1:${port}`)
    console.log('把这个地址填进鱼塘设置里的「中转站」，就能和不同局域网的塘互通。')
  })
}
