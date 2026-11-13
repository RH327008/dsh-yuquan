/**
 * 鱼圈中转客户端：本地没有公网 IP 时，靠「心跳 + 信箱」和外面的塘通信。
 *
 *   每 30 秒：POST /v1/hello，把 {塘号, endpoint, 公钥} 报给中转站（对方据此找到我）
 *   每 5 秒 ：GET /v1/inbox 取信，逐封验签后交给 onEnvelope
 *   要寄信 ：POST /v1/deliver；失败就留在 outbox 里，下一次心跳顺带重试
 *
 * 中转站只送包裹，不验内容——验签在这里做，所以中转站被换掉也伪造不了别人的鱼证。
 * 纯 Node 内置能力，不依赖 ctx。
 */
import { openEnvelope, sealEnvelope } from '../net.js'

const HEARTBEAT_MS = 30_000
const POLL_MS = 5_000
const FETCH_TIMEOUT_MS = 8_000
const OUTBOX_MAX = 20
const PUB_CACHE_MS = 5 * 60_000

function trimBase(url) {
  return String(url || '').trim().replace(/\/+$/, '')
}

export function createRelayClient({
  url,
  code,
  endpoint,
  keyPair,
  onEnvelope = () => {},
  fetchImpl = globalThis.fetch,
  heartbeatMs = HEARTBEAT_MS,
  pollMs = POLL_MS,
  log = () => {},
} = {}) {
  const base = trimBase(url)
  const selfCode = String(code || '')
  const outbox = []                 // 待投递的信封，失败留着下次重试
  const pubCache = new Map()        // code -> { pub, at }
  let heartbeatTimer = null
  let pollTimer = null
  let inflight = false
  let lastGoodAt = 0
  let lastError = ''

  const ready = () => Boolean(base && selfCode && keyPair && keyPair.privateKey && fetchImpl)

  async function call(path, options = {}) {
    const response = await fetchImpl(`${base}${path}`, {
      method: options.method || 'GET',
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error = new Error(payload && payload.error ? payload.error : `中转站回了 ${response.status}`)
      error.status = response.status
      throw error
    }
    return payload
  }

  async function hello() {
    if (!ready()) return null
    try {
      const payload = await call('/v1/hello', {
        method: 'POST',
        body: { code: selfCode, endpoint, pub: keyPair.publicKey },
      })
      lastGoodAt = Date.now()
      lastError = ''
      return payload
    } catch (error) {
      lastError = String((error && error.message) || error)
      log('[relay] 心跳失败', lastError)
      return null
    }
  }

  /** 查对方的地址簿条目（endpoint + 公钥）。缓存 5 分钟。 */
  async function resolve(code) {
    const target = String(code || '')
    if (!/^\d{6}$/.test(target)) throw new Error('塘号是 6 位数字')
    const cached = pubCache.get(target)
    if (cached && Date.now() - cached.at < PUB_CACHE_MS) return cached.peer
    if (!ready()) throw new Error('还没有配置中转站')
    const payload = await call(`/v1/peers/${target}`)
    const peer = payload && payload.peer ? payload.peer : null
    if (!peer || !peer.pub) throw new Error('这个塘号现在不在线')
    pubCache.set(target, { peer, at: Date.now() })
    return peer
  }

  async function deliver(envelope) {
    if (!ready()) throw new Error('还没有配置中转站')
    return call('/v1/deliver', { method: 'POST', body: { to: envelope.to, envelope } })
  }

  async function flushOutbox() {
    if (!outbox.length) return { sent: 0, left: 0 }
    const keep = []
    let sent = 0
    for (const envelope of outbox) {
      try {
        await deliver(envelope)
        sent += 1
      } catch (error) {
        // 对方信箱满（429）也先留着，下一次心跳再试。
        keep.push(envelope)
        log('[relay] 这封信先留着', String((error && error.message) || error))
      }
    }
    outbox.length = 0
    outbox.push(...keep.slice(0, OUTBOX_MAX))
    return { sent, left: outbox.length }
  }

  /** 寄一封：立刻送，送不掉就进 outbox。 */
  async function send({ to, body, now }) {
    const envelope = sealEnvelope(keyPair.privateKey, { from: selfCode, to, body, now })
    try {
      await deliver(envelope)
      return { ok: true, queued: false, envelope }
    } catch (error) {
      if (outbox.length >= OUTBOX_MAX) outbox.shift()
      outbox.push(envelope)
      return { ok: true, queued: true, envelope, error: String((error && error.message) || error) }
    }
  }

  /** 取一次信：验签通过才交给 onEnvelope；验不过的原样退回，记在今天谁被拒了。 */
  async function poll() {
    if (!ready() || inflight) return { accepted: 0, rejected: 0 }
    inflight = true
    let accepted = 0
    let rejected = 0
    try {
      const payload = await call(`/v1/inbox?code=${encodeURIComponent(selfCode)}`)
      lastGoodAt = Date.now()
      for (const envelope of (payload && payload.messages) || []) {
        const from = String(envelope && envelope.from)
        if (!/^\d{6}$/.test(from)) {
          rejected += 1
          continue
        }
        let pub = pubCache.get(from) && pubCache.get(from).pub
        if (!pub) {
          try {
            const peer = await resolve(from)
            pub = peer.pub
          } catch {
            pub = null
          }
        }
        const checked = pub ? openEnvelope(pub, envelope, { expectTo: selfCode }) : { ok: false, reason: 'no-pubkey' }
        if (!checked.ok) {
          rejected += 1
          log('[relay] 收到一封来路不明的信，丢掉：', checked.reason)
          continue
        }
        accepted += 1
        try {
          await onEnvelope(envelope)
        } catch (error) {
          log('[relay] 处理来信失败：', String((error && error.message) || error))
        }
      }
      await flushOutbox()
    } catch (error) {
      lastError = String((error && error.message) || error)
    } finally {
      inflight = false
    }
    return { accepted, rejected }
  }

  function start() {
    if (!ready()) return false
    if (heartbeatTimer || pollTimer) return true
    heartbeatTimer = setInterval(() => { hello() }, heartbeatMs)
    pollTimer = setInterval(() => { poll() }, pollMs)
    if (heartbeatTimer.unref) heartbeatTimer.unref()
    if (pollTimer.unref) pollTimer.unref()
    hello()
    poll()
    return true
  }

  function stop() {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    if (pollTimer) clearInterval(pollTimer)
    heartbeatTimer = null
    pollTimer = null
  }

  function status() {
    return {
      configured: Boolean(base),
      code: selfCode || null,
      endpoint: endpoint || null,
      running: Boolean(heartbeatTimer),
      online: lastGoodAt > 0 && Date.now() - lastGoodAt < HEARTBEAT_MS * 3,
      lastGoodAt: lastGoodAt || null,
      lastError: lastError || null,
      outbox: outbox.length,
    }
  }

  return { start, stop, status, hello, poll, resolve, send, deliver, flushOutbox, get outbox() { return outbox } }
}
