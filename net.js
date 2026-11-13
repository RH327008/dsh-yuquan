/**
 * 鱼圈的地址层：塘号、可读地址、签名信封、邀请码。
 *
 * 设计原则：
 * 1. 用户只记 6 位数字（塘号），不再记 IP。塘号由 pondId 稳定推导，换机器不变。
 * 2. 每座塘有一对 Ed25519 密钥，出门的信封用私钥签，收信方用对方公钥验——
 *    公钥由中转站随心跳发布，所以「是谁说的」不再靠对方自报。
 * 3. 邀请码是塘主签的名片：有效期 + 一次性口令，用来绕过白名单/打烊。
 *
 * 这个文件不碰 ctx、不碰磁盘，纯函数，node --test 可以直接跑。
 */
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
} from 'node:crypto'

export const ADDRESS_SCHEME = 'fishpond'
export const POND_CODE_RE = /^\d{6}$/
export const INVITE_PREFIX = 'INV1.'
export const ENVELOPE_VERSION = 1
export const MAX_ENVELOPE_BYTES = 24 * 1024
export const MAX_CLOCK_SKEW_MS = 5 * 60_000

/* ------------------------------------------------------------------ */
/* 塘号                                                                */
/* ------------------------------------------------------------------ */

/** pondId → 6 位塘号。同一座塘永远同一个号；不同塘撞号概率约 1/1e6。 */
export function pondCodeOf(pondId) {
  const digest = createHash('sha256').update(`yuquan-code:${String(pondId)}`).digest()
  const value = digest.readUInt32BE(0) % 1_000_000
  return String(value).padStart(6, '0')
}

/** 塘号 → 展示用地址：fishpond://483920 */
export function formatAddress(code) {
  const text = String(code || '').trim()
  if (!POND_CODE_RE.test(text)) throw new Error('塘号是 6 位数字')
  return `${ADDRESS_SCHEME}://${text}`
}

/**
 * 用户可能输入：`483920`、`#483920`、`fishpond://483920`、`483920 阿肥`、
 * 甚至一段介绍文字里的号。只认第一段 6 位数字，其余忽略。
 * 返回 { code, address } 或 null。
 */
export function parseAddress(input) {
  const text = String(input || '').trim()
  if (!text) return null
  const match = /(?:^|[^\d])(\d{6})(?!\d)/.exec(text)
  if (!match) return null
  return { code: match[1], address: formatAddress(match[1]) }
}

/** 邀请码里带对方的塘号，方便 UI 直接显示「这是 483920 的邀请」。 */
export function codeFromInvite(token) {
  const parsed = decodeInvite(token)
  return parsed ? parsed.code : null
}

/* ------------------------------------------------------------------ */
/* 密钥与签名                                                          */
/* ------------------------------------------------------------------ */

/** 生成一对塘密钥。公钥进中转站，私钥只留在本地 pond.json。 */
export function createPondKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  }
}

function privateKeyObject(base64) {
  return { key: Buffer.from(String(base64 || ''), 'base64'), format: 'der', type: 'pkcs8' }
}

function publicKeyObject(base64) {
  return { key: Buffer.from(String(base64 || ''), 'base64'), format: 'der', type: 'spki' }
}

/** 信封的规范字节：字段顺序固定，参与签名的就只有这些。 */
export function canonicalEnvelope(envelope) {
  const body = envelope && envelope.body && typeof envelope.body === 'object' ? envelope.body : {}
  return JSON.stringify({
    v: ENVELOPE_VERSION,
    from: String(envelope.from || ''),
    to: String(envelope.to || ''),
    at: Number(envelope.at) || 0,
    nonce: String(envelope.nonce || ''),
    body,
  })
}

/**
 * 打一个信封：{ v, from, to, at, nonce, body, sig }。
 * from/to 都是塘号（6 位数字），body 是业务数据（鱼证、寒暄、回执……）。
 */
export function sealEnvelope(privateKey, { from, to, body, now = Date.now(), nonce }) {
  if (!POND_CODE_RE.test(String(from || ''))) throw new Error('发信塘号不合法')
  if (!POND_CODE_RE.test(String(to || ''))) throw new Error('收信塘号不合法')
  const envelope = {
    v: ENVELOPE_VERSION,
    from: String(from),
    to: String(to),
    at: Number(now),
    nonce: String(nonce || randomBytes(9).toString('base64url')),
    body: body && typeof body === 'object' ? body : {},
  }
  const bytes = canonicalEnvelope(envelope)
  if (Buffer.byteLength(bytes, 'utf8') > MAX_ENVELOPE_BYTES) throw new Error('信封太大了，鱼带不动')
  envelope.sig = cryptoSign(null, Buffer.from(bytes, 'utf8'), privateKeyObject(privateKey)).toString('base64')
  return envelope
}

/**
 * 验信封：签名、时间窗、收发塘号。
 * 返回 { ok:true } 或 { ok:false, reason }，调用方决定是拒是记日志。
 */
export function openEnvelope(publicKey, envelope, { expectTo, now = Date.now(), skewMs = MAX_CLOCK_SKEW_MS } = {}) {
  if (!envelope || typeof envelope !== 'object') return { ok: false, reason: 'empty' }
  if (envelope.v !== ENVELOPE_VERSION) return { ok: false, reason: 'version' }
  if (!POND_CODE_RE.test(String(envelope.from || ''))) return { ok: false, reason: 'from' }
  if (!POND_CODE_RE.test(String(envelope.to || ''))) return { ok: false, reason: 'to' }
  if (expectTo && envelope.to !== expectTo) return { ok: false, reason: 'wrong-pond' }
  const at = Number(envelope.at) || 0
  if (Math.abs(now - at) > skewMs) return { ok: false, reason: 'clock' }
  if (typeof envelope.sig !== 'string' || !envelope.sig) return { ok: false, reason: 'sig-missing' }
  const bytes = Buffer.from(canonicalEnvelope(envelope), 'utf8')
  let good = false
  try {
    good = cryptoVerify(null, bytes, publicKeyObject(publicKey), Buffer.from(envelope.sig, 'base64'))
  } catch {
    good = false
  }
  return good ? { ok: true } : { ok: false, reason: 'sig' }
}

/* ------------------------------------------------------------------ */
/* 邀请码                                                              */
/* ------------------------------------------------------------------ */

/**
 * 邀请码：INV1.<base64url(payload)>.<hmac>
 * payload = { code, exp, by }，用本塘 secret 签；
 * 对方拿着它就能进一次门，绕过白名单与打烊。
 */
export function mintInvite(secret, { code, ttlMs = 24 * 3600_000, now = Date.now(), by = '' } = {}) {
  if (!POND_CODE_RE.test(String(code || ''))) throw new Error('邀请码要带上本塘号')
  if (!secret) throw new Error('本塘还没有 secret，先初始化')
  const payload = Buffer.from(JSON.stringify({
    code: String(code),
    exp: Math.floor((now + Math.max(60_000, Number(ttlMs) || 0)) / 1000),
    by: String(by || '').slice(0, 24),
  }), 'utf8').toString('base64url')
  const mac = createHmac('sha256', String(secret)).update(`${INVITE_PREFIX}${payload}`).digest('base64url').slice(0, 22)
  return `${INVITE_PREFIX}${payload}.${mac}`
}

export function decodeInvite(token) {
  const text = String(token || '').trim()
  if (!text.startsWith(INVITE_PREFIX)) return null
  const rest = text.slice(INVITE_PREFIX.length)
  const dot = rest.lastIndexOf('.')
  if (dot <= 0) return null
  try {
    const payload = JSON.parse(Buffer.from(rest.slice(0, dot), 'base64url').toString('utf8'))
    if (!payload || !POND_CODE_RE.test(String(payload.code || ''))) return null
    return { code: String(payload.code), exp: Number(payload.exp) || 0, by: String(payload.by || ''), mac: rest.slice(dot + 1) }
  } catch {
    return null
  }
}

/** 校验邀请码：签名对、没过期、塘号对得上。 */
export function checkInvite(secret, token, { code, now = Date.now() } = {}) {
  const parsed = decodeInvite(token)
  if (!parsed) return { ok: false, reason: 'malformed' }
  if (code && parsed.code !== String(code)) return { ok: false, reason: 'wrong-pond' }
  const expected = createHmac('sha256', String(secret || '')).update(`${INVITE_PREFIX}${Buffer.from(JSON.stringify({
    code: parsed.code,
    exp: parsed.exp,
    by: parsed.by,
  }), 'utf8').toString('base64url')}`).digest('base64url').slice(0, 22)
  const a = Buffer.from(parsed.mac || '')
  const b = Buffer.from(expected)
  const macOk = a.length === b.length && timingSafeEqual(a, b)
  if (!macOk) return { ok: false, reason: 'mac' }
  if (parsed.exp * 1000 < now) return { ok: false, reason: 'expired' }
  return { ok: true, code: parsed.code, by: parsed.by }
}

/** 塘里所有对外的东西都从这里取，别处不要再各自拼。 */
export function publicPondCard(state) {
  const pond = state.pond || {}
  return {
    protocol: 'yuquan/2',
    code: pond.code,
    address: pond.code ? `${ADDRESS_SCHEME}://${pond.code}` : null,
    name: pond.name,
    id: pond.id,
    relay: pond.relay || null,
    endpoint: pond.endpoint || null,
    allowVisitors: pond.allowVisitors !== false,
    inviteOnly: Boolean(pond.inviteOnly),
    quotaPerDay: Number(pond.quotaPerDay) || 0,
    nightClose: pond.nightClose ? { ...pond.nightClose } : null,
  }
}
