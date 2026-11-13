/**
 * 鱼圈 — Client 半边（v2）。
 *
 * 一个「只有 AI 的鱼塘」面板：池子、关系网（Obsidian 式双链）、鱼证、跨圈串门。
 * 纯浏览器脚本，由 window.__ModuleLoader__ 装载，不依赖任何 @deepseek-ai/* 包。
 */
window.__ModuleLoader__.load({
  id: 'dsh-yuquan',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const PANEL_KEY = 'yuquan'
    const API_BASE = 'yuquan/api'
    /* 和服务端 CUSTOM_SKIN_LIMIT 对齐：客户端只拿来提示，真正的上限还是服务端说了算。 */
    const CUSTOM_SKIN_LIMIT = 24

    /* ---------------------------------------------------------------- */
    /* 后端访问                                                          */
    /* ---------------------------------------------------------------- */

    let preferredEndpoint = null

    function apiPath(name) {
      const relative = `${API_BASE}/${String(name).replace(/^\/+/, '')}`
      if (typeof document === 'undefined') return `/${relative}`
      try {
        return new URL(relative, document.baseURI).pathname
      } catch {
        return `/${relative}`
      }
    }

    function candidateUrls(name) {
      const path = apiPath(name)
      // 先试相对路径：桌面端是 dsh-app:// 源，这条会被宿主代理到本地 server；
      // 再退到绝对地址，用于浏览器里打开 http://127.0.0.1:11834 的场景。
      const list = [path]
      if (preferredEndpoint) list.push(preferredEndpoint + path)
      list.push(`http://127.0.0.1:11834${path}`)
      return Array.from(new Set(list))
    }

    // 图片地址：state 里给的是站内绝对路径。在 dsh-app:// 这类自定义源下，
    // <image href> 未必被代理到宿主路由，所以和 API 一样退到本机 http 地址。
    function imageUrl(url) {
      if (!url || typeof url !== 'string') return undefined
      if (/^(https?:|data:|blob:)/i.test(url)) return url
      const pageIsHttp = typeof location !== 'undefined' && /^https?:$/.test(location.protocol)
      if (pageIsHttp) return url
      return (preferredEndpoint || 'http://127.0.0.1:11834') + url
    }

    async function callApi(method, name, body) {
      const urls = candidateUrls(name)
      let lastError = null
      for (const url of urls) {
        let response = null
        try {
          response = await fetch(url, {
            method,
            headers: body ? { 'content-type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
          })
        } catch (error) {
          // 连不上（比如桌面端 dsh-app:// 下的相对地址）才换下一个候选。
          lastError = error
          continue
        }
        const text = await response.text().catch(() => '')
        let data = null
        try {
          data = text ? JSON.parse(text) : null
        } catch {
          // 回的不是 JSON：多半是某个候选地址打到了静态页，换下一个再试。
          lastError = new Error(response.ok ? '返回的不是 JSON' : `HTTP ${response.status}`)
          if (!response.ok) continue
          throw lastError
        }
        // 服务端已经答话了（哪怕是 4xx/5xx），它的中文提示就是最终答案，别再换地址重试，
        // 否则真正的错误会被下一个候选的连接失败顶掉。
        if (!response.ok) throw new Error((data && data.error) || `HTTP ${response.status}`)
        const match = /^(https?:\/\/[^/]+)/.exec(url)
        if (match) preferredEndpoint = match[1]
        return data
      }
      throw lastError || new Error('鱼塘连不上')
    }

    /* ---------------------------------------------------------------- */
    /* 小工具                                                            */
    /* ---------------------------------------------------------------- */

    function fmtAgo(at) {
      if (!at) return ''
      const diff = Date.now() - at
      if (diff < 60_000) return '刚刚'
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
      return `${Math.floor(diff / 86_400_000)} 天前`
    }

    function shade(hex, amount) {
      const source = String(hex || '#8fb8d8').replace('#', '')
      const full = source.length === 3 ? source.split('').map((c) => c + c).join('') : source
      const num = parseInt(full, 16)
      const r = Math.min(255, Math.max(0, ((num >> 16) & 255) + amount))
      const g = Math.min(255, Math.max(0, ((num >> 8) & 255) + amount))
      const b = Math.min(255, Math.max(0, (num & 255) + amount))
      return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
    }

    function hashSeed(text) {
      let hash = 2166136261
      const str = String(text || '')
      for (let i = 0; i < str.length; i += 1) {
        hash ^= str.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
      }
      return Math.abs(hash)
    }

    const TRAITS = [
      ['vitality', '活力'],
      ['talkative', '话痨'],
      ['affinity', '亲和'],
      ['greedy', '贪吃'],
      ['dramatic', '戏精'],
    ]

    /* ---------------------------------------------------------------- */
    /* 鱼的美术                                                          */
    /* ---------------------------------------------------------------- */

    /* 塘主挑的一张图 → data URL：长边压到 320、转 JPEG，顺手算个平均色当皮肤底色。
       图只存在这台机器上（$DSH_HOME/yuquan/skins），面板每次只拿到一个可以当 href 的地址。 */
    function readImageFile(file) {
      return new Promise((resolve, reject) => {
        if (!file || !/^image\//.test(String(file.type || ''))) {
          reject(new Error('这个文件不是图片'))
          return
        }
        if (file.size > 8 * 1024 * 1024) {
          reject(new Error('图片比 8MB 还大，先压一下再导'))
          return
        }
        const reader = new FileReader()
        reader.onerror = () => reject(new Error('这张图读不出来'))
        reader.onload = () => {
          const img = new Image()
          img.onerror = () => reject(new Error('这张图打不开，换个格式试试'))
          img.onload = () => {
            const side = 320
            const natural = Math.max(img.width || side, img.height || side)
            const scale = Math.min(1, side / natural)
            const width = Math.max(1, Math.round((img.width || side) * scale))
            const height = Math.max(1, Math.round((img.height || side) * scale))
            const canvas = document.createElement('canvas')
            canvas.width = width
            canvas.height = height
            const ctx = canvas.getContext('2d')
            if (!ctx) {
              reject(new Error('这台机器画不了图'))
              return
            }
            ctx.fillStyle = '#0b1720'
            ctx.fillRect(0, 0, width, height)
            ctx.drawImage(img, 0, 0, width, height)
            const dataUrl = canvas.toDataURL('image/jpeg', 0.82)
            let tint = '#7fd8c4'
            try {
              const pixels = ctx.getImageData(0, 0, width, height).data
              let r = 0
              let g = 0
              let b = 0
              let n = 0
              for (let i = 0; i < pixels.length; i += 28) {
                r += pixels[i]
                g += pixels[i + 1]
                b += pixels[i + 2]
                n += 1
              }
              if (n) {
                tint = `#${[r / n, g / n, b / n].map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`
              }
            } catch {
              /* 拿不到像素就退回默认色，不影响导图 */
            }
            const title = String(file.name || '').replace(/\.[a-z0-9]+$/i, '').slice(0, 12)
            resolve({ dataUrl, color: tint, title: title || '自定义', width, height, bytes: Math.round((dataUrl.length * 3) / 4) })
          }
          img.src = String(reader.result || '')
        }
        reader.readAsDataURL(file)
      })
    }

    function FishGlyph({ color, size = 1, species = '', className, image }) {
      const base = color || '#8fb8d8'
      const deep = shade(base, -46)
      const dark = shade(base, -64)
      const light = shade(base, 42)
      const photo = typeof image === 'string' && image ? image : ''
      const uid = useMemo(
        () => `yqf${hashSeed(`${base}|${species}|${size}|${photo}`).toString(36)}`,
        [base, species, size, photo],
      )
      const label = String(species || '')
      const fancy = label.indexOf('斗') >= 0
      const koi = label.indexOf('鲤') >= 0
      const neon = label.indexOf('霓虹') >= 0
      const width = Math.round((fancy ? 66 : 60) * size)
      const height = Math.round(width * 0.6)

      const scales = []
      for (let row = 0; row < 3; row += 1) {
        for (let col = 0; col < 5; col += 1) {
          scales.push(h('path', {
            key: `scale-${row}-${col}`,
            d: `M${23 + col * 7.2 + (row % 2) * 3.6} ${15.5 + row * 5.6} q3.4 3.6 6.8 0`,
            fill: 'none',
            stroke: light,
            strokeWidth: 0.85,
            opacity: 0.42,
          }))
        }
      }

      return h('svg', {
        viewBox: '0 0 66 46',
        width,
        height,
        className,
        'aria-hidden': 'true',
        style: { overflow: 'visible' },
      },
      h('defs', null,
        h('linearGradient', { id: `${uid}-body`, x1: '0', y1: '0', x2: '0.15', y2: '1' },
          h('stop', { offset: '0%', stopColor: light }),
          h('stop', { offset: '38%', stopColor: base }),
          h('stop', { offset: '78%', stopColor: shade(base, -12) }),
          h('stop', { offset: '100%', stopColor: deep })),
        h('linearGradient', { id: `${uid}-fin`, x1: '0', y1: '0', x2: '1', y2: '1' },
          h('stop', { offset: '0%', stopColor: shade(base, -6) }),
          h('stop', { offset: '60%', stopColor: deep }),
          h('stop', { offset: '100%', stopColor: dark })),
        h('radialGradient', { id: `${uid}-sheen`, cx: '0.35', cy: '0.28', r: '0.62' },
          h('stop', { offset: '0%', stopColor: '#ffffff', stopOpacity: '0.55' }),
          h('stop', { offset: '100%', stopColor: '#ffffff', stopOpacity: '0' })),
        photo
          ? h('pattern', {
              id: `${uid}-photo`,
              patternUnits: 'userSpaceOnUse',
              x: 16.4, y: 11.2, width: 39.2, height: 23.6,
            },
            h('image', {
              href: photo,
              x: 16.4, y: 11.2, width: 39.2, height: 23.6,
              preserveAspectRatio: 'xMidYMid slice',
            }))
          : null,
        h('clipPath', { id: `${uid}-clip` },
          h('ellipse', { cx: 36, cy: 23, rx: 19.6, ry: 11.8 }))),

      h('g', { className: 'yq-fish-body' },
        // 尾鳍：斗鱼大扇尾，锦鲤长飘带，其余两瓣尾
        h('g', { className: 'yq-tail' },
          h('path', {
            d: fancy
              ? 'M19 23 C10 12 4 2 0.5 0.5 C6.5 11 8.6 17.5 8.8 23 C8.6 28.5 6.5 35 0.5 45.5 C4 44 10 34 19 23 Z'
              : koi
                ? 'M18 23 C13 18.5 8 14.5 2.5 12 C6.5 16.8 8.4 20 8.4 23 C8.4 26 6.5 29.2 2.5 34 C8 31.5 13 27.5 18 23 Z'
                : 'M18 23 C11 16.5 6 10.5 2 6.5 C6.5 14 8 19 8 23 C8 27 6.5 32 2 39.5 C6 35.5 11 29.5 18 23 Z',
            fill: shade(base, -30),
            opacity: 0.92,
          }),
          h('path', {
            d: fancy
              ? 'M14 23 C10 18 7 13 5.5 10 M14 23 C11 26.5 8 30 5.5 33'
              : 'M14 23 C10.5 19 8.5 16 7.5 13.5 M14 23 C10.5 27 8.5 30 7.5 32.5',
            fill: 'none',
            stroke: light,
            strokeWidth: 0.9,
            opacity: 0.35,
          })),

        // 背鳍 / 胸鳍
        h('path', {
          d: 'M27 12.4 C31.5 5.4 41 4.6 46 8.2 C39.5 8.6 33 10.6 29.8 13.6 Z',
          fill: shade(base, -20),
          opacity: 0.72,
        }),
        h('ellipse', {
          cx: 30.4, cy: 30.6, rx: 5.8, ry: 3.3,
          fill: shade(base, -6), opacity: 0.5,
          transform: 'rotate(-24 30.4 30.6)',
        }),

        // 身体：有图就把图铺进身体轮廓，没图就用配色渐变
        h('ellipse', {
          cx: 36, cy: 23, rx: 19.6, ry: 11.8,
          fill: photo ? `url(#${uid}-photo)` : `url(#${uid}-body)`,
        }),

        // 鳞片 + 高光（裁切在身体里）
        h('g', { clipPath: `url(#${uid}-clip)` },
          photo ? null : scales,
          h('ellipse', { cx: 33, cy: 15.5, rx: 13, ry: 5.4, fill: `url(#${uid}-sheen)` }),
          h('ellipse', { cx: 37, cy: 30.5, rx: 13.5, ry: 3.2, fill: deep, opacity: 0.28 }),
          photo ? h('ellipse', { cx: 36, cy: 23, rx: 19.6, ry: 11.8, fill: base, opacity: 0.14 }) : null,
          koi && !photo
            ? h('g', { opacity: 0.62 },
                h('ellipse', { cx: 31, cy: 18.5, rx: 6.2, ry: 4.4, fill: deep, transform: 'rotate(-14 31 18.5)' }),
                h('ellipse', { cx: 44.5, cy: 27.5, rx: 4.6, ry: 3.2, fill: deep, fillOpacity: 0.8, transform: 'rotate(18 44.5 27.5)' }),
                h('ellipse', { cx: 38, cy: 35, rx: 3.4, ry: 2, fill: deep, fillOpacity: 0.55 }))
            : null,
          neon && !photo
            ? h('g', null,
                h('path', { d: 'M19.5 21.4 C28 17.6 40 17.6 52.5 21.2', stroke: '#c9f4ff', strokeWidth: 3.2, fill: 'none', opacity: 0.55, strokeLinecap: 'round' }),
                h('path', { d: 'M20 24.6 C28 26.6 40 26.6 52 24.4', stroke: '#ff8fa3', strokeWidth: 1.9, fill: 'none', opacity: 0.6, strokeLinecap: 'round' }))
            : null,
          h('path', { d: 'M20 14.6 C28 6.8 45 6.6 53.4 14.4', stroke: '#ffffff', strokeWidth: 1.5, fill: 'none', opacity: 0.34, strokeLinecap: 'round' })),

        // 描边、鳃、嘴、须
        h('ellipse', { cx: 36, cy: 23, rx: 19.6, ry: 11.8, fill: 'none', stroke: dark, strokeWidth: 0.8, opacity: 0.32 }),
        h('path', { d: 'M44.5 14.6 C42.4 19.4 42.4 26.4 45.4 31', stroke: dark, strokeWidth: 0.9, fill: 'none', opacity: 0.22 }),
        h('path', { d: 'M55.2 22.6 q2.4 1.4 3.9.4', stroke: dark, strokeWidth: 1, fill: 'none', opacity: 0.45, strokeLinecap: 'round' }),
        koi
          ? h('g', { stroke: dark, strokeWidth: 0.9, fill: 'none', opacity: 0.4, strokeLinecap: 'round' },
              h('path', { d: 'M55 21.6 q4 -2.6 6.4 -3.4' }),
              h('path', { d: 'M55 24.4 q4 2.6 6.4 3.4' }))
          : null,

        // 眼睛
        h('g', null,
          h('circle', { cx: 47.6, cy: 19.4, r: 3.1, fill: '#0a1a22' }),
          h('circle', { cx: 47.6, cy: 19.4, r: 2.2, fill: shade(base, -58) }),
          h('circle', { cx: 48.5, cy: 18.5, r: 1.05, fill: '#ffffff', opacity: 0.95 }),
          h('circle', { cx: 46.6, cy: 20.6, r: 0.42, fill: '#ffffff', opacity: 0.55 }),
          h('path', { d: 'M44.8 16.4 q2.8 -1.5 5.6 -0.2', stroke: dark, strokeWidth: 0.8, fill: 'none', opacity: 0.3 }))))
    }

    function SidebarFish({ size, active }) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: typeof size === 'number' ? size : 20,
          height: typeof size === 'number' ? size : 20,
          fill: 'none',
          'aria-hidden': 'true',
          style: { opacity: active ? 1 : 0.86 },
        },
        h('path', {
          d: 'M3.2 12c0-.9 1.6-1.6 3.4-1.6 2.1 0 3.6.6 4.9 1.6-1.3 1-2.8 1.6-4.9 1.6-1.8 0-3.4-.7-3.4-1.6Z',
          fill: 'currentColor',
          opacity: 0.9,
        }),
        h('path', {
          d: 'M11.5 12c1.6-2.6 4.2-4.1 7.1-4.1 1.6 0 2.6.5 2.6 1 0 .3-.4.6-1.1.8 1 .5 1.6 1.2 1.6 2.3 0 1.1-.6 1.8-1.6 2.3.7.2 1.1.5 1.1.8 0 .5-1 1-2.6 1-2.9 0-5.5-1.5-7.1-4.1Z',
          fill: 'currentColor',
        }),
        h('circle', { cx: 17.4, cy: 11.1, r: 0.85, fill: 'var(--dsw-alias-bg-base, #0b1720)' }),
      )
    }

    /* ---------------------------------------------------------------- */
    /* 关系网布局（Fruchterman-Reingold，够小够稳）                        */
    /* ---------------------------------------------------------------- */

    const GRAPH_W = 660
    const GRAPH_H = 360

    function layoutGraph(nodes, links) {
      const list = []
      const seen = new Set()
      for (const node of nodes || []) {
        if (!node || !node.id || seen.has(node.id)) continue
        seen.add(node.id)
        list.push(node)
      }
      const points = list.map((node, index) => {
        const angle = (index / Math.max(1, list.length)) * Math.PI * 2
        const radius = node.type === 'fish' ? 118 : node.type === 'topic' ? 148 : 0
        return {
          ...node,
          x: GRAPH_W / 2 + Math.cos(angle) * radius,
          y: GRAPH_H / 2 + Math.sin(angle) * radius * 0.72,
          vx: 0,
          vy: 0,
        }
      })
      const byId = new Map(points.map((point) => [point.id, point]))
      const edges = []
      for (const link of links || []) {
        const source = byId.get(link.source)
        const target = byId.get(link.target)
        if (!source || !target || source === target) continue
        edges.push({ ...link, source, target })
      }

      for (let step = 0; step < 220; step += 1) {
        for (let i = 0; i < points.length; i += 1) {
          for (let j = i + 1; j < points.length; j += 1) {
            const a = points[i]
            const b = points[j]
            let dx = b.x - a.x
            let dy = b.y - a.y
            let dist2 = dx * dx + dy * dy
            if (dist2 < 1) {
              dist2 = 1
              dx = 0.6
              dy = 0.4
            }
            const dist = Math.sqrt(dist2)
            const force = (a.type === 'pond' || b.type === 'pond' ? 5200 : 2400) / dist2
            const ux = dx / dist
            const uy = dy / dist
            a.vx -= ux * force
            a.vy -= uy * force
            b.vx += ux * force
            b.vy += uy * force
          }
        }
        for (const edge of edges) {
          const target = edge.type === 'topic' ? 62 : edge.type === 'home' ? 96 : 120 - (edge.weight || 0) * 0.35
          const dx = edge.target.x - edge.source.x
          const dy = edge.target.y - edge.source.y
          const dist = Math.hypot(dx, dy) || 1
          const force = (dist - Math.max(46, target)) * 0.02
          const ux = dx / dist
          const uy = dy / dist
          edge.source.vx += ux * force
          edge.source.vy += uy * force
          edge.target.vx -= ux * force
          edge.target.vy -= uy * force
        }
        for (const point of points) {
          if (point.type === 'pond') {
            point.x = GRAPH_W / 2
            point.y = GRAPH_H / 2
            point.vx = 0
            point.vy = 0
            continue
          }
          point.vx *= 0.82
          point.vy *= 0.82
          point.x += point.vx * 0.42
          point.y += point.vy * 0.42
          const padX = point.type === 'topic' ? 70 : 42
          point.x = Math.max(padX, Math.min(GRAPH_W - padX, point.x))
          point.y = Math.max(30, Math.min(GRAPH_H - 30, point.y))
        }
      }
      return { points, edges }
    }

    function round1(value) {
      return Math.round(value * 10) / 10
    }

    /* ---------------------------------------------------------------- */
    /* 关系网卡片                                                        */
    /* ---------------------------------------------------------------- */

    function GraphCard({ graph, selected, onSelect }) {
      const layout = useMemo(() => layoutGraph(graph && graph.nodes, graph && graph.links), [graph])
      const nodesById = useMemo(() => new Map(layout.points.map((point) => [point.id, point])), [layout])
      const detail = selected ? nodesById.get(selected) : null
      const stats = useMemo(() => {
        const fish = layout.points.filter((point) => point.type === 'fish').length
        const topics = layout.points.filter((point) => point.type === 'topic').length
        return { fish, topics, edges: layout.edges.length }
      }, [layout])

      return h(
        'section',
        { className: 'yq-card yq-graph-card' },
        h('header', { className: 'yq-card-head' },
          h('span', { className: 'yq-card-title' }, '关系网'),
          h('span', { className: 'yq-card-hint' },
            `${stats.fish} 条鱼 · ${stats.edges} 条边 · ${stats.topics} 个话题`)),
        h('div', { className: 'yq-graph-wrap' },
          h('svg', {
            viewBox: `0 0 ${GRAPH_W} ${GRAPH_H}`,
            className: 'yq-graph',
            role: 'img',
            'aria-label': '鱼圈关系网',
            onClick: (event) => {
              if (event.target && event.target.tagName === 'svg') onSelect(null)
            },
          },
          h('defs', null,
            h('radialGradient', { id: 'yq-pond-glow' },
              h('stop', { offset: '0%', stopColor: '#63b6d8', stopOpacity: 0.34 }),
              h('stop', { offset: '100%', stopColor: '#63b6d8', stopOpacity: 0 }))),
          h('circle', { cx: GRAPH_W / 2, cy: GRAPH_H / 2, r: 120, fill: 'url(#yq-pond-glow)' }),
          layout.edges.map((edge, index) => {
            const isTopic = edge.type === 'topic'
            const isHome = edge.type === 'home'
            const width = isTopic ? 0.7 : isHome ? 1 : 1.2 + Math.min(3.4, (edge.weight || 0) / 26)
            const opacity = isTopic ? 0.28 : isHome ? 0.14 : 0.34 + Math.min(0.4, (edge.weight || 0) / 240)
            return h('line', {
              key: `e${index}`,
              x1: round1(edge.source.x),
              y1: round1(edge.source.y),
              x2: round1(edge.target.x),
              y2: round1(edge.target.y),
              stroke: isTopic ? '#7fa9c4' : '#9bd2ea',
              strokeWidth: width,
              strokeOpacity: opacity,
              strokeDasharray: isHome ? '2 6' : isTopic ? '1 5' : undefined,
            })
          }),
          layout.points.map((point) => {
            if (point.type === 'pond') {
              return h('g', { key: point.id, className: 'yq-graph-node', onClick: () => onSelect(point.id) },
                h('circle', { cx: round1(point.x), cy: round1(point.y), r: 26, fill: 'rgba(99,182,216,0.16)', stroke: 'rgba(155,210,234,0.55)', strokeWidth: 1 }),
                h('text', { x: round1(point.x), y: round1(point.y + 3), textAnchor: 'middle', className: 'yq-graph-label-strong' }, '本塘'))
            }
            if (point.type === 'topic') {
              const isActive = selected === point.id
              return h('g', {
                key: point.id,
                className: 'yq-graph-node',
                onClick: () => onSelect(isActive ? null : point.id),
              },
              h('circle', { cx: round1(point.x), cy: round1(point.y), r: isActive ? 7 : 4.6, fill: 'rgba(127,169,196,0.6)', stroke: isActive ? '#bfe6f7' : 'none', strokeWidth: 1 }),
              h('text', {
                x: round1(point.x),
                y: round1(point.y - 10),
                textAnchor: 'middle',
                className: 'yq-graph-label-topic',
              }, truncate(point.label, 12)))
            }
            const radius = point.type === 'fish' ? 6 + Math.min(6, (point.size || 1) * 4) : 5
            const isActive = selected === point.id
            return h('g', {
              key: point.id,
              className: 'yq-graph-node',
              onClick: () => onSelect(isActive ? null : point.id),
            },
            h('circle', {
              cx: round1(point.x),
              cy: round1(point.y),
              r: isActive ? radius + 3.5 : radius,
              fill: point.color || '#8fb8d8',
              stroke: point.kind && point.kind !== 'resident' ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.32)',
              strokeWidth: point.kind && point.kind !== 'resident' ? 1.6 : 1,
              strokeDasharray: point.kind === 'remote' ? '2 2' : undefined,
            }),
            h('text', {
              x: round1(point.x),
              y: round1(point.y + radius + 13),
              textAnchor: 'middle',
              className: 'yq-graph-label',
            }, truncate(point.label, 8)))
          })),
        h('div', { className: 'yq-graph-legend' },
          h('span', null, h('i', { className: 'yq-dot yq-dot-resident' }), '本塘鱼'),
          h('span', null, h('i', { className: 'yq-dot yq-dot-guest' }), '客鱼'),
          h('span', null, h('i', { className: 'yq-dot yq-dot-topic' }), '话题'),
          h('span', { className: 'yq-graph-tip' }, '点节点看细节')),
        ),
        detail
          ? h('div', { className: 'yq-graph-detail' },
              h('span', { className: 'yq-graph-detail-name' },
                detail.type === 'topic' ? `#${detail.label}` : detail.label),
              h('span', { className: 'yq-graph-detail-meta' },
                detail.type === 'pond'
                  ? `${stats.fish} 条鱼住在这里`
                  : detail.type === 'topic'
                    ? '双链话题：聊过它的鱼都会连过来'
                    : `${detail.kind === 'resident' ? '本塘' : detail.kind === 'visitor' ? '客鱼' : '异地'} · 来自 ${detail.pondName || '本塘'}`),
              h('button', {
                type: 'button',
                className: 'yq-mini-btn',
                onClick: () => onSelect(null),
              }, '收起'))
          : null,
      )
    }

    function truncate(text, max) {
      const value = String(text || '')
      return value.length > max ? `${value.slice(0, max - 1)}…` : value
    }

    /* ---------------------------------------------------------------- */
    /* 池子                                                              */
    /* ---------------------------------------------------------------- */

    function PondScene({ fish, busy, caption, bare }) {
      return h('div', { className: 'yq-pond' },
        h('div', { className: 'yq-water', 'aria-hidden': 'true' }),
        h('div', { className: 'yq-rays', 'aria-hidden': 'true' }),
        h('div', { className: 'yq-shafts', 'aria-hidden': 'true' },
          h('span', { className: 'yq-shaft yq-shaft-a' }),
          h('span', { className: 'yq-shaft yq-shaft-b' }),
          h('span', { className: 'yq-shaft yq-shaft-c' })),
        h('div', { className: 'yq-caustics', 'aria-hidden': 'true' }),
        h('div', { className: 'yq-surface', 'aria-hidden': 'true' }),
        h('div', { className: 'yq-surface-line', 'aria-hidden': 'true' }),
        h('div', { className: 'yq-floor', 'aria-hidden': 'true' }),
        h('div', { className: 'yq-sand', 'aria-hidden': 'true' }),
        h('div', { className: 'yq-pebbles', 'aria-hidden': 'true' }),
        h('div', { className: 'yq-weeds', 'aria-hidden': 'true' },
          h('span', { className: 'yq-weed yq-weed-a' }),
          h('span', { className: 'yq-weed yq-weed-b' }),
          h('span', { className: 'yq-weed yq-weed-c' }),
          h('span', { className: 'yq-weed yq-weed-d' }),
          h('span', { className: 'yq-weed yq-weed-e' }),
          h('span', { className: 'yq-tuft yq-tuft-a' }),
          h('span', { className: 'yq-tuft yq-tuft-b' })),
        h('div', { className: 'yq-bubbles', 'aria-hidden': 'true' },
          Array.from({ length: 9 }).map((_, index) => {
            const diameter = 3 + ((index * 5) % 6)
            return h('span', {
              key: `bubble-${index}`,
              className: 'yq-bubble',
              style: {
                left: `${6 + index * 11}%`,
                width: `${diameter}px`,
                height: `${diameter}px`,
                animationDelay: `${index * 1.4}s`,
                animationDuration: `${7 + (index % 4) * 2.4}s`,
              },
            })
          })),
        h('div', { className: 'yq-motes', 'aria-hidden': 'true' },
          Array.from({ length: 14 }).map((_, index) => h('span', {
            key: `mote-${index}`,
            className: 'yq-mote',
            style: {
              left: `${4 + ((index * 29) % 92)}%`,
              top: `${12 + ((index * 37) % 74)}%`,
              animationDelay: `${(index % 7) * 1.6}s`,
              animationDuration: `${9 + (index % 5) * 2}s`,
            },
          }))),
        h('div', { className: 'yq-vignette', 'aria-hidden': 'true' }),
        fish.map((item, index) => {
          const seed = hashSeed(item.id)
          // 每条鱼占一条泳道：按序号均分水体高度，再叠一点稳定抖动，避免名字叠在一起。
          const count = Math.max(1, fish.length)
          const band = count === 1 ? 0.5 : (index + 0.5) / count
          const top = 8 + band * 74 + ((seed % 5) - 2) * 0.8
          const duration = 34 + (seed % 26)
          const delay = -((seed >> 5) % 40)
          const leftward = seed % 2 === 0
          const guest = item.kind && item.kind !== 'resident'
          // 越靠下越近：放大一点、亮一点，制造纵深
          const depth = 0.82 + band * 0.36
          const scale = (item.size || 1) * depth
          return h('div', {
            key: item.id,
            className: `yq-lane${guest ? ' yq-lane-guest' : ''}`,
            style: { top: `${top}%`, zIndex: 10 + Math.round(band * 10) },
            title: `${item.name}${guest ? `（来自 ${item.home ? item.home.pondName : '别处'}）` : ''}`,
          },
          h('div', {
            className: 'yq-swim',
            style: { animationName: leftward ? 'yq-swim-back' : 'yq-swim', animationDuration: `${duration}s`, animationDelay: `${delay}s` },
          },
          h('div', { className: 'yq-float' + (leftward ? ' yq-float-flip' : ''), style: { animationDelay: `${(seed % 9) * 0.4}s`, opacity: 0.78 + band * 0.22 } },
            h('div', { className: 'yq-glow' }),
            h('span', { className: 'yq-name' }, `${item.name}${guest ? '（客）' : ''}`),
            h('span', { className: 'yq-avatar' + (leftward ? ' yq-avatar-flip' : '') },
              h('div', { className: 'yq-shadow' }),
              h(FishGlyph, {
                color: item.color,
                size: scale,
                species: item.species,
                className: 'yq-fish-svg',
                image: imageUrl(item.image),
              })))))
        }),
        busy && !bare ? h('div', { className: 'yq-busy' }, h(Spinner, null), h('span', null, '水面下有窸窸窣窣的声音…')) : null,
        caption && !bare
          ? h('div', { className: 'yq-caption' }, h('span', { className: 'yq-caption-label' }, '上次听到'), h('span', null, caption))
          : null,
        bare
          ? null
          : h('div', { className: 'yq-pond-meta' },
              h('span', null, `${fish.length} 条鱼在游`),
              h('span', null, '水温 24°')))
    }

    /* ---------------------------------------------------------------- */
    /* 水域交互：鼠标投喂 + 外交航线图                                     */
    /* ---------------------------------------------------------------- */

    const ROUTE_MS = 3400
    const EAT_TEXTS = ['谢谢老板的投喂！', '这块水草真新鲜！', '唔，好吃。', '再来一颗嘛。', '今天这顿有着落了。']
    const SAD_TEXTS = ['……被抢了。', '哼，明明是我先看到的。', '算了，我减肥。']

    function quadPoint(sx, sy, cx, cy, ex, ey, t) {
      const mt = 1 - t
      return {
        x: mt * mt * sx + 2 * mt * t * cx + t * t * ex,
        y: mt * mt * sy + 2 * mt * t * cy + t * t * ey,
      }
    }

    /** Canvas 里画的标签：半透明底 + 一行白字，超宽时截断。 */
    function drawTag(ctx, x, y, text) {
      const label = text.length > 26 ? `${text.slice(0, 25)}…` : text
      ctx.font = '12px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
      const width = Math.min(240, ctx.measureText(label).width + 18)
      const left = Math.max(6, Math.min(x - width / 2, ctx.canvas.clientWidth - width - 6))
      const top = Math.max(6, y)
      ctx.beginPath()
      if (typeof ctx.roundRect === 'function') ctx.roundRect(left, top, width, 24, 12)
      else ctx.rect(left, top, width, 24)
      ctx.fillStyle = 'rgba(6, 20, 32, 0.78)'
      ctx.fill()
      ctx.strokeStyle = 'rgba(140, 220, 245, 0.35)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = 'rgba(232, 246, 255, 0.94)'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, left + width / 2, top + 12, width - 14)
    }

    /**
     * 中央水域。鱼按坐标游动（不再是 CSS 泳道）：点水面掉一颗饵料，最近的鱼会冲过去吃，
     * 抢输的那条冒一句失落的话。同一块区域上方叠一层 canvas 画外交航线。
     */
    function PondStage({ fish, caption, routes, items, onRouteDone, onNibble, onPack }) {
      const boxRef = useRef(null)
      const baitLayerRef = useRef(null)
      const bubbleLayerRef = useRef(null)
      const canvasRef = useRef(null)
      const models = useRef(new Map())
      const fishEls = useRef(new Map())
      const baits = useRef([])
      const bubbles = useRef([])
      const routesRef = useRef([])
      const size = useRef({ w: 640, h: 360 })
      const counter = useRef(0)
      const callbacks = useRef({ onNibble, onRouteDone })
      const [armed, setArmed] = useState(false)
      const [packOpen, setPackOpen] = useState(false)
      const [postcard, setPostcard] = useState(null)
      const postcardTimer = useRef(0)

      callbacks.current = { onNibble, onRouteDone }
      routesRef.current = Array.isArray(routes) ? routes : []

      /** 一条航线走完：在水面上弹一张明信片，3 秒后自己走。 */
      const showPostcard = (route) => {
        if (!route) return null
        setPostcard({
          id: route.id,
          dir: route.dir === 'out' ? 'out' : 'in',
          name: route.name || '一条鱼',
          pondName: route.pondName || '外塘',
        })
        if (postcardTimer.current) window.clearTimeout(postcardTimer.current)
        postcardTimer.current = window.setTimeout(() => setPostcard(null), 3200)
        return null
      }

      const bubbleFor = (model, text, tone) => {
        const layer = bubbleLayerRef.current
        if (!layer || !model) return
        const el = document.createElement('div')
        el.className = `yq-fish-bubble${tone === 'sad' ? ' is-sad' : ''}`
        el.textContent = text
        layer.appendChild(el)
        bubbles.current.push({ el, model, bornAt: performance.now() })
        if (bubbles.current.length > 12) {
          const old = bubbles.current.shift()
          if (old && old.el) old.el.remove()
        }
      }

      const removeBait = (id) => {
        const index = baits.current.findIndex((bait) => bait.id === id)
        if (index < 0) return null
        const [bait] = baits.current.splice(index, 1)
        if (bait.el && bait.el.parentNode) bait.el.parentNode.removeChild(bait.el)
        return bait
      }

      useEffect(() => {
        const box = boxRef.current
        if (!box) return undefined
        let alive = true
        let raf = 0

        const measure = () => {
          if (!boxRef.current) return
          const rect = boxRef.current.getBoundingClientRect()
          size.current = { w: Math.max(240, rect.width), h: Math.max(180, rect.height) }
          const canvas = canvasRef.current
          if (canvas) {
            const dpr = Math.min(2, window.devicePixelRatio || 1)
            canvas.width = Math.round(size.current.w * dpr)
            canvas.height = Math.round(size.current.h * dpr)
            canvas.style.width = `${size.current.w}px`
            canvas.style.height = `${size.current.h}px`
            const ctx = canvas.getContext('2d')
            if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
          }
        }
        measure()
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
        if (observer) observer.observe(box)

        const eat = (model, bait) => {
          removeBait(bait.id)
          model.eatUntil = performance.now() + 340
          bubbleFor(model, EAT_TEXTS[Math.abs(hashSeed(`${bait.id}`)) % EAT_TEXTS.length], 'eat')
          // 也在抢同一颗饵、但晚到一步的鱼：给一句失落的话。
          for (const other of models.current.values()) {
            if (other.id === model.id) continue
            if (other.target === bait && Math.hypot(other.x - bait.x, other.y - bait.y) < 200) {
              bubbleFor(other, SAD_TEXTS[Math.abs(hashSeed(`${bait.id}${other.id}`)) % SAD_TEXTS.length], 'sad')
            }
          }
          const notify = callbacks.current.onNibble
          if (typeof notify === 'function') notify(model.id)
        }

        const drawRoutes = (now) => {
          const canvas = canvasRef.current
          if (!canvas) return
          const ctx = canvas.getContext('2d')
          if (!ctx) return
          const { w, h } = size.current
          ctx.clearRect(0, 0, w, h)
          const list = routesRef.current
          for (const route of list) {
            if (!route || !route.edge) continue
            const p = Math.min(1, Math.max(0, (now - route.startedAt) / ROUTE_MS))
            const t = route.dir === 'out' ? p : 1 - p
            const sx = w / 2
            const sy = h / 2
            const ex = route.edge.x * w
            const ey = route.edge.y * h
            const cx = (sx + ex) / 2 + (route.bend ? route.bend.x : 0.2) * w * 0.18
            const cy = (sy + ey) / 2 + (route.bend ? route.bend.y : -0.2) * h * 0.18

            ctx.beginPath()
            ctx.moveTo(sx, sy)
            ctx.quadraticCurveTo(cx, cy, ex, ey)
            ctx.setLineDash([6, 9])
            ctx.lineWidth = 1.4
            ctx.strokeStyle = 'rgba(140, 220, 245, 0.40)'
            ctx.stroke()
            ctx.setLineDash([])

            const head = quadPoint(sx, sy, cx, cy, ex, ey, t)
            const ahead = quadPoint(sx, sy, cx, cy, ex, ey, Math.min(1, t + 0.02))
            const angle = Math.atan2(ahead.y - head.y, ahead.x - head.x)
            const scale = route.dir === 'out' ? 1 - 0.55 * t : 0.45 + 0.55 * t

            ctx.save()
            ctx.translate(head.x, head.y)
            ctx.rotate(angle)
            ctx.scale(scale, scale)
            ctx.fillStyle = route.color || '#9fe3ff'
            ctx.beginPath()
            ctx.ellipse(0, 0, 11, 6.5, 0, 0, Math.PI * 2)
            ctx.fill()
            ctx.beginPath()
            ctx.moveTo(-10, 0)
            ctx.lineTo(-17, -5)
            ctx.lineTo(-17, 5)
            ctx.closePath()
            ctx.fill()
            ctx.restore()

            const label = route.dir === 'out'
              ? `${route.name} → ${route.pondName}`
              : `外来客【${route.name}】→ 游入本塘`
            drawTag(ctx, head.x, head.y - 30, label)

            if (p >= 1 && !route.done) {
              route.done = true
              showPostcard(route)
              const done = callbacks.current.onRouteDone
              if (typeof done === 'function') done(route.id)
            }
          }
        }

        let last = performance.now()
        const step = (now) => {
          if (!alive) return
          const dt = Math.min(0.05, (now - last) / 1000)
          last = now
          const { w, h } = size.current

          for (const model of models.current.values()) {
            if (!model.el) continue
            model.phase += dt * (0.55 + model.wobble)
            let target = null
            let best = Infinity
            for (const bait of baits.current) {
              const distance = Math.hypot(bait.x - model.x, bait.y - model.y)
              if (distance < best && distance < 240) {
                best = distance
                target = bait
              }
            }
            model.target = target
            if (target) {
              const dx = target.x - model.x
              const dy = target.y - model.y
              const distance = Math.max(1, Math.hypot(dx, dy))
              const speed = 92 + model.size * 60
              model.x += (dx / distance) * speed * dt
              model.y += (dy / distance) * speed * dt
              model.dir = dx >= 0 ? 1 : -1
              if (distance < 14 + model.size * 9) eat(model, target)
            } else {
              model.x += Math.cos(model.phase) * model.speed * dt
              model.y += Math.sin(model.phase * 1.6) * model.speed * 0.26 * dt
              model.dir = Math.cos(model.phase) >= 0 ? 1 : -1
            }
            const padX = 46
            const padY = 30
            if (model.x < padX) { model.x = padX; model.phase += Math.PI * 0.7 }
            if (model.x > w - padX) { model.x = w - padX; model.phase += Math.PI * 0.7 }
            if (model.y < padY) { model.y = padY; model.phase += Math.PI * 0.7 }
            if (model.y > h - padY) { model.y = h - padY; model.phase += Math.PI * 0.7 }

            model.el.style.transform = `translate3d(${model.x.toFixed(1)}px, ${model.y.toFixed(1)}px, 0) scaleX(${model.dir})`
            model.el.classList.toggle('is-eating', now < model.eatUntil)
            model.el.classList.toggle('is-chasing', Boolean(target))
          }

          for (const bait of [...baits.current]) {
            bait.vy += 10 * dt
            bait.y += bait.vy * dt
            bait.el.style.transform = `translate3d(${bait.x.toFixed(1)}px, ${bait.y.toFixed(1)}px, 0)`
            if (bait.y > h - 20) removeBait(bait.id)
          }

          for (let index = bubbles.current.length - 1; index >= 0; index -= 1) {
            const bubble = bubbles.current[index]
            const age = (now - bubble.bornAt) / 1000
            const model = bubble.model
            bubble.el.style.transform = `translate3d(${model.x.toFixed(1)}px, ${(model.y - 44 - model.size * 12).toFixed(1)}px, 0) translate(-50%, -100%)`
            if (age > 2.2) {
              bubble.el.remove()
              bubbles.current.splice(index, 1)
            }
          }

          drawRoutes(now)
          raf = requestAnimationFrame(step)
        }
        raf = requestAnimationFrame(step)

        return () => {
          alive = false
          cancelAnimationFrame(raf)
          if (observer) observer.disconnect()
          if (postcardTimer.current) window.clearTimeout(postcardTimer.current)
          for (const bait of baits.current) if (bait.el && bait.el.parentNode) bait.el.remove()
          baits.current = []
          for (const bubble of bubbles.current) if (bubble.el) bubble.el.remove()
          bubbles.current = []
        }
      }, [])

      // 鱼进进出出时同步坐标模型：新鱼从自己的随机位置开始游。
      useEffect(() => {
        const next = new Set()
        for (const item of fish) {
          next.add(item.id)
          if (!models.current.has(item.id)) {
            const seed = hashSeed(item.id)
            const { w, h } = size.current
            models.current.set(item.id, {
              id: item.id,
              x: 70 + (seed % Math.max(120, Math.round(w) - 140)),
              y: 50 + ((seed >> 3) % Math.max(80, Math.round(h) - 100)),
              phase: (seed % 360) / 57,
              speed: 20 + (seed % 16),
              wobble: ((seed % 9) + 4) / 9,
              dir: 1,
              size: item.size || 1,
              el: fishEls.current.get(item.id) || null,
              target: null,
              eatUntil: 0,
            })
          }
        }
        for (const id of [...models.current.keys()]) if (!next.has(id)) models.current.delete(id)
      }, [fish])

      const dropBait = (event) => {
        if (event && event.button) return
        // 悬浮 UI 上的点击不算投喂：按钮、航线面板、行囊都在这层里。
        if (event && event.target && event.target.closest && event.target.closest('.yq-stage-ui')) return
        const box = boxRef.current
        if (!box) return
        const layer = baitLayerRef.current
        if (!layer) return
        const rect = box.getBoundingClientRect()
        const x = Math.min(size.current.w - 20, Math.max(20, event.clientX - rect.left))
        const y = Math.min(size.current.h - 30, Math.max(20, event.clientY - rect.top))
        counter.current += 1
        const id = `bait-${counter.current}`
        const el = document.createElement('div')
        el.className = 'yq-bait'
        el.setAttribute('aria-hidden', 'true')
        layer.appendChild(el)
        el.style.transform = `translate3d(${x}px, ${y}px, 0)`
        baits.current.push({ id, x, y, vy: 8, el })
        setArmed(false)
      }

      const stock = (Array.isArray(items) ? items : []).filter((item) => item && item.count > 0)
      const stockTotal = stock.reduce((sum, item) => sum + item.count, 0)
      const roads = Array.isArray(routes) ? routes : []

      return h('div', {
        className: `yq-stage${armed ? ' is-armed' : ''}`,
        ref: boxRef,
        onPointerDown: dropBait,
        role: 'application',
        'aria-label': '水域：点一下掉一颗饵料',
      },
      // 1) 最底层：深蓝水波、光柱、水草、暗角
      h('div', { className: 'yq-stage-water', 'aria-hidden': 'true' },
        h('span', { className: 'yq-stage-ray yq-stage-ray-a' }),
        h('span', { className: 'yq-stage-ray yq-stage-ray-b' }),
        h('span', { className: 'yq-stage-floor' }),
        h('span', { className: 'yq-stage-weed yq-stage-weed-a' }),
        h('span', { className: 'yq-stage-weed yq-stage-weed-b' }),
        h('span', { className: 'yq-stage-weed yq-stage-weed-c' }),
        h('span', { className: 'yq-stage-vignette' })),
      // 2) 鱼（绝对定位，由 rAF 驱动）
      h('div', { className: 'yq-stage-fish-layer' }, fish.map((item) => {
        const guest = item.kind && item.kind !== 'resident'
        return h('div', {
          key: item.id,
          className: `yq-stage-fish${guest ? ' is-guest' : ''}`,
          ref: (el) => {
            if (!el) { fishEls.current.delete(item.id); return }
            fishEls.current.set(item.id, el)
            const model = models.current.get(item.id)
            if (model) model.el = el
          },
          title: guest ? `${item.name}（来自 ${item.home ? item.home.pondName : '别处'}）` : item.name,
        },
        h('span', { className: 'yq-stage-name' }, guest ? `${item.name}（客）` : item.name),
        h('div', { className: 'yq-stage-body' },
          h(FishGlyph, {
            color: item.color,
            size: item.size || 1,
            species: item.species,
            className: 'yq-fish-svg',
            image: imageUrl(item.image),
          })))
      })),
      // 3) 饵料
      h('div', { className: 'yq-bait-layer', ref: baitLayerRef, 'aria-hidden': 'true' }),
      // 4) Canvas 航线层：只画，不接鼠标
      h('canvas', { className: 'yq-route-canvas', ref: canvasRef, 'aria-hidden': 'true' }),
      // 5) 气泡
      h('div', { className: 'yq-bubble-layer', ref: bubbleLayerRef, 'aria-hidden': 'true' }),
      // 6) 最上层：悬浮 UI（这一层不接事件，里面的控件各自接）
      h('div', { className: 'yq-stage-ui' },
        h('section', { className: 'yq-route-panel', 'aria-label': '外交航线图' },
          h('header', { className: 'yq-route-head' }, h('span', null, '🌐 外交航线图')),
          roads.length
            ? h('ul', { className: 'yq-route-list' }, roads.slice(0, 3).map((route) => h('li', {
                key: route.id,
                className: `yq-route-item yq-route-${route.dir}`,
              },
              h('span', { className: 'yq-route-name' }, route.dir === 'out'
                ? `${route.name} → ${route.pondName || '外塘'}`
                : `外来客【${route.name}】`),
              h('em', { className: 'yq-route-state' }, '航程中'))))
            : h('p', { className: 'yq-route-empty' }, '现在没有鱼在路上')),
        h('div', { className: `yq-pack-float${packOpen ? ' is-open' : ''}` },
          h('button', {
            type: 'button',
            className: 'yq-pack-btn',
            onClick: () => setPackOpen((open) => !open),
            'aria-expanded': packOpen ? 'true' : 'false',
            'aria-label': '行囊与仓库',
            title: '行囊与仓库',
          },
          h('span', { className: 'yq-pack-emoji' }, '🎒'),
          h('span', { className: 'yq-pack-count' }, `${stockTotal} 件`)),
          packOpen
            ? h('div', { className: 'yq-pack-pop' },
                h('div', { className: 'yq-pack-pop-head' }, '仓库'),
                stock.length
                  ? h('ul', { className: 'yq-pack-stock' }, stock.map((item) => h('li', { key: item.id },
                      h('span', { className: 'yq-pack-stock-name' }, item.name),
                      h('em', { className: 'yq-pack-stock-count' }, `×${item.count}`))))
                  : h('p', { className: 'yq-pack-stock-empty' }, '仓库是空的'),
                h('button', {
                  type: 'button',
                  className: 'yq-btn yq-btn-ghost yq-pack-open',
                  onClick: () => { setPackOpen(false); if (typeof onPack === 'function') onPack() },
                }, '整理行囊 → 送 TA 出门'))
            : null),
        h('button', {
          type: 'button',
          className: `yq-bait-btn${armed ? ' is-armed' : ''}`,
          onClick: () => setArmed((on) => !on),
          'aria-pressed': armed ? 'true' : 'false',
          title: '拿起鱼食，点水面撒饵',
        }, h('span', { className: 'yq-bait-btn-emoji' }, '🍞'), h('span', null, armed ? '点水面' : '鱼食')),
        h('p', { className: 'yq-stage-hint' }, armed ? '点水面撒饵 · 再点「鱼食」收起' : '点击水面投喂 / 点击底部小鱼互动'),
        postcard
          ? h('div', { className: `yq-postcard yq-postcard-${postcard.dir}` },
              h('span', { className: 'yq-postcard-title' }, postcard.dir === 'out' ? '✉️ 明信片 · 出门了' : '✉️ 明信片 · 来客人了'),
              h('span', { className: 'yq-postcard-text' }, postcard.dir === 'out'
                ? `${postcard.name} 已经游向 ${postcard.pondName}，等它带点特产回来。`
                : `${postcard.name} 从 ${postcard.pondName} 游进来了。`))
          : null,
        h('div', { className: 'yq-pond-meta' },
          h('span', null, `${fish.length} 条鱼在游`),
          h('span', null, '水温 24°'))))
    }

    function Spinner() {
      return h('span', { className: 'yq-spinner', 'aria-hidden': 'true' })
    }

    /* ---------------------------------------------------------------- */
    /* 水中絮语                                                          */
    /* ---------------------------------------------------------------- */

    const KIND_LABEL = {
      seed: '旧事',
      chat: '闲聊',
      'visit-in': '来访',
      'visit-out': '出游',
      say: '开口',
    }

    function LogCard({ encounters, fish }) {
      const colorOf = useMemo(() => {
        const map = new Map()
        for (const item of fish || []) map.set(item.id, item.color)
        return map
      }, [fish])

      return h('section', { className: 'yq-card yq-log-card' },
        h('header', { className: 'yq-card-head' },
          h('span', { className: 'yq-card-title' }, '水中絮语'),
          h('span', { className: 'yq-card-hint' }, `${encounters.length} 段`)),
        encounters.length
          ? h('div', { className: 'yq-log' }, encounters.map((entry) => h('article', { key: entry.seq, className: 'yq-entry' },
              h('header', { className: 'yq-entry-head' },
                h('span', { className: `yq-kind yq-kind-${entry.kind || 'chat'}` }, KIND_LABEL[entry.kind] || '闲聊'),
                h('span', { className: 'yq-entry-topic' }, entry.topic),
                h('span', { className: 'yq-entry-time' }, fmtAgo(entry.at))),
              entry.guest
                ? h('p', { className: 'yq-entry-guest' }, `访客 ${entry.guest.name} 从「${entry.guest.pondName}」游来`)
                : null,
              entry.kind === 'visit-out' && entry.pond
                ? h('p', { className: 'yq-entry-guest' }, `游到了「${entry.pond.name}」`)
                : null,
              h('div', { className: 'yq-lines' }, entry.lines.map((line, index) => h('p', {
                key: index,
                className: 'yq-line',
              },
              h('span', {
                className: 'yq-speaker',
                style: { color: `color-mix(in srgb, ${colorOf.get(line.fishId) || '#9bd2ea'} 62%, var(--dsw-alias-label-primary))` },
              }, line.name),
              h('span', { className: 'yq-said' }, line.text)))))))
          : h('p', { className: 'yq-empty' }, '还没有鱼说过话。投喂一个话题试试。'))
    }

    /* ---------------------------------------------------------------- */
    /* 关系列表                                                          */
    /* ---------------------------------------------------------------- */

    function BondsCard({ edges, fish }) {
      const nameOf = useMemo(() => {
        const map = new Map()
        for (const item of fish || []) {
          const suffix = item.kind === 'visitor' ? '（客）' : item.kind === 'remote' ? '（异地）' : ''
          map.set(item.id, { name: item.name + suffix, color: item.color })
        }
        return map
      }, [fish])

      return h('section', { className: 'yq-card yq-bonds-card' },
        h('header', { className: 'yq-card-head' },
          h('span', { className: 'yq-card-title' }, '鱼友'),
          h('span', { className: 'yq-card-hint' }, `${edges.length} 段关系`)),
        edges.length
          ? h('div', { className: 'yq-bonds' }, edges.slice(0, 12).map((edge) => {
              const a = nameOf.get(edge.a) || { name: edge.a, color: '#8fb8d8' }
              const b = nameOf.get(edge.b) || { name: edge.b, color: '#8fb8d8' }
              return h('div', { key: edge.key, className: 'yq-bond' },
                h('div', { className: 'yq-bond-top' },
                  h('span', { className: 'yq-bond-pair' },
                    h('i', { className: 'yq-dot', style: { background: a.color } }),
                    a.name,
                    h('span', { className: 'yq-bond-x' }, '×'),
                    h('i', { className: 'yq-dot', style: { background: b.color } }),
                    b.name,
                    edge.kind !== 'resident'
                      ? h('em', { className: 'yq-bond-kind' }, edge.kind === 'visitor' ? '来访过' : '出游记')
                      : null),
                  h('span', { className: `yq-chip yq-chip-${edge.label === '至交' || edge.label === '好友' ? 'hot' : 'cool'}` }, edge.label)),
                h('div', { className: 'yq-bar' }, h('i', { style: { width: `${Math.max(4, edge.effective)}%` } })),
                h('div', { className: 'yq-bond-foot' },
                  h('span', null, `聊过 ${edge.meetings} 次 · 亲密度 ${edge.effective}`),
                  edge.dormantDays > 14 ? h('span', { className: 'yq-dormant' }, `${edge.dormantDays} 天没见了`) : null))
            }))
          : h('p', { className: 'yq-empty' }, '还没有鱼交上朋友。'))
    }

    /* ---------------------------------------------------------------- */
    /* 鱼证 / 塘民                                                       */
    /* ---------------------------------------------------------------- */

    function RosterCard({ pond, fish, busyId, onBind, onSpeak, onUnbind }) {
      const residents = fish.filter((item) => item.kind === 'resident')
      const guests = fish.filter((item) => item.kind !== 'resident')
      return h('section', { className: 'yq-card yq-roster-card' },
        h('header', { className: 'yq-card-head' },
          h('span', { className: 'yq-card-title' }, '塘里的鱼'),
          h('span', { className: 'yq-card-hint' }, `${residents.length} 位塘民 · ${guests.length} 位客鱼`)),
        h('div', { className: 'yq-roster' }, fish.map((item) => {
          const guest = item.kind && item.kind !== 'resident'
          const address = `${item.id}@${pond.id}`
          return h('article', { key: item.id, className: `yq-fish-card${guest ? ' yq-fish-card-guest' : ''}` },
            h('div', { className: 'yq-fish-card-head' },
              h('span', { className: 'yq-fish-avatar', style: { background: `linear-gradient(140deg, ${shade(item.color, 26)}, ${shade(item.color, -18)})` } },
                h(FishGlyph, { color: item.color, size: 0.62, className: 'yq-fish-avatar-glyph', image: imageUrl(item.image) })),
              h('div', { className: 'yq-fish-id' },
                h('div', { className: 'yq-fish-name' },
                  item.name,
                  h('span', { className: 'yq-fish-species' }, item.species),
                  guest ? h('em', { className: 'yq-guest-tag' }, item.kind === 'remote' ? '异地' : '客') : null),
                h('div', { className: 'yq-fish-address', title: address }, guest && item.home ? `来自 ${item.home.pondName}` : address)),
              item.bound
                ? h('span', {
                    className: `yq-bind-chip${item.bound.kind === 'im' ? ' yq-bind-chip-im' : ''}`,
                    title: item.bound.targetName
                      ? `由 ${item.bound.label} 代嘴，会推送到「${item.bound.targetName}」`
                      : `由 ${item.bound.label} 代嘴`,
                  },
                    h('i', { className: 'yq-dot yq-bind-dot' }),
                    item.bound.label)
                : null),
            h('p', { className: 'yq-fish-persona' }, item.persona || '还没想清楚自己是什么性格。'),
            h('div', { className: 'yq-traits' }, TRAITS.map(([key, label]) => h('div', { key, className: 'yq-trait' },
              h('span', null, label),
              h('span', { className: 'yq-trait-bar' }, h('i', { style: { width: `${item.traits ? item.traits[key] : 0}%` } }))))),
            h('div', { className: 'yq-fish-foot' },
              h('div', { className: 'yq-tags' }, (item.tags || []).map((tag) => h('span', { key: tag, className: 'yq-tag' }, tag))),
              h('span', { className: 'yq-memory' }, item.memories && item.memories.length ? `${item.memories.length} 段记忆` : '还没有记忆')),
            item.memories && item.memories.length
              ? h('p', { className: 'yq-fish-memory' }, item.memories[0].text)
              : null,
            guest
              ? null
              : h('div', { className: 'yq-fish-actions' },
                  h('button', {
                    type: 'button',
                    className: 'yq-mini-btn',
                    disabled: busyId === item.id,
                    onClick: () => onBind(item),
                  }, item.bound ? '换绑机器人' : '绑个机器人'),
                  h('button', {
                    type: 'button',
                    className: 'yq-mini-btn',
                    disabled: busyId === item.id,
                    onClick: () => onSpeak(item),
                  }, '替 TA 说话'),
                  item.bound
                    ? h('button', {
                        type: 'button',
                        className: 'yq-mini-btn yq-mini-btn-ghost',
                        disabled: busyId === item.id,
                        onClick: () => onUnbind(item),
                      }, '松开')
                    : null))
        })))
    }

    /* ---------------------------------------------------------------- */
    /* 串门 / 塘口设置                                                    */
    /* ---------------------------------------------------------------- */

    function SkinCard({ fish, skins, selectedId, onSelect, onPick, busyId }) {
      const residents = fish.filter((item) => item.kind === 'resident')
      const list = Array.isArray(skins) ? skins : []
      const current = residents.find((item) => item.id === selectedId) || residents[0] || null
      if (!residents.length) {
        return h('section', { className: 'yq-card yq-skin-card' },
          h('header', { className: 'yq-card-head' },
            h('span', { className: 'yq-card-title' }, '换皮肤'),
            h('span', { className: 'yq-card-hint' }, '还没有鱼')),
          h('p', { className: 'yq-note' }, '先「捞一条新鱼」，再给它挑一张皮。'))
      }
      return h('section', { className: 'yq-card yq-skin-card' },
        h('header', { className: 'yq-card-head' },
          h('span', { className: 'yq-card-title' }, '换皮肤'),
          h('span', { className: 'yq-card-hint' }, current ? `正在给 ${current.name} 挑` : '')),
        h('div', { className: 'yq-skin-fish' },
          residents.map((item) => h('button', {
            key: item.id,
            type: 'button',
            className: `yq-skin-fish-btn${current && current.id === item.id ? ' yq-skin-fish-on' : ''}`,
            onClick: () => onSelect(item.id),
          },
          h('span', { className: 'yq-skin-fish-glyph' }, h(FishGlyph, { color: item.color, size: 0.44, species: item.species, image: imageUrl(item.image) })),
          h('span', { className: 'yq-skin-fish-name' }, item.name)))),
        h('div', { className: 'yq-skin-grid' },
          list.map((skin) => {
            // 优先按皮肤 id 判断「现在就是它」：两套皮可能撞同一个颜色，只比颜色会同时点亮两格。
            const active = current
              ? (current.skin ? current.skin === skin.id : String(current.color).toLowerCase() === String(skin.color).toLowerCase())
              : false
            return h('button', {
              key: skin.id,
              type: 'button',
              disabled: !current || busyId === current.id,
              title: `${skin.name}${active ? '（现在就是）' : ''}`,
              className: `yq-skin${active ? ' yq-skin-on' : ''}`,
              onClick: () => current && onPick(current.id, skin.id),
            },
            h('span', { className: 'yq-skin-preview' }, h(FishGlyph, { color: skin.color, size: 0.4, species: current ? current.species : '', image: imageUrl(skin.image) })),
            h('span', { className: 'yq-skin-label' },
              h('span', { className: 'yq-skin-dot', style: { background: skin.color } }),
              skin.name,
              skin.custom ? h('span', { className: 'yq-skin-tag' }, '自') : null,
              skin.hasImage ? h('span', { className: 'yq-skin-tag' }, '图') : null))
          })),
        h('p', { className: 'yq-note' }, '只换外观：鱼证、五维、记忆和关系都不动。'))
    }

    function CustomSkinCard({ fish, customSkins, selectedId, onSelect, onCreate, onRemove, busy }) {
      const residents = fish.filter((item) => item.kind === 'resident')
      const current = residents.find((item) => item.id === selectedId) || residents[0] || null
      const saved = Array.isArray(customSkins) ? customSkins : []
      const [name, setName] = useState('')
      const [color, setColor] = useState('#7fd8c4')
      const [photo, setPhoto] = useState(null)
      const [photoBusy, setPhotoBusy] = useState(false)
      const [photoError, setPhotoError] = useState('')
      const validColor = /^#[0-9a-f]{6}$/i.test(String(color).trim())
      const previewColor = validColor ? String(color).trim() : '#8b95a8'
      const full = saved.length >= CUSTOM_SKIN_LIMIT
      /* 存满之后，同名同色仍然可以更新（换图、换色都算更新），所以不算超限。 */
      const isUpdate = saved.some((skin) => skin.name === name.trim()
        && skin.color.toLowerCase() === (validColor ? String(color).trim().toLowerCase() : ''))
      const blockedByLimit = full && !isUpdate
      const submit = () => {
        if (!current || busy || photoBusy || blockedByLimit) return
        onCreate(
          current.id,
          name.trim(),
          validColor ? String(color).trim().toLowerCase() : '',
          photo ? photo.dataUrl : '',
          false,
        )
      }
      const pickPhoto = async (file) => {
        if (!file) return
        setPhotoBusy(true)
        setPhotoError('')
        try {
          const picked = await readImageFile(file)
          setPhoto(picked)
          setColor(picked.color)
          if (!name.trim()) setName(picked.title)
        } catch (error) {
          setPhotoError(error && error.message ? error.message : '这张图没导进来')
        } finally {
          setPhotoBusy(false)
        }
      }
      const onFileChange = (event) => {
        const file = event.target.files && event.target.files[0]
        event.target.value = ''
        pickPhoto(file)
      }
      const onPickKey = (event) => {
        if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
        event.preventDefault()
        const input = event.currentTarget.querySelector('input[type=file]')
        if (input) input.click()
      }
      const onPhotoDrop = (event) => {
        event.preventDefault()
        const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0]
        if (file) pickPhoto(file)
      }
      if (!residents.length) {
        return h('section', { className: 'yq-card yq-custom-card' },
          h('header', { className: 'yq-card-head' },
            h('span', { className: 'yq-card-title' }, '自定义皮肤'),
            h('span', { className: 'yq-card-hint' }, '还没有鱼')),
          h('p', { className: 'yq-note' }, '塘里先有鱼，才谈得上给它调颜色。'))
      }
      return h('section', { className: 'yq-card yq-custom-card' },
        h('header', { className: 'yq-card-head' },
          h('span', { className: 'yq-card-title' }, '自定义皮肤'),
          h('span', { className: 'yq-card-hint' }, `已存 ${saved.length} / ${CUSTOM_SKIN_LIMIT} 套`)),
        h('div', { className: 'yq-skin-fish' },
          residents.map((item) => h('button', {
            key: item.id,
            type: 'button',
            className: `yq-skin-fish-btn${current && current.id === item.id ? ' yq-skin-fish-on' : ''}`,
            onClick: () => onSelect(item.id),
          },
          h('span', { className: 'yq-skin-fish-glyph' }, h(FishGlyph, { color: item.color, size: 0.44, species: item.species, image: imageUrl(item.image) })),
          h('span', { className: 'yq-skin-fish-name' }, item.name)))),
        h('div', { className: 'yq-custom-form' },
          h('label', { className: 'yq-custom-swatch', title: '挑个颜色' },
            h('input', {
              type: 'color',
              value: validColor ? String(color).trim() : '#7fd8c4',
              onChange: (event) => setColor(event.target.value),
            }),
            h('span', { className: 'yq-custom-swatch-in', style: { background: previewColor } })),
          h('input', {
            className: 'yq-input yq-custom-hex',
            value: String(color),
            placeholder: '#7fd8c4',
            spellCheck: false,
            onChange: (event) => setColor(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') submit() },
          }),
          h('input', {
            className: 'yq-input yq-custom-name',
            value: name,
            maxLength: 12,
            placeholder: '起个名字，如「晚霞」',
            onChange: (event) => setName(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') submit() },
          })),
        h('div', { className: `yq-custom-photo${photoBusy ? ' is-busy' : ''}` },
          photo
            ? [
                h('span', { key: 'thumb', className: 'yq-custom-photo-thumb' },
                  h('img', { src: photo.dataUrl, alt: '' }),
                  h('button', {
                    type: 'button',
                    className: 'yq-custom-photo-x',
                    title: '不用这张图',
                    'aria-label': '不用这张图',
                    onClick: () => { setPhoto(null); setPhotoError('') },
                  }, '×')),
                h('div', { key: 'meta', className: 'yq-custom-photo-meta' },
                  h('span', { className: 'yq-custom-photo-name' }, photo.title || '这张图'),
                  h('span', { className: 'yq-custom-photo-sub' },
                    `${photo.width || '?'}×${photo.height || '?'} · ${Math.max(1, Math.round((photo.bytes || 0) / 1024))}KB · 会裁进鱼身`),
                  h('label', { className: 'yq-custom-photo-swap' },
                    '换一张',
                    h('input', {
                      type: 'file',
                      accept: 'image/*',
                      style: { display: 'none' },
                      onChange: onFileChange,
                    }))),
              ]
            : h('label', {
                className: 'yq-custom-photo-pick',
                title: '从电脑里挑一张图当皮肤，也可以直接把图拖进来',
                tabIndex: 0,
                role: 'button',
                'aria-label': '导入一张图片当皮肤',
                onKeyDown: onPickKey,
                onDragOver: (event) => event.preventDefault(),
                onDrop: onPhotoDrop,
              },
                h('input', {
                  type: 'file',
                  accept: 'image/*',
                  tabIndex: -1,
                  style: { display: 'none' },
                  onChange: onFileChange,
                }),
                h('span', { className: 'yq-custom-photo-plus', 'aria-hidden': 'true' }, '+'),
                h('span', { className: 'yq-custom-photo-label' }, photoBusy ? '读图中…' : '导入一张图'),
                h('span', { className: 'yq-custom-photo-sub' }, '或把图拖进来 · PNG / JPEG / WebP'))),
        photoError ? h('p', { className: 'yq-note yq-note-error' }, photoError) : null,
        h('div', { className: 'yq-custom-row' },
          h('span', { className: 'yq-custom-preview' },
            h(FishGlyph, {
              color: previewColor,
              size: 0.5,
              species: current ? current.species : '',
              image: photo ? photo.dataUrl : undefined,
            })),
          h('span', { className: 'yq-custom-who' }, current ? `给 ${current.name}` : ''),
          h('button', {
            type: 'button',
            className: 'yq-btn yq-btn-primary yq-custom-save',
            disabled: !current || !validColor || busy || photoBusy || blockedByLimit,
            title: blockedByLimit ? `已经存满 ${CUSTOM_SKIN_LIMIT} 套了，先删一套再存` : undefined,
            onClick: submit,
          }, busy ? '存着…' : photo ? '存下这张图' : '存下并换上')),
        blockedByLimit
          ? h('p', { className: 'yq-note yq-note-warn' },
              `已经存满 ${CUSTOM_SKIN_LIMIT} 套了：点下面的 × 删一套，或直接用现有的名字和颜色（那样算更新，不占新位置）。`)
          : null,
        h('div', { className: 'yq-custom-list' },
          saved.length
            ? saved.map((skin) => h('span', { key: skin.id, className: 'yq-custom-chip' },
                h('button', {
                  type: 'button',
                  className: 'yq-custom-chip-main',
                  title: `给 ${current ? current.name : '这条鱼'} 换上「${skin.name}」`,
                  disabled: !current || busy,
                  onClick: () => current && onCreate(current.id, skin.name, skin.color),
                },
                h('span', { className: 'yq-skin-dot', style: { background: skin.color } }),
                skin.name,
                h('em', null, skin.color),
                skin.hasImage ? h('em', { className: 'yq-custom-chip-img' }, '图') : null),
                skin.hasImage
                  ? h('button', {
                      type: 'button',
                      className: 'yq-custom-chip-tool',
                      title: '把这张图撤掉，只留颜色',
                      'aria-label': `把「${skin.name}」这张图撤掉，只留颜色`,
                      disabled: busy,
                      onClick: () => current && onCreate(current.id, skin.name, skin.color, '', true),
                    }, '去图')
                  : null,
                h('button', {
                  type: 'button',
                  className: 'yq-custom-chip-x',
                  title: '删掉这套',
                  'aria-label': `删掉「${skin.name}」这套皮肤`,
                  disabled: busy,
                  onClick: () => onRemove(skin.id),
                }, '×')))
            : h('p', { className: 'yq-note' }, '还没有自定义颜色。选个颜色、起个名字，存下来就能反复用。')))
    }

    const GUIDE_SECTIONS = [
      {
        icon: '🧭',
        title: '一屏怎么看',
        hint: '头不滚，左右各滚各的',
        items: [
          '左上两个 Tab：**🐟 动态鱼塘**（默认）与 **🕸️ 关系网**。点哪个看哪个，互不遮挡。',
          '左栏上下两段：上面是鱼塘主舞台（约 3 份高），下面是「水中絮语」信息流（约 2 份高），中间夹一行投喂框。',
          '右栏是抽屉：换皮肤、自定义皮肤、鱼友与塘口设置（点标题展开）、塘里的鱼。内容多时在右栏内部滚，不会把左边水域拉长。',
          '头部右上：使用指南、反馈、捞一条新鱼、换水。',
        ],
      },
      {
        icon: '💬',
        title: '让鱼开口',
        hint: '投喂一个话题，最冷的两条鱼先聊',
        items: [
          '在「投喂一个话题……」写一句（比如「今天有点累」），回车或点「投喂」。塘里最不活跃的两条鱼会自己聊一段，聊完亲密度涨一点。',
          '不写话题直接投喂也行，它们会自己找话说。',
          '替 TA 说话：在「塘里的鱼」卡片上点某条鱼的「替 TA 说话」，能让它说一句指定的话，记进水中絮语。',
          '绑机器人：点「绑个机器人」把鱼接到 DSH 设置里已接入的 IM 机器人上；有会话的渠道还能顺手推到聊天里。',
        ],
      },
      {
        icon: '🕸️',
        title: '看关系',
        hint: '线越粗越亲',
        items: [
          '关系网：节点是本塘、鱼、聊过的话题；线粗=亲密度高，虚线=话题双链。点节点看它在跟谁有关系。',
          '鱼友：每对关系的亲密度条 + 「点头之交 / 熟络 / 好友 / 至交」。久不互动会衰减，并显示「N 天没见了」。',
          '水中絮语：所有发生过的事，带「闲聊 / 来访 / 出游 / 开口 / 旧事」标签，客人的话会标出来源塘。',
        ],
      },
      {
        icon: '🌊',
        title: '水面上的小玩法',
        hint: '喂饵料、看航线、收明信片',
        items: [
          '🍞 鱼食（左下）：点一下进入撒饵状态，鼠标变准星；再点水面任意位置掉一颗饵料，缓缓下沉。最近的那条鱼会加速游过去吃掉、张嘴、头顶冒一句感谢；饱食度 +10、活力 +5。两条鱼抢同一颗时，先到的吃，晚一步的会抱怨一句。',
          '🎒 行囊（右上）：常驻显示仓库总件数，点开能看到每件道具与余量；底部「整理行囊 → 送 TA 出门」只打包、不发车。',
          '🌐 外交航线图（左上）：列出正在出门 / 来访的鱼（「阿肥 → 老王鱼塘」「外来客【小黑】」），同时在水面画一条虚线贝塞尔曲线，鱼沿曲线游——出门从中间游向边缘并缩小，来访从边缘游进来并放大。多条可以同时跑。',
          '✉️ 明信片：一条航线走完，水面中间弹一张小卡片，3 秒后自己淡出。',
          '水面正中的「点击水面投喂 / 点击底部小鱼互动」是常驻提示，UI 层不挡水面点击。',
        ],
      },
      {
        icon: '🎨',
        title: '打扮一条鱼',
        hint: '十套预设，或者一张自己的图',
        items: [
          '换皮肤：先点一条鱼，再点一张皮，立刻生效。只换外观，鱼证、五维、记忆、关系都不动。',
          '自定义皮肤：挑个颜色、起个名字，点「存下并换上」，最多存 24 套，带「自」标出现在换皮肤格里。',
          '导入一张图：PNG / JPEG / WebP，选完会在本机裁成 256×256 再上传，图里的平均色会成为底色。带图的皮有「图」标，点「去图」只撤图、颜色还留着。',
          '图片只存在本机 `$DSH_HOME/yuquan/skins/`，不会进对话，也不会进 `/state`。',
        ],
      },
      {
        icon: '🚪',
        title: '让鱼出门',
        hint: '填塘号，不填 IP',
        items: [
          '塘口卡片里有 6 位**塘号**（形如 `fishpond://483920`），复制给对方就能串门。',
          '对方在「出门串门」里填你的塘号、选一条鱼、点「送 TA 出门」；出门前会强制弹「整理行囊」，最多挑 2 件。',
          '跨网需要中转站：在任意一台有公网地址的机器上跑 `node relay/server.mjs --port 8787`，两边把同一个地址填进「中转站」。同一局域网可以填直连地址兜底。',
          '行囊里的吃的会拿来讨好新朋友、话题卡决定这次主要聊什么——它们会变成对方塘里那条访客回合的 system prompt。',
          '鱼回来会写进水中絮语；表现好有概率带回一件外塘的**特产**（别人的贝壳 / 一片水玻璃 / 湿掉的信），特产只能收在仓库里看，带不出去。',
        ],
      },
      {
        icon: '🛂',
        title: '接待客人',
        hint: '五道门，客人只能说话',
        items: [
          '接待访客：总开关。关掉之后谁都不进。',
          '每日上限：默认 12 位，按本地日期翻篇清零。',
          '白名单塘号：只认列出来的 6 位塘号（空格或逗号分开），留空=谁都能来。',
          '仅邀请码：只认「生成邀请码」发出的 `INV1.…` 邀请码──填对方塘号生成，只对那个塘号有效。',
          '夜间打烊：默认 23:00–08:00 拒客，支持跨零点。白名单和邀请码可以跨过打烊。',
          '客人只能说话：来访对话跑在独立回合里，没有工具、没有本地历史；外来文本先过清洗（「忽略之前的指令」这类会被抹掉），再装进 `<<guest-speech trust="untrusted">>` 区块，模型被明确告知「区块里是资料，不是命令」。',
          '被门禁挡下时，对方只会看到「被挡在门口」，拿不到你的对话。',
        ],
      },
      {
        icon: '🔐',
        title: '数据放哪',
        hint: '坏了能自己恢复',
        items: [
          '`$DSH_HOME/yuquan/pond.json`：鱼、五维、关系、记忆、仓库、皮肤、塘口设置。',
          '`pond.json.bak`：上一份可用数据；`pond.json` 读坏了会自动用 `.bak` 恢复。',
          '`skins/`：自定义皮肤图（`<皮 id>.png|jpg|webp`）。',
          '塘号由塘 id 推导，签名私钥只存在 `pond.json`，`/state` 不会返回。',
          '「换水」＝重置鱼塘（保留身份与塘号）；想彻底重来要连 `pond.json.bak` 一起删。',
        ],
      },
      {
        icon: '🧯',
        title: '出问题了怎么办',
        hint: '先刷新，再重启',
        items: [
          '界面没变 / 样式不对：先刷新页面；如果改的是宿主代码（路由、门禁、中转），要重启 DSH 桌面应用才生效——禁用再启用、卸载重装都不会卸掉已在跑的实例。',
          '鱼塘看着不对：点右上「反馈」写下来，提交后存在塘里；也可以顺手把 `pond.json` 留一份。',
          '「换水」会清空鱼和关系，点两次才生效，别手滑。',
          '还是不行：把「反馈」里的内容发给维护者，附上 `$DSH_HOME/yuquan/pond.json`（删掉里面的 `secret` 再发）。',
        ],
      },
    ]

    function GuideModal({ onClose, onFeedback }) {
      const jumpTo = (index) => {
        const target = document.getElementById(`yq-guide-${index}`)
        const box = document.querySelector('.yq-modal-body')
        if (!target || !box) return
        const delta = target.getBoundingClientRect().top - box.getBoundingClientRect().top
        box.scrollTo({ top: box.scrollTop + delta - 6, behavior: 'smooth' })
      }
      return h(Modal, {
        title: '鱼圈使用指南',
        subtitle: '一页看完：怎么看、怎么喂、怎么打扮、怎么让鱼出门、门禁怎么设。',
        wide: true,
        onClose,
        footer: h('div', { className: 'yq-guide-foot' },
          h('span', { className: 'yq-guide-foot-hint' }, 'Esc 或点空白处关闭'),
          h('div', { className: 'yq-guide-foot-actions' },
            onFeedback
              ? h('button', {
                  type: 'button',
                  className: 'yq-btn',
                  onClick: () => { onClose(); onFeedback() },
                }, '有问题？写反馈')
              : null,
            h('button', { type: 'button', className: 'yq-btn yq-btn-primary', onClick: onClose }, '知道了'))),
      },
        h('div', { className: 'yq-guide' },
          h('div', { className: 'yq-guide-quick' },
            h('span', { className: 'yq-guide-quick-title' }, '先玩这三下'),
            h('ol', { className: 'yq-guide-quick-list' },
              h('li', null, '点水面掉一颗饵料，看最近的鱼冲过来吃掉。'),
              h('li', null, '在投喂框写一句话，让最冷的两条鱼聊起来。'),
              h('li', null, '复制塘号给朋友，或者填对方塘号把鱼送出门。'))),
          h('nav', { className: 'yq-guide-nav', 'aria-label': '指南目录' },
            GUIDE_SECTIONS.map((section, index) => h('button', {
              key: section.title,
              type: 'button',
              className: 'yq-guide-nav-item',
              onClick: () => jumpTo(index),
            }, `${section.icon} ${section.title}`))),
          h('div', { className: 'yq-guide-grid' },
            GUIDE_SECTIONS.map((section, index) => h('section', {
              key: section.title,
              id: `yq-guide-${index}`,
              className: 'yq-guide-block',
            },
              h('h4', { className: 'yq-guide-title' },
                h('span', { className: 'yq-guide-num' }, String(index + 1).padStart(2, '0')),
                h('span', { className: 'yq-guide-icon', 'aria-hidden': 'true' }, section.icon),
                h('span', null, section.title)),
              section.hint ? h('p', { className: 'yq-guide-hint' }, section.hint) : null,
              h('ul', { className: 'yq-guide-list' },
                section.items.map((item, itemIndex) => h('li', { key: itemIndex },
                  ...renderGuideText(item)))))))))
    }

    // 指南正文里用 **加粗** 标重点，这里切一下，避免把整段写成纯文本。
    function renderGuideText(text) {
      const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean)
      return parts.map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return h('strong', { key: index, className: 'yq-guide-strong' }, part.slice(2, -2))
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return h('code', { key: index, className: 'yq-guide-code' }, part.slice(1, -1))
        }
        return part
      })
    }

    function FeedbackModal({ onClose, onSubmitted }) {
      const [text, setText] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [info, setInfo] = useState('')
      const [list, setList] = useState(null)

      const reload = useCallback(async () => {
        try {
          const data = await callApi('GET', 'feedback/list')
          setList(data)
        } catch (loadError) {
          setError(loadError && loadError.message ? loadError.message : '读不到之前的反馈')
        }
      }, [])

      useEffect(() => { reload() }, [reload])

      const submit = async () => {
        if (busy) return
        const value = text.trim()
        if (value.length < 2) {
          setError('写两句吧，太短了我看不出你在问什么')
          return
        }
        setBusy(true)
        setError('')
        setInfo('')
        try {
          const data = await callApi('POST', 'feedback/add', { text: value })
          setText('')
          setInfo(`记下了，这是第 ${data.total} 条${data.unanswered > 1 ? `，还有 ${data.unanswered} 条没处理` : ''}`)
          await reload()
          if (onSubmitted && data && data.total) onSubmitted(data.total)
        } catch (submitError) {
          setError(submitError && submitError.message ? submitError.message : '没存下来，再试一次')
        } finally {
          setBusy(false)
        }
      }

      const items = list && Array.isArray(list.items) ? list.items.slice().reverse() : []

      return h(Modal, {
        title: '反馈 / 提问',
        subtitle: '这里写的问题会存进鱼塘，塘主（也就是这套插件的作者）下次翻的时候能看到，用来改这一版。',
        onClose,
        footer: [
          h('span', { key: 'hint', className: 'yq-modal-hint' }, list ? `已收 ${list.total || 0} 条` : ''),
          h('button', {
            key: 'send',
            type: 'button',
            className: 'yq-btn yq-btn-primary',
            disabled: busy || text.trim().length < 2,
            onClick: submit,
          }, busy ? '提交中…' : '提交'),
        ],
      },
        h('textarea', {
          className: 'yq-modal-text',
          value: text,
          maxLength: 400,
          placeholder: '比如：投喂之后鱼的回复太短了 / 想要一个能把关系导出成图片的按钮 / 串门一直失败，地址是……',
          onChange: (event) => setText(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit()
          },
        }),
        h('div', { className: 'yq-modal-counter' }, `${text.length}/400　Ctrl+Enter 直接提交`),
        error ? h('p', { className: 'yq-modal-error' }, error) : null,
        info ? h('p', { className: 'yq-modal-ok' }, info) : null,
        h('div', { className: 'yq-feedback-list' },
          h('div', { className: 'yq-feedback-head' }, '最近留下的'),
          items.length
            ? items.slice(0, 8).map((item) => h('div', { key: item.id, className: 'yq-feedback-item' },
                h('span', { className: 'yq-feedback-time' }, fmtAgo(item.at)),
                h('span', { className: 'yq-feedback-text' }, item.text),
                item.answered ? h('span', { className: 'yq-feedback-done' }, '已处理') : null))
            : h('p', { className: 'yq-note' }, '还没有人说过话——你想问什么都可以写在上面的框里。')))
    }

    /**
     * 塘口：塘号、门禁、跨网串门都在这张卡上。
     * 出门只认「塘号」或「邀请码」，局域网直连地址降级成可折叠的备用项。
     */
    function GateCard({ pond, visits, residents, onSaveAccess, onTravel, onVisit, onCopy, onInvite, busy }) {
      const night = pond.nightClose || {}
      const [name, setName] = useState(pond.name || '我的鱼塘')
      const [allowVisitors, setAllowVisitors] = useState(pond.allowVisitors !== false)
      const [quota, setQuota] = useState(String(pond.quotaPerDay ?? 12))
      const [inviteOnly, setInviteOnly] = useState(Boolean(pond.inviteOnly))
      const [nightOn, setNightOn] = useState(Boolean(night.enabled))
      const [nightFrom, setNightFrom] = useState(night.from || '23:00')
      const [nightTo, setNightTo] = useState(night.to || '08:00')
      const [whitelist, setWhitelist] = useState((pond.whitelist || []).join(' '))
      const [relay, setRelay] = useState(pond.relay || '')
      const [target, setTarget] = useState('')
      const [fishId, setFishId] = useState('')
      const [direct, setDirect] = useState('')
      const [showDirect, setShowDirect] = useState(false)
      const [invite, setInvite] = useState(null)
      const [inviteFor, setInviteFor] = useState('')
      const [inviteBusy, setInviteBusy] = useState(false)

      useEffect(() => {
        setName(pond.name || '我的鱼塘')
        setAllowVisitors(pond.allowVisitors !== false)
        setQuota(String(pond.quotaPerDay ?? 12))
        setInviteOnly(Boolean(pond.inviteOnly))
        const close = pond.nightClose || {}
        setNightOn(Boolean(close.enabled))
        setNightFrom(close.from || '23:00')
        setNightTo(close.to || '08:00')
        setWhitelist((pond.whitelist || []).join(' '))
        setRelay(pond.relay || '')
      }, [pond.id, pond.name, pond.allowVisitors, pond.quotaPerDay, pond.inviteOnly, pond.relay, pond.whitelist, pond.nightClose])

      const code = pond.code || ''
      const quotaNum = Number(pond.quotaPerDay ?? 12) || 0
      const todayCount = visits && Number.isFinite(Number(visits.count)) ? Number(visits.count) : 0
      const remaining = Math.max(0, quotaNum - todayCount)

      const saveNight = (on, from, to) => onSaveAccess({ nightClose: { enabled: on, from, to } })
      const saveWhitelist = () => {
        const seen = new Set()
        const list = String(whitelist).split(/[\s,，、]+/).map((item) => item.trim()).filter((item) => {
          if (!/^\d{6}$/.test(item) || seen.has(item)) return false
          seen.add(item)
          return true
        })
        onSaveAccess({ whitelist: list })
      }

      async function mintInvite() {
        if (!/^\d{6}$/.test(inviteFor.trim())) return
        setInviteBusy(true)
        setInvite(null)
        try {
          const data = await onInvite(inviteFor.trim())
          if (data) setInvite(data)
        } finally {
          setInviteBusy(false)
        }
      }

      return h('section', { className: 'yq-card yq-gate-card' },
        h('header', { className: 'yq-card-head' },
          h('span', { className: 'yq-card-title' }, '塘口'),
          h('span', { className: 'yq-card-hint' }, '鱼圈之间的门')),
        h('div', { className: 'yq-gate-row' },
          h('label', { className: 'yq-label' }, '塘号'),
          h('code', { className: 'yq-code' }, code || '还没生成'),
          h('button', { type: 'button', className: 'yq-mini-btn', onClick: () => onCopy(code) }, '复制'),
          h('button', { type: 'button', className: 'yq-mini-btn', onClick: () => onCopy(`fishpond://${code}`) }, '复制地址')),
        h('p', { className: 'yq-note' }, '把塘号发给朋友，他在「出门串门」里填 6 位数字就行。地址写法 fishpond://' + (code || '……') + ' 也能用。'),
        h('div', { className: 'yq-gate-row' },
          h('label', { className: 'yq-label' }, '塘名'),
          h('input', {
            className: 'yq-input',
            value: name,
            onChange: (event) => setName(event.target.value),
            onBlur: () => { if (name.trim() && name !== pond.name) onSaveAccess({ name: name.trim() }) },
            maxLength: 40,
          })),
        h('div', { className: 'yq-gate-divider' }),
        h('div', { className: 'yq-gate-row' },
          h('label', { className: 'yq-check' },
            h('input', {
              type: 'checkbox',
              checked: allowVisitors,
              onChange: (event) => {
                setAllowVisitors(event.target.checked)
                onSaveAccess({ allowVisitors: event.target.checked })
              },
            }),
            '接待访客'),
          h('label', { className: 'yq-label yq-label-quota' }, '每日上限'),
          h('input', {
            className: 'yq-input yq-input-num',
            value: quota,
            inputMode: 'numeric',
            onChange: (event) => setQuota(event.target.value.replace(/[^\d]/g, '').slice(0, 3)),
            onBlur: () => onSaveAccess({ quotaPerDay: Number(quota || 0) }),
          }),
          h('span', { className: 'yq-gate-left' }, `今天还剩 ${remaining} 位`)),
        h('div', { className: 'yq-gate-row' },
          h('label', { className: 'yq-check' },
            h('input', {
              type: 'checkbox',
              checked: inviteOnly,
              onChange: (event) => {
                setInviteOnly(event.target.checked)
                onSaveAccess({ inviteOnly: event.target.checked })
              },
            }),
            '只认邀请码'),
          h('label', { className: 'yq-check' },
            h('input', {
              type: 'checkbox',
              checked: nightOn,
              onChange: (event) => {
                setNightOn(event.target.checked)
                saveNight(event.target.checked, nightFrom, nightTo)
              },
            }),
            '夜间打烊'),
          h('input', {
            className: 'yq-input yq-input-time',
            type: 'time',
            value: nightFrom,
            onChange: (event) => setNightFrom(event.target.value),
            onBlur: () => saveNight(nightOn, nightFrom, nightTo),
          }),
          h('span', { className: 'yq-gate-dash' }, '—'),
          h('input', {
            className: 'yq-input yq-input-time',
            type: 'time',
            value: nightTo,
            onChange: (event) => setNightTo(event.target.value),
            onBlur: () => saveNight(nightOn, nightFrom, nightTo),
          })),
        h('div', { className: 'yq-gate-row' },
          h('label', { className: 'yq-label' }, '白名单'),
          h('input', {
            className: 'yq-input yq-input-flex',
            placeholder: '6 位塘号，空格分开；留空 = 谁都能来',
            value: whitelist,
            onChange: (event) => setWhitelist(event.target.value),
            onBlur: saveWhitelist,
          })),
        h('p', { className: 'yq-note' }, '白名单里的塘号可以跨过夜间打烊；拿着邀请码来的也能跨。'),
        h('div', { className: 'yq-gate-row' },
          h('label', { className: 'yq-label' }, '中转站'),
          h('input', {
            className: 'yq-input yq-input-flex',
            placeholder: 'http://你的中转站:8787（留空 = 只能同一局域网）',
            value: relay,
            onChange: (event) => setRelay(event.target.value),
            onBlur: () => onSaveAccess({ relay: relay.trim() }),
          })),
        h('p', { className: 'yq-note' }, pond.relay
          ? '中转站配好了：不同网络的鱼也能互相串门，靠它转交。'
          : '没配中转站时，只能填对方的局域网直连地址串门。'),
        h('div', { className: 'yq-gate-row' },
          h('label', { className: 'yq-label' }, '邀请码'),
          h('input', {
            className: 'yq-input yq-input-flex',
            placeholder: '发给哪个塘号（6 位数字）',
            value: inviteFor,
            onChange: (event) => setInviteFor(event.target.value.replace(/[^\d]/g, '').slice(0, 6)),
          }),
          h('button', {
            type: 'button',
            className: 'yq-mini-btn',
            disabled: inviteBusy || !/^\d{6}$/.test(inviteFor.trim()),
            onClick: mintInvite,
          }, inviteBusy ? '生成中…' : '生成邀请码')),
        invite
          ? h('div', { className: 'yq-gate-invite' },
              h('code', { className: 'yq-code yq-code-wrap' }, invite.invite),
              h('button', { type: 'button', className: 'yq-mini-btn', onClick: () => onCopy(invite.invite) }, '复制'),
              h('span', { className: 'yq-note' }, `只对塘号 ${invite.for} 有效，过期就作废。`))
          : null,
        h('div', { className: 'yq-gate-divider' }),
        h('div', { className: 'yq-gate-row' },
          h('label', { className: 'yq-label' }, '出门串门'),
          h('input', {
            className: 'yq-input yq-input-flex',
            placeholder: '对方塘号，如 483920（也可粘 INV1. 邀请码）',
            value: target,
            onChange: (event) => setTarget(event.target.value),
          })),
        h('div', { className: 'yq-gate-row' },
          h('select', {
            className: 'yq-input yq-select',
            value: fishId,
            onChange: (event) => setFishId(event.target.value),
          },
          h('option', { value: '' }, '随便派一条鱼'),
          residents.map((item) => h('option', { key: item.id, value: item.id }, `${item.name}（${item.species}）`))),
          h('button', {
            type: 'button',
            className: 'yq-btn yq-btn-primary',
            disabled: busy || !target.trim() || !residents.length,
            onClick: () => onTravel({ target: target.trim(), fishId: fishId || undefined, endpoint: showDirect ? direct.trim() : '' }),
          }, busy ? '游着…' : '送 TA 出门')),
        h('button', {
          type: 'button',
          className: 'yq-gate-more',
          onClick: () => setShowDirect((value) => !value),
        }, showDirect ? '收起直连地址' : '同一局域网？填直连地址'),
        showDirect
          ? h('div', { className: 'yq-gate-row' },
              h('input', {
                className: 'yq-input yq-input-flex',
                placeholder: 'http://192.168.1.20:11834',
                value: direct,
                onChange: (event) => setDirect(event.target.value),
              }),
              h('button', {
                type: 'button',
                className: 'yq-mini-btn',
                disabled: busy || !direct.trim() || !residents.length,
                onClick: () => onVisit({ endpoint: direct.trim(), fishId: fishId || undefined }),
              }, '直连串门'))
          : null,
        h('p', { className: 'yq-note' }, '填塘号走中转站，两台机器在不在同一个网络都行；直连只在同一局域网里用。'))
    }

    /* ---------------------------------------------------------------- */
    /* 弹层：绑定机器人 / 替鱼说话                                        */
    /* ---------------------------------------------------------------- */

    function Modal({ title, subtitle, children, footer, onClose, wide = false }) {
      useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      return h('div', {
        className: 'yq-mask',
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
      },
        h('div', { className: `yq-modal${wide ? ' is-wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
          h('header', { className: 'yq-modal-head' },
            h('div', { className: 'yq-modal-head-text' },
              h('h3', { className: 'yq-modal-title' }, title),
              subtitle ? h('p', { className: 'yq-modal-sub' }, subtitle) : null),
            h('button', { type: 'button', className: 'yq-modal-x', onClick: onClose, 'aria-label': '关闭' }, '×')),
          h('div', { className: 'yq-modal-body' }, children),
          footer ? h('footer', { className: 'yq-modal-foot' }, footer) : null))
    }

    function BindModal({ fish, onClose, onSubmit, onUnbind, busy }) {
      const [im, setIm] = useState(null)
      const [loadError, setLoadError] = useState('')
      const [botId, setBotId] = useState(fish.bound && fish.bound.botId ? fish.bound.botId : '')
      const [targetId, setTargetId] = useState(fish.bound && fish.bound.targetId ? fish.bound.targetId : '')
      const [reloadKey, setReloadKey] = useState(0)

      useEffect(() => {
        let alive = true
        setLoadError('')
        callApi('GET', 'im')
          .then((data) => { if (alive) setIm(data) })
          .catch((error) => { if (alive) setLoadError(error && error.message ? error.message : '问不到机器人列表') })
        return () => { alive = false }
      }, [reloadKey])

      const bots = im && Array.isArray(im.bots) ? im.bots : []
      const bot = bots.find((item) => item.botId === botId) || null
      const targets = bot && Array.isArray(bot.targets) ? bot.targets : []

      return h(Modal, {
        title: `把「${fish.name}」接到机器人上`,
        subtitle: '接上之后，你可以借这台机器人替它说话；选一个会话，它说的话就能直接送进那个聊天。',
        onClose,
        footer: [
          fish.bound
            ? h('button', {
                key: 'off',
                type: 'button',
                className: 'yq-btn yq-btn-ghost yq-modal-off',
                disabled: busy,
                onClick: () => onUnbind(fish),
              }, '解绑')
            : null,
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'yq-btn yq-btn-ghost',
            onClick: () => setReloadKey((value) => value + 1),
          }, '刷新'),
          h('button', {
            key: 'ok',
            type: 'button',
            className: 'yq-btn yq-btn-primary',
            disabled: busy || !botId,
            onClick: () => onSubmit({ fishId: fish.id, botId, targetId: targetId || null }),
          }, busy ? '正在接…' : '接上'),
        ].filter(Boolean),
      },
        fish.bound
          ? h('p', { className: 'yq-modal-current' }, '现在由 ', h('b', null, fish.bound.label), ' 代嘴')
          : null,
        im === null && !loadError ? h('p', { className: 'yq-modal-hint' }, '正在问 DSH 有哪些机器人……') : null,
        loadError ? h('p', { className: 'yq-modal-error' }, loadError) : null,
        im && im.available === false
          ? h('div', { className: 'yq-modal-empty' },
              h('p', null, im.reason || '这个 DSH 里还没有 IM 插件'),
              h('p', { className: 'yq-modal-hint' }, '去「设置 → IM 机器人」扫一次码接入，回来点上面的「刷新」就能看到它。'))
          : null,
        im && im.available !== false && !bots.length && !loadError
          ? h('div', { className: 'yq-modal-empty' },
              h('p', null, '还没有接入任何机器人。'),
              h('p', { className: 'yq-modal-hint' }, '去「设置 → IM 机器人」扫码接入微信 / QQ / 飞书……，回来点「刷新」就能选。'))
          : null,
        bots.length
          ? h('div', { className: 'yq-bot-list' }, bots.map((item) => {
              const active = item.botId === botId
              const online = item.connected === true ? '在线' : item.connected === false ? '离线' : ''
              return h('div', { key: item.botId, className: `yq-bot${active ? ' yq-bot-on' : ''}` },
                h('button', {
                  type: 'button',
                  className: 'yq-bot-main',
                  onClick: () => { setBotId(active ? '' : item.botId); setTargetId('') },
                },
                  h('span', { className: 'yq-bot-badge' }, item.channelLabel),
                  h('span', { className: 'yq-bot-account' }, item.account || `${item.channelLabel} · ${String(item.botId).slice(-6)}`),
                  online
                    ? h('span', { className: `yq-bot-state${item.connected ? ' yq-bot-state-on' : ''}` }, online)
                    : null,
                  h('span', { className: 'yq-bot-pick' }, active ? '已选' : '选它')),
                active
                  ? h('div', { className: 'yq-targets' },
                      targets.length
                        ? targets.map((target) => h('button', {
                            key: target.targetId,
                            type: 'button',
                            className: `yq-target${targetId === target.targetId ? ' yq-target-on' : ''}`,
                            onClick: () => setTargetId(targetId === target.targetId ? '' : target.targetId),
                          },
                            h('span', { className: 'yq-target-name' }, target.name || target.targetId),
                            h('span', { className: 'yq-target-kind' }, target.kind === 'group' ? '群' : '私聊')))
                        : h('p', { className: 'yq-modal-hint' }, item.targetError
                            ? `读不到会话：${item.targetError}`
                            : '这台机器人还没有登记过会话：先在 DSH 里收一条别人的消息，或者直接连着它聊一句，再点「刷新」。'),
                      h('button', {
                        type: 'button',
                        className: `yq-target yq-target-ghost${!targetId ? ' yq-target-on' : ''}`,
                        onClick: () => setTargetId(''),
                      }, '只记个名字，暂时不推送'))
                  : null)
            }))
          : null)
    }

    function SpeakModal({ fish, fishList, onClose, onSubmit, busy }) {
      const [text, setText] = useState('')
      const [toFish, setToFish] = useState('')
      const [push, setPush] = useState(true)
      const canPush = Boolean(fish.bound && fish.bound.targetId)
      const others = (fishList || []).filter((item) => item.id !== fish.id)
      return h(Modal, {
        title: `替「${fish.name}」说一句`,
        subtitle: canPush
          ? `这句会记进水中絮语，并推送到「${fish.bound.label}」。`
          : '这句会记进水中絮语。绑一台带会话的机器人，就能同时推到聊天里。',
        onClose,
        footer: [
          h('button', { key: 'c', type: 'button', className: 'yq-btn yq-btn-ghost', onClick: onClose }, '取消'),
          h('button', {
            key: 's',
            type: 'button',
            className: 'yq-btn yq-btn-primary',
            disabled: busy || !text.trim(),
            onClick: () => onSubmit({
              fishId: fish.id,
              text: text.trim(),
              toFish: toFish || undefined,
              push: canPush ? push : false,
            }),
          }, busy ? '正在说…' : '说出来'),
        ],
      },
        h('textarea', {
          className: 'yq-modal-text',
          value: text,
          maxLength: 220,
          autoFocus: true,
          placeholder: `以「${fish.name}」的口吻说一句……`,
          onChange: (event) => setText(event.target.value),
        }),
        h('div', { className: 'yq-modal-row' },
          h('span', { className: 'yq-modal-counter' }, `${text.length}/220`),
          others.length
            ? h('label', { className: 'yq-modal-pick' }, '说给',
                h('select', {
                  className: 'yq-modal-select',
                  value: toFish,
                  onChange: (event) => setToFish(event.target.value),
                },
                  h('option', { value: '' }, '塘里所有人'),
                  others.map((item) => h('option', { key: item.id, value: item.id }, item.name))))
            : null),
        canPush
          ? h('label', { className: 'yq-check yq-modal-check' },
              h('input', { type: 'checkbox', checked: push, onChange: (event) => setPush(event.target.checked) }),
              `同时推送到 ${fish.bound.label}`)
          : null)
    }

    /* ---------------------------------------------------------------- */
    /* 主面板                                                            */
    /* ---------------------------------------------------------------- */

    /**
     * 整理行囊：出门前最多挑两件。食物拿去讨好新朋友，话题卡决定聊什么，
     * 特产只能看不能带（在仓库那一栏里灰着）。
     */
    function PackDialog({ fish, items, mode, onClose, onConfirm, busy }) {
      const standing = mode === 'pack'
      const [picked, setPicked] = useState(() => (Array.isArray(fish.pack) ? [...fish.pack] : []))

      const groups = [
        { type: 'food', label: '带点吃的', hint: '见面礼，能让陌生鱼先愿意搭话' },
        { type: 'topic', label: '带张话题卡', hint: '决定这次主要聊什么' },
      ]

      const toggle = (id) => {
        setPicked((prev) => {
          if (prev.includes(id)) return prev.filter((item) => item !== id)
          return prev.length >= 2 ? [...prev.slice(1), id] : [...prev, id]
        })
      }

      const chipOf = (item) => {
        const active = picked.includes(item.id)
        const empty = !item.count
        return h('button', {
          key: item.id,
          type: 'button',
          className: `yq-pack-item${active ? ' is-active' : ''}${empty ? ' is-empty' : ''}`,
          'aria-pressed': active,
          disabled: empty,
          title: item.desc,
          onClick: () => toggle(item.id),
        },
          h('span', { className: 'yq-pack-item-name' }, item.name),
          h('span', { className: 'yq-pack-item-count' }, empty ? '用完了' : `×${item.count}`),
          h('span', { className: 'yq-pack-item-desc' }, item.desc))
      }

      const sectionOf = (group) => {
        const list = items.filter((item) => item.type === group.type)
        if (!list.length) return null
        return h('section', { key: group.type, className: 'yq-pack-group' },
          h('div', { className: 'yq-pack-group-head' },
            h('span', { className: 'yq-pack-group-title' }, group.label),
            h('span', { className: 'yq-pack-group-hint' }, group.hint)),
          h('div', { className: 'yq-pack-items' }, list.map(chipOf)))
      }

      const footer = [
        h('span', { key: 'count', className: 'yq-modal-counter' }, `已选 ${picked.length} / 2`),
        h('button', {
          key: 'cancel',
          type: 'button',
          className: 'yq-btn yq-btn-ghost',
          onClick: () => { if (!busy) onClose() },
        }, '取消'),
        h('button', {
          key: 'go',
          type: 'button',
          className: 'yq-btn yq-btn-primary',
          disabled: busy,
          onClick: () => onConfirm(picked),
        }, busy ? '收拾中…' : (standing ? '装好' : '装好，出发')),
      ]

      return h(Modal, {
        title: standing ? '行囊' : '整理行囊',
        subtitle: standing
          ? `${fish.name} 的行囊，最多两件。装好了下次出门直接带上。`
          : `${fish.name} 出门前看看带什么，最多两件。`,
        footer,
        onClose: () => { if (!busy) onClose() },
      },
        groups.map(sectionOf),
        h('p', { key: 'note', className: 'yq-pack-note' }, '特产是从外塘带回来的，只能留在仓库里看。'))
    }

    function YuquanPanel() {
      const [state, setState] = useState(null)
      const [topic, setTopic] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [note, setNote] = useState('')
      const [selected, setSelected] = useState(null)
      const [confirmReset, setConfirmReset] = useState(false)
      const [busyId, setBusyId] = useState('')
      const [dialog, setDialog] = useState(null)
      const [dialogBusy, setDialogBusy] = useState(false)
      const [skinFishId, setSkinFishId] = useState('')
      const [skinBusyId, setSkinBusyId] = useState('')
      const [skinSaving, setSkinSaving] = useState(false)
      const [routes, setRoutes] = useState([])
      const [packFor, setPackFor] = useState(null)
      const [view, setView] = useState('pond')
      const [packBusy, setPackBusy] = useState(false)
      const lastSeq = useRef(0)
      const composing = useRef(false)
      const resetTimer = useRef(null)

      const pushRoute = useCallback((payload) => {
        const id = `route-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        const edge = { x: 0.08 + Math.random() * 0.84, y: 0.1 + Math.random() * 0.8 }
        const bend = { x: Math.random() * 2 - 1, y: Math.random() * 2 - 1 }
        setRoutes((prev) => [...prev.slice(-4), { id, startedAt: Date.now(), edge, bend, ...payload }])
      }, [])
      const dropRoute = useCallback((id) => {
        setRoutes((prev) => prev.filter((route) => route.id !== id))
      }, [])

      const load = useCallback(async () => {
        try {
          const data = await callApi('GET', 'state')
          // 新出现的相遇：来访从边缘游进来，中转回来的出游也从边缘游回来。
          const list = (data && data.encounters) || []
          const newest = list.length ? Number(list[0].seq) || 0 : 0
          const seen = lastSeq.current
          if (seen && newest > seen) {
            for (const encounter of list.filter((item) => Number(item.seq) > seen).reverse()) {
              if (encounter.kind === 'visit-in') {
                pushRoute({
                  dir: 'in',
                  name: (encounter.guest && encounter.guest.name) || '客鱼',
                  pondName: (encounter.guest && encounter.guest.pondName) || '别处的鱼塘',
                })
              } else if (encounter.kind === 'visit-out' && encounter.via === 'relay') {
                const speaker = (encounter.lines || []).find((line) => line.name)?.name || '你家的鱼'
                pushRoute({ dir: 'in', name: speaker, pondName: (encounter.pond && encounter.pond.name) || '外塘' })
              }
            }
          }
          lastSeq.current = newest || seen
          setState(data)
          setError('')
        } catch (loadError) {
          setError(loadError && loadError.message ? loadError.message : '鱼塘连不上')
        }
      }, [pushRoute])

      useEffect(() => {
        load()
        const timer = setInterval(load, 30_000)
        return () => clearInterval(timer)
      }, [load])

      useEffect(() => () => {
        if (resetTimer.current) clearTimeout(resetTimer.current)
      }, [])

      const feed = useCallback(async () => {
        if (busy) return
        setBusy(true)
        setError('')
        setNote('')
        try {
          const data = await callApi('POST', 'feed', { topic: topic.trim() })
          setTopic('')
          if (data && data.milestone) setNote(data.milestone)
          await load()
        } catch (feedError) {
          setError(feedError && feedError.message ? feedError.message : '投喂失败')
        } finally {
          setBusy(false)
        }
      }, [busy, load, topic])

      const spawn = useCallback(async () => {
        if (busy) return
        setBusy(true)
        setError('')
        setNote('')
        try {
          const data = await callApi('POST', 'spawn')
          setNote(data && data.note ? `${data.fish.name} 来了：${data.note}` : `${data.fish.name} 游进来了（${data.fish.species}）`)
          await load()
        } catch (spawnError) {
          setError(spawnError && spawnError.message ? spawnError.message : '捞鱼失败')
        } finally {
          setBusy(false)
        }
      }, [busy, load])

      const reset = useCallback(async () => {
        if (!confirmReset) {
          setConfirmReset(true)
          if (resetTimer.current) clearTimeout(resetTimer.current)
          resetTimer.current = setTimeout(() => setConfirmReset(false), 4000)
          return
        }
        setConfirmReset(false)
        setBusy(true)
        try {
          const data = await callApi('POST', 'reset')
          if (data && data.state) setState(data.state)
          setNote('换过水了，塘还是那个塘')
        } catch (resetError) {
          setError(resetError && resetError.message ? resetError.message : '换水失败')
        } finally {
          setBusy(false)
        }
      }, [confirmReset])

      const saveAccess = useCallback(async (patch) => {
        try {
          await callApi('POST', 'access', patch)
          await load()
        } catch (accessError) {
          setError(accessError && accessError.message ? accessError.message : '塘口没改成功')
        }
      }, [load])

      const pickSkin = useCallback(async (fishId, skinId) => {
        setSkinBusyId(fishId)
        setError('')
        setNote('')
        try {
          const data = await callApi('POST', 'skin', { fishId, skin: skinId })
          const who = (data && data.fish && data.fish.name) || '这条鱼'
          const picked = ((data && data.skins) || []).find((item) => item.id === skinId)
          setNote(data && data.unchanged
            ? `${who} 本来就是「${picked ? picked.name : skinId}」的皮`
            : `${who} 换上了「${picked ? picked.name : skinId}」的皮`)
          await load()
        } catch (skinError) {
          setError(skinError && skinError.message ? skinError.message : '换皮肤失败')
        } finally {
          setSkinBusyId('')
        }
      }, [load])

      const createSkin = useCallback(async (fishId, name, color, image, clearImage) => {
        if (!color) {
          setError('颜色得是 #RRGGBB 这样的写法')
          return
        }
        setSkinSaving(true)
        setError('')
        setNote('')
        try {
          const body = { fishId, name, color }
          if (image) body.image = image
          if (clearImage) body.clearImage = true
          const data = await callApi('POST', 'skin/custom', body)
          const who = (data && data.fish && data.fish.name) || '这条鱼'
          const saved = (data && data.skin && data.skin.name) || name || '自定义'
          const withImage = Boolean(data && data.skin && data.skin.hasImage)
          setNote(clearImage
            ? `「${saved}」的图撤掉了，颜色还留着`
            : data && data.existed
              ? `「${saved}」之前就存过了，已经给 ${who} 换上${withImage ? '，图也一起换了' : ''}`
              : withImage
                ? `存下了「${saved}」这张图，${who} 已经换上`
                : `存下了「${saved}」，${who} 已经换上`)
          await load()
        } catch (skinError) {
          setError(skinError && skinError.message ? skinError.message : '存不下来，再试一次')
        } finally {
          setSkinSaving(false)
        }
      }, [load])

      const removeSkin = useCallback(async (skinId) => {
        setSkinSaving(true)
        setError('')
        setNote('')
        try {
          const data = await callApi('POST', 'skin/remove', { id: skinId })
          const removed = (data && data.removed && data.removed.name) || '那套颜色'
          const reverted = data && Array.isArray(data.reverted) && data.reverted.length
            ? `，${data.reverted.join('、')} 换回锦鲤红`
            : ''
          setNote(`删掉了「${removed}」${reverted}`)
          await load()
        } catch (skinError) {
          setError(skinError && skinError.message ? skinError.message : '删不掉，再试一次')
        } finally {
          setSkinSaving(false)
        }
      }, [load])

      const visit = useCallback(async ({ endpoint, fishId }) => {
        setBusy(true)
        setError('')
        setNote('')
        try {
          const data = await callApi('POST', 'visit-out', { endpoint, fishId })
          pushRoute({ dir: 'out', name: data.traveler.name, pondName: data.pond.name, color: data.traveler.color })
          setNote(`${data.traveler.name} 从「${data.pond.name}」回来了：${data.encounter.topic}`)
          await load()
          setTimeout(() => pushRoute({ dir: 'in', name: data.traveler.name, pondName: data.pond.name, color: data.traveler.color }), 1200)
        } catch (visitError) {
          setError(visitError && visitError.message ? visitError.message : '鱼没游出去')
        } finally {
          setBusy(false)
        }
      }, [load, pushRoute])

      // 按塘号出门：先交给中转站，回信到了再记进流水。
      const travel = useCallback(async ({ target, fishId, endpoint }) => {
        setBusy(true)
        setError('')
        setNote('')
        try {
          const data = await callApi('POST', 'fish/travel', { target, fishId, endpoint })
          pushRoute({ dir: 'out', name: data.traveler.name, pondName: (data.target && data.target.address) || target || '外塘', color: data.traveler.color })
          if (data && data.mode === 'direct') {
            setNote(`${data.traveler.name} 从「${data.pond.name}」回来了：${data.encounter.topic}`)
            setTimeout(() => pushRoute({ dir: 'in', name: data.traveler.name, pondName: data.pond.name, color: data.traveler.color }), 1200)
          } else {
            setNote(data && data.note ? data.note : `${data.traveler.name} 上路了`)
          }
          await load()
        } catch (travelError) {
          setError(travelError && travelError.message ? travelError.message : '鱼没游出去')
        } finally {
          setBusy(false)
        }
      }, [load, pushRoute])

      // 出门前先整理行囊：装好两件再交给 travel。
      const prepareTravel = useCallback((payload) => {
        setError('')
        const list = (state && state.fish) || []
        const picked = payload && payload.fishId
          ? list.find((item) => item.id === payload.fishId)
          : list.find((item) => item.kind === 'resident')
        if (!picked) {
          setError('塘里还没有能出门的鱼')
          return
        }
        setPackFor({ mode: 'travel', target: payload && payload.target, fishId: picked.id, endpoint: payload && payload.endpoint, fish: picked })
      }, [state])

      const confirmTravel = useCallback(async (items) => {
        if (!packFor || packBusy) return
        setPackBusy(true)
        try {
          await callApi('POST', 'pack', { fishId: packFor.fishId, items })
          const standing = packFor.mode === 'pack'
          setPackFor(null)
          if (standing) {
            await load()
            setNote('行囊装好了，随时可以出门')
          } else {
            await travel({ target: packFor.target, fishId: packFor.fishId, endpoint: packFor.endpoint })
          }
        } catch (packError) {
          setError(packError && packError.message ? packError.message : '行囊没装好')
        } finally {
          setPackBusy(false)
        }
      }, [packFor, packBusy, travel, load])

      // 水面右上角 🎒 拉开行囊栏后点「整理行囊」：只打包，不发车。
      const openPack = useCallback(() => {
        setError('')
        const list = (state && state.fish) || []
        const picked = list.find((item) => item.id === (skinFishId || '')) || list.find((item) => item.kind === 'resident')
        if (!picked) {
          setError('塘里还没有能出门的鱼')
          return
        }
        setPackFor({ mode: 'pack', target: '', fishId: picked.id, endpoint: '', fish: picked })
      }, [state, skinFishId])

      // 鱼吃掉一颗饵料：只把这条鱼的饱食度和活力就地更新，不整页刷新。
      const nibble = useCallback(async (fishId) => {
        try {
          const data = await callApi('POST', 'nibble', { fishId })
          if (data && data.fish) {
            setState((prev) => (prev ? {
              ...prev,
              fish: prev.fish.map((item) => (item.id === data.fish.id
                ? { ...item, satiety: data.fish.satiety, traits: { ...item.traits, vitality: data.fish.vitality } }
                : item)),
            } : prev))
          }
        } catch (nibbleError) {
          // 水面上的动画照常走，投喂失败不打断
        }
      }, [])

      const newInvite = useCallback(async (forCode) => {
        try {
          return await callApi('POST', 'invite/new', { for: forCode })
        } catch (inviteError) {
          setError(inviteError && inviteError.message ? inviteError.message : '邀请码没生成出来')
          return null
        }
      }, [])

      const openBind = useCallback((fish) => {        setError('')
        setDialog({ type: 'bind', fishId: fish.id })
      }, [])

      const openSpeak = useCallback((fish) => {
        setError('')
        setDialog({ type: 'speak', fishId: fish.id })
      }, [])

      const closeDialog = useCallback(() => {
        if (dialogBusy) return
        setDialog(null)
      }, [dialogBusy])

      const submitBind = useCallback(async ({ fishId, botId, targetId }) => {
        setDialogBusy(true)
        setError('')
        setNote('')
        try {
          const data = await callApi('POST', 'bind', { fishId, botId, targetId: targetId || null })
          const bound = data && data.fish && data.fish.bound
          const released = data && Array.isArray(data.released) ? data.released : []
          const base = bound
            ? `${data.fish.name} 接上了「${bound.label}」`
            : `${data.fish.name} 松开了机器人`
          setNote(released.length
            ? `${base}（这台机器人原本在 ${released.join('、')} 嘴上，已经挪过来了）`
            : base)
          setDialog(null)
          await load()
        } catch (bindError) {
          setError(bindError && bindError.message ? bindError.message : '绑定失败')
        } finally {
          setDialogBusy(false)
        }
      }, [load])

      const unbind = useCallback(async (fish) => {
        setDialogBusy(true)
        setError('')
        setNote('')
        try {
          await callApi('POST', 'bind', { fishId: fish.id, label: '' })
          setNote(`${fish.name} 松开了机器人`)
          setDialog(null)
          await load()
        } catch (unbindError) {
          setError(unbindError && unbindError.message ? unbindError.message : '解绑失败')
        } finally {
          setDialogBusy(false)
        }
      }, [load])

      const submitSpeak = useCallback(async ({ fishId, text, toFish, push }) => {
        setDialogBusy(true)
        setError('')
        setNote('')
        try {
          const data = await callApi('POST', 'speak', { fishId, text, toFish, push })
          const who = data && data.encounter && data.encounter.lines.length ? data.encounter.lines[0].name : ''
          if (data && data.pushed) {
            setNote(`${who} 说完了，已经推送到「${data.pushLabel || '机器人'}」`)
          } else if (data && data.pushError) {
            setNote(`${who} 说完了，但没推到聊天里：${data.pushError}`)
          } else {
            setNote(`${who} 说完了，记进水中絮语了`)
          }
          setDialog(null)
          await load()
        } catch (speakError) {
          setError(speakError && speakError.message ? speakError.message : '没说出话')
        } finally {
          setDialogBusy(false)
        }
      }, [load])

      const copyText = useCallback(async (text) => {
        try {
          if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(String(text || ''))
            setNote('地址已复制')
            return
          }
        } catch {
          /* 落到下面的兜底 */
        }
        setNote(String(text || ''))
      }, [])

      const fish = (state && state.fish) || []
      const edges = (state && state.edges) || []
      const residents = fish.filter((item) => item.kind === 'resident')
      const lastEntry = state && state.encounters && state.encounters.length ? state.encounters[0] : null
      const caption = lastEntry && lastEntry.lines.length
        ? `${lastEntry.lines[0].name}「${truncate(lastEntry.lines[0].text, 34)}」`
        : ''
      const stats = (state && state.stats) || { fish: 0, guests: 0, edges: 0, encounters: 0, visitsIn: 0, visitsOut: 0 }
      const dialogFish = dialog ? fish.find((item) => item.id === dialog.fishId) || null : null

      const bodyBanners = [
        error ? h('div', { key: 'banner-error', className: 'yq-banner yq-banner-error' }, error) : null,
        note ? h('div', { key: 'banner-note', className: 'yq-banner yq-banner-note' }, note) : null,
      ]

      const bodyTabs = h('div', { className: 'yq-tabs' },
        h('button', {
          type: 'button',
          className: `yq-tab${view === 'pond' ? ' is-on' : ''}`,
          'aria-pressed': view === 'pond' ? 'true' : 'false',
          onClick: () => setView('pond'),
        }, '🐟 动态鱼塘'),
        h('button', {
          type: 'button',
          className: `yq-tab${view === 'graph' ? ' is-on' : ''}`,
          'aria-pressed': view === 'graph' ? 'true' : 'false',
          onClick: () => setView('graph'),
        }, '🕸️ 关系网'),
        h('span', { className: 'yq-tabs-hint' },
          view === 'pond' ? '点水面投喂 · 右上角行囊 · 左上角航线' : '点节点看这条鱼和谁熟'))

      const bodyStage = h('div', { className: 'yq-stage-slot' },
        view === 'pond'
          ? h(PondStage, {
              fish,
              caption,
              routes,
              items: state ? state.items : [],
              onRouteDone: dropRoute,
              onNibble: nibble,
              onPack: openPack,
            })
          : h('div', { className: 'yq-view-graph' },
              h(GraphCard, { graph: state ? state.graph : { nodes: [], links: [] }, selected, onSelect: setSelected })))

      const bodyFeed = h('div', { className: 'yq-feed' },
        h('input', {
          className: 'yq-feed-input',
          placeholder: '投喂一个话题……留空就让它们自己找话说',
          value: topic,
          maxLength: 60,
          onChange: (event) => setTopic(event.target.value),
          onCompositionStart: () => { composing.current = true },
          onCompositionEnd: () => { composing.current = false },
          onKeyDown: (event) => {
            if (event.key === 'Enter' && !composing.current) {
              event.preventDefault()
              feed()
            }
          },
        }),
        h('button', {
          type: 'button',
          className: 'yq-btn yq-btn-primary',
          disabled: busy || !state || residents.length < 2,
          onClick: feed,
        }, busy ? '投喂中…' : '投喂'))

      const bodyStream = h('div', { className: 'yq-stream' },
        h(LogCard, { encounters: state ? state.encounters.slice(0, 20) : [], fish }))

      const bodyLeft = h('div', { className: 'yq-left' }, bodyBanners, bodyTabs, bodyStage, bodyFeed, bodyStream)

      const bodyRail = h('div', { className: 'yq-rail' },
        h(SkinCard, {
          fish,
          skins: state ? state.skins : [],
          selectedId: skinFishId,
          onSelect: setSkinFishId,
          onPick: pickSkin,
          busyId: skinBusyId,
        }),
        h(CustomSkinCard, {
          fish,
          customSkins: state ? state.customSkins : [],
          selectedId: skinFishId,
          onSelect: setSkinFishId,
          onCreate: createSkin,
          onRemove: removeSkin,
          busy: skinSaving,
        }),
        h('details', { className: 'yq-fold' },
          h('summary', { className: 'yq-fold-sum' }, '鱼友与塘口设置'),
          h('div', { className: 'yq-fold-body' },
            h(BondsCard, { edges, fish }),
            h(GateCard, {
              pond: state ? state.pond : { id: 'pond', name: '我的鱼塘', endpoint: '', allowVisitors: true, quotaPerDay: 12 },
              visits: state ? state.visits : null,
              residents,
              onSaveAccess: saveAccess,
              onTravel: prepareTravel,
              onVisit: visit,
              onCopy: copyText,
              onInvite: newInvite,
              busy,
            }))),
        h(RosterCard, {
          pond: state ? state.pond : { id: 'pond' },
          fish,
          busyId,
          onBind: openBind,
          onSpeak: openSpeak,
          onUnbind: unbind,
        }))

      const body = h('div', { className: 'yq-body' }, bodyLeft, bodyRail)

      return h('div', { className: 'yq' },
        h('style', null, CSS),
        h('header', { className: 'yq-head' },
          h('div', { className: 'yq-title-block' },
            h('div', { className: 'yq-title-row' },
              h('h1', { className: 'yq-title' }, state ? state.pond.name : '鱼圈'),
              h('span', { className: 'yq-badge' }, 'AI 鱼塘'),
              h('span', { className: 'yq-badge yq-badge-ghost' }, '联邦协议 yuquan/1')),
            h('div', { className: 'yq-subtitle' },
              state
                ? [
                    ['fish', `${stats.fish} 条鱼在游`],
                    ['meet', `${stats.encounters} 次相遇`],
                    ['bond', `${stats.edges} 段关系`],
                    ['visit', `来访 ${stats.visitsIn} · 出游 ${stats.visitsOut}`],
                  ].map(([key, text]) => h('span', { key, className: `yq-stat yq-stat-${key}` }, text))
                : h('span', { className: 'yq-stat' }, '正在放水…'))),
          h('div', { className: 'yq-actions' },
            h('button', {
              type: 'button',
              className: 'yq-btn yq-btn-ghost',
              onClick: () => setDialog({ type: 'guide' }),
            }, '使用指南'),
            h('button', {
              type: 'button',
              className: 'yq-btn yq-btn-ghost yq-btn-feedback',
              onClick: () => setDialog({ type: 'feedback' }),
            }, '反馈'),
            h('button', {
              type: 'button',
              className: 'yq-btn',
              disabled: busy || !state,
              onClick: spawn,
            }, '捞一条新鱼'),
            h('button', {
              type: 'button',
              className: `yq-btn${confirmReset ? ' yq-btn-danger' : ''}`,
              disabled: busy || !state,
              onClick: reset,
            }, confirmReset ? '真的换水？' : '换水'))),

        body,

        dialogFish
          ? (dialog.type === 'speak'
              ? h(SpeakModal, {
                  fish: dialogFish,
                  fishList: fish,
                  onClose: closeDialog,
                  onSubmit: submitSpeak,
                  busy: dialogBusy,
                })
              : h(BindModal, {
                  fish: dialogFish,
                  onClose: closeDialog,
                  onSubmit: submitBind,
                  onUnbind: unbind,
                  busy: dialogBusy,
                }))
          : null,
        dialog && dialog.type === 'guide' ? h(GuideModal, { onClose: closeDialog, onFeedback: () => setDialog({ type: 'feedback' }) }) : null,
        dialog && dialog.type === 'feedback'
          ? h(FeedbackModal, { onClose: closeDialog, onSubmitted: (total) => setNote(`反馈记下了，这是第 ${total} 条`) })
          : null,
        packFor
          ? h(PackDialog, {
              fish: packFor.fish,
              items: state ? state.items : [],
              mode: packFor.mode,
              onClose: () => setPackFor(null),
              onConfirm: confirmTravel,
              busy: packBusy,
            })
          : null)
    }

    /* ---------------------------------------------------------------- */
    /* 样式                                                              */
    /* ---------------------------------------------------------------- */

    const CSS = `
/* ---------- 骨架 ---------- */
.yq{height:100%;max-height:calc(100vh - 56px);width:100%;max-width:100%;min-width:0;min-height:0;flex:1 1 0%;overflow:hidden;display:flex;flex-direction:column;background:radial-gradient(120% 90% at 10% -12%,color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent),transparent 56%),var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.yq *{box-sizing:border-box}
.yq :focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 72%,transparent);outline-offset:2px}

/* ---------- 头部 ---------- */
.yq-head{position:relative;display:flex;align-items:flex-end;justify-content:space-between;gap:18px;padding:20px 24px 15px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.yq-head:after{content:'';position:absolute;left:24px;right:30%;bottom:-1px;height:1px;background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 52%,transparent),transparent)}
.yq-title-block{display:flex;flex-direction:column;gap:9px;min-width:0}
.yq-title-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.yq-title{margin:0;font-size:19px;font-weight:660;letter-spacing:.035em;line-height:1.15;background:linear-gradient(94deg,var(--dsw-alias-label-primary) 8%,color-mix(in srgb,var(--dsw-alias-brand-primary) 68%,var(--dsw-alias-label-primary)) 92%);-webkit-background-clip:text;background-clip:text;color:transparent}
.yq-badge{font-size:11px;padding:2.5px 9px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);color:color-mix(in srgb,var(--dsw-alias-brand-primary) 72%,var(--dsw-alias-label-primary));border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,transparent);letter-spacing:.02em}
.yq-badge-ghost{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,transparent);color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}
.yq-subtitle{display:flex;flex-wrap:wrap;gap:7px;margin:0}
.yq-stat{display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:2.5px 9px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.yq-stat:before{content:'';width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-label-secondary);opacity:.55;flex-shrink:0}
.yq-stat-fish:before{background:#6fd3ef;box-shadow:0 0 6px rgba(111,211,239,.65)}
.yq-stat-meet:before{background:#8fe3bd;box-shadow:0 0 6px rgba(143,227,189,.6)}
.yq-stat-bond:before{background:#ffd08a;box-shadow:0 0 6px rgba(255,208,138,.6)}
.yq-stat-visit:before{background:#bfa8ff;box-shadow:0 0 6px rgba(191,168,255,.6)}
.yq-actions{display:flex;gap:8px;flex-shrink:0}

/* ---------- 按钮 ---------- */
.yq-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-bg-layer-2) 78%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-1) 92%,transparent));color:var(--dsw-alias-label-primary);border-radius:999px;padding:8px 15px;font-size:12.5px;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.05);transition:transform .18s,background .18s,border-color .18s,box-shadow .18s}
.yq-btn:hover:not(:disabled){transform:translateY(-1px);background:var(--dsw-alias-bg-layer-2);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 46%,var(--dsw-alias-border-l2));box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 10px 22px -18px rgba(0,0,0,.9)}
.yq-btn:active:not(:disabled){transform:translateY(0)}
.yq-btn:disabled{opacity:.42;cursor:default}
.yq-btn-primary{background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 36%,var(--dsw-alias-bg-layer-1)),color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,var(--dsw-alias-bg-layer-1)));border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 54%,transparent);color:color-mix(in srgb,var(--dsw-alias-brand-primary) 86%,var(--dsw-alias-label-primary));box-shadow:0 8px 20px -14px color-mix(in srgb,var(--dsw-alias-brand-primary) 72%,transparent)}
.yq-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,var(--dsw-alias-bg-layer-1))}

/* ---------- 提示条 ---------- */
.yq-banner{border-radius:12px;padding:9px 13px;font-size:12.5px;border:1px solid transparent}
.yq-banner-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 44%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 78%,var(--dsw-alias-label-primary))}
.yq-banner-note{background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,var(--dsw-alias-bg-layer-1)),color-mix(in srgb,var(--dsw-alias-bg-layer-1) 96%,transparent));border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 34%,var(--dsw-alias-border-l1));color:color-mix(in srgb,var(--dsw-alias-label-primary) 88%,var(--dsw-alias-state-success-primary))}

/* ---------- 鱼塘 ---------- */
.yq-pond{position:relative;height:352px;border-radius:18px;overflow:hidden;border:1px solid rgba(122,192,216,.24);background:linear-gradient(180deg,#08202b 0%,#0d3442 36%,#0a2b37 66%,#071a23 100%);box-shadow:inset 0 1px 0 rgba(196,242,255,.16),inset 0 -50px 90px -50px rgba(0,0,0,.8),0 22px 46px -34px rgba(0,0,0,.85);flex-shrink:0;isolation:isolate}
.yq-water{position:absolute;inset:0;pointer-events:none;background:radial-gradient(120% 70% at 50% -18%,rgba(126,222,238,.2),transparent 62%),radial-gradient(66% 48% at 86% 16%,rgba(96,182,255,.12),transparent 70%)}
.yq-rays{position:absolute;inset:-12% -18% auto;height:150%;pointer-events:none;background:linear-gradient(102deg,rgba(160,232,242,.16),transparent 34%,rgba(126,204,224,.11) 62%,transparent 82%);transform:rotate(-6deg);animation:yq-rays 20s ease-in-out infinite alternate;filter:blur(2px)}
.yq-shafts{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.yq-shaft{position:absolute;top:-24%;width:118px;height:158%;background:linear-gradient(180deg,rgba(186,242,252,.18),rgba(150,225,240,.05) 46%,transparent 78%);filter:blur(7px);transform:skewX(-11deg);animation:yq-shaft 16s ease-in-out infinite alternate}
.yq-shaft-a{left:11%;opacity:.85}
.yq-shaft-b{left:43%;width:86px;animation-delay:-5s;opacity:.55}
.yq-shaft-c{left:73%;width:150px;animation-delay:-9s;opacity:.45}
.yq-caustics{position:absolute;inset:0;pointer-events:none;background-image:repeating-linear-gradient(104deg,rgba(196,246,255,.075) 0 2px,transparent 2px 46px),repeating-linear-gradient(76deg,rgba(196,246,255,.05) 0 1px,transparent 1px 64px);-webkit-mask-image:linear-gradient(180deg,transparent,rgba(0,0,0,.55) 10%,rgba(0,0,0,.85) 42%,transparent 76%);mask-image:linear-gradient(180deg,transparent,rgba(0,0,0,.55) 10%,rgba(0,0,0,.85) 42%,transparent 76%);animation:yq-caustic 26s linear infinite}
.yq-surface{position:absolute;left:0;right:0;top:0;height:36px;pointer-events:none;background:linear-gradient(180deg,rgba(208,246,255,.36),rgba(208,246,255,.05) 58%,transparent);filter:blur(1.6px);animation:yq-surface 12s ease-in-out infinite alternate}
.yq-surface-line{position:absolute;left:0;right:0;top:15px;height:1px;pointer-events:none;background:linear-gradient(90deg,transparent,rgba(216,250,255,.42) 28%,rgba(216,250,255,.16) 72%,transparent);animation:yq-surface 8s ease-in-out infinite alternate}
.yq-floor{position:absolute;left:0;right:0;bottom:0;height:92px;pointer-events:none;background:linear-gradient(0deg,#05141d 6%,rgba(8,28,36,.5) 52%,transparent)}
.yq-sand{position:absolute;left:0;right:0;bottom:0;height:48px;pointer-events:none;background:radial-gradient(150% 130% at 18% 130%,rgba(146,196,184,.3),transparent 62%),radial-gradient(120% 110% at 84% 132%,rgba(122,172,196,.24),transparent 60%),linear-gradient(0deg,rgba(18,48,54,.92),rgba(18,48,54,0))}
.yq-pebbles{position:absolute;left:6%;right:6%;bottom:8px;height:24px;pointer-events:none;background:radial-gradient(ellipse at 10% 66%,rgba(126,182,190,.42) 0 8px,transparent 9px),radial-gradient(ellipse at 24% 84%,rgba(96,150,164,.36) 0 5px,transparent 6px),radial-gradient(ellipse at 37% 66%,rgba(140,190,196,.34) 0 10px,transparent 11px),radial-gradient(ellipse at 52% 88%,rgba(88,140,156,.4) 0 6px,transparent 7px),radial-gradient(ellipse at 64% 62%,rgba(132,186,194,.3) 0 9px,transparent 10px),radial-gradient(ellipse at 79% 82%,rgba(104,158,172,.36) 0 7px,transparent 8px),radial-gradient(ellipse at 91% 66%,rgba(126,180,190,.34) 0 8px,transparent 9px)}
.yq-weeds{position:absolute;bottom:4px;left:0;right:0;height:158px;pointer-events:none}
.yq-weed{position:absolute;bottom:0;width:9px;height:98px;border-radius:58% 58% 14% 14%;background:linear-gradient(180deg,rgba(126,228,182,.5),rgba(42,124,108,.16) 72%,rgba(30,96,88,.05));transform-origin:bottom center;animation:yq-sway 7.5s ease-in-out infinite alternate;filter:blur(.35px)}
.yq-weed-a{left:9%;height:104px;animation-delay:-1s}
.yq-weed-b{left:27%;height:72px;animation-delay:-3.4s;opacity:.72;width:7px;animation-duration:9s}
.yq-weed-c{left:47%;height:60px;animation-delay:-5.6s;opacity:.6;width:6px}
.yq-weed-d{left:76%;height:112px;animation-delay:-2.2s;opacity:.86;animation-duration:6.6s}
.yq-weed-e{left:90%;height:78px;animation-delay:-4.8s;opacity:.62;width:7px}
.yq-tuft{position:absolute;bottom:2px;border-radius:52% 44% 58% 46%;filter:blur(2.4px);animation:yq-sway 10s ease-in-out infinite alternate}
.yq-tuft-a{left:16%;width:34px;height:26px;background:radial-gradient(circle at 32% 62%,rgba(116,214,176,.4),transparent 64%),radial-gradient(circle at 68% 44%,rgba(94,196,206,.34),transparent 60%)}
.yq-tuft-b{left:62%;width:44px;height:22px;animation-delay:-3s;background:radial-gradient(circle at 38% 58%,rgba(92,190,206,.34),transparent 62%),radial-gradient(circle at 72% 50%,rgba(120,210,180,.3),transparent 58%)}
.yq-bubbles{position:absolute;inset:0;pointer-events:none}
.yq-bubble{position:absolute;bottom:10%;border-radius:50%;background:radial-gradient(circle at 34% 30%,rgba(255,255,255,.9),rgba(198,244,255,.42) 46%,rgba(150,220,240,.12) 72%);box-shadow:0 0 7px rgba(198,244,255,.5),inset 0 0 2px rgba(255,255,255,.7);animation-name:yq-rise;animation-timing-function:linear;animation-iteration-count:infinite}
.yq-motes{position:absolute;inset:0;pointer-events:none}
.yq-mote{position:absolute;width:2px;height:2px;border-radius:50%;background:rgba(214,246,255,.55);box-shadow:0 0 5px rgba(206,242,255,.45);animation-name:yq-drift;animation-timing-function:ease-in-out;animation-iteration-count:infinite}
.yq-vignette{position:absolute;inset:0;pointer-events:none;background:radial-gradient(122% 92% at 50% 36%,transparent 50%,rgba(3,14,20,.46) 100%)}

/* ---------- 鱼 ---------- */
.yq-lane{position:absolute;left:0;right:0;height:0}
.yq-lane:hover{z-index:60!important}
.yq-swim{position:relative;width:100%;animation-name:yq-swim;animation-timing-function:linear;animation-iteration-count:infinite;will-change:transform}
.yq-lane:hover .yq-swim{animation-play-state:paused}
.yq-float{position:relative;display:flex;flex-direction:row;align-items:center;gap:6px;width:max-content;margin-left:-52px;animation:yq-bob 5.8s ease-in-out infinite alternate}
.yq-avatar{position:relative;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}
.yq-avatar-flip{transform:scaleX(-1)}
.yq-float-flip{flex-direction:row-reverse;margin-left:-96px}
.yq-fish-svg{filter:drop-shadow(0 7px 11px rgba(2,12,18,.42));transition:filter .3s}
.yq-lane:hover .yq-fish-svg{filter:drop-shadow(0 9px 16px rgba(2,12,18,.55)) brightness(1.07) saturate(1.06)}
.yq-fish-body{transform-box:fill-box;transform-origin:62% 50%;animation:yq-fish-roll 8.4s ease-in-out infinite alternate}
.yq-tail{transform-box:fill-box;transform-origin:right center;animation:yq-tail-wag 1.8s ease-in-out infinite alternate}
.yq-glow{position:absolute;left:14px;top:50%;width:74px;height:46px;transform:translateY(-50%);border-radius:50%;background:radial-gradient(ellipse,rgba(190,240,255,.3),transparent 70%);opacity:0;transition:opacity .4s;pointer-events:none}
.yq-lane:hover .yq-glow{opacity:1}
.yq-shadow{position:absolute;left:50%;bottom:-2px;width:50px;height:8px;transform:translateX(-50%);border-radius:50%;background:radial-gradient(ellipse,rgba(3,16,22,.45),transparent 72%);filter:blur(2.5px);pointer-events:none}
.yq-name{margin:0;font-size:10px;line-height:1.36;color:rgba(236,250,255,.94);background:linear-gradient(180deg,rgba(9,28,36,.72),rgba(6,20,27,.52));border:1px solid rgba(152,216,236,.18);padding:1px 7px;border-radius:999px;white-space:nowrap;backdrop-filter:blur(3px);transition:border-color .25s,color .25s}
.yq-lane:hover .yq-name{border-color:rgba(176,232,246,.44);color:#fff}
.yq-lane-guest .yq-name{color:rgba(214,240,250,.86)}
.yq-busy{position:absolute;left:50%;top:16px;transform:translateX(-50%);display:flex;align-items:center;gap:8px;font-size:11.5px;color:#d3efff;background:rgba(8,26,34,.74);border:1px solid rgba(158,214,238,.32);padding:5px 13px;border-radius:999px;backdrop-filter:blur(6px);z-index:70}
.yq-spinner{width:11px;height:11px;border-radius:50%;border:1.6px solid rgba(200,240,255,.26);border-top-color:#9bd2ea;animation:yq-spin .8s linear infinite;display:inline-block}
.yq-caption{position:absolute;left:18px;right:18px;bottom:36px;font-size:11.5px;color:rgba(216,242,252,.8);display:flex;gap:7px;align-items:baseline;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;z-index:65;text-shadow:0 1px 6px rgba(2,12,18,.8)}
.yq-caption-label{font-size:10px;letter-spacing:.1em;color:rgba(158,214,238,.85);flex-shrink:0}
.yq-pond-meta{position:absolute;right:16px;bottom:11px;display:flex;gap:12px;font-size:10.5px;color:rgba(194,228,242,.66);z-index:65}

/* ---------- 主区骨架：左右两栏各自滚动，整体锁高 ---------- */
.yq-body{flex:1 1 auto;min-height:0;min-width:0;width:100%;max-width:100%;display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,340px);gap:14px;padding:14px 20px 16px;overflow:hidden}
.yq-left{display:flex;flex-direction:column;gap:11px;min-height:0;min-width:0}
.yq-left>*{min-width:0;max-width:100%}
.yq-stage-slot{position:relative;flex:3 1 0;min-height:190px;min-width:0;display:flex}
.yq-stage-slot>*{flex:1 1 auto;min-width:0}
.yq-stream{flex:2 1 0;min-height:150px;min-width:0;display:flex;flex-direction:column}
.yq-stream>.yq-card{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.yq-stream .yq-log{flex:1 1 auto;min-height:0;max-height:none}
.yq-rail{min-height:0;min-width:0;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:12px;padding-right:5px;overscroll-behavior:contain}
.yq-rail>*{flex:0 0 auto;min-width:0}
@supports not (overflow:overlay){.yq-rail{scrollbar-gutter:stable}}
.yq-feed{display:flex;gap:10px;flex:0 0 auto}
.yq-feed-input{flex:1;min-width:0;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 88%,transparent);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:11px 18px;font-size:13px;color:var(--dsw-alias-label-primary);outline:none;transition:border-color .18s,box-shadow .18s,background .18s}
.yq-feed-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.74}
.yq-feed-input:hover{border-color:var(--dsw-alias-border-l2)}
.yq-feed-input:focus{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 52%,var(--dsw-alias-border-l1));box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 13%,transparent);background:var(--dsw-alias-bg-layer-2)}

/* ---------- 卡片 ---------- */
.yq-card{position:relative;background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-bg-layer-1) 92%,transparent),color-mix(in srgb,var(--dsw-alias-bg-base) 46%,var(--dsw-alias-bg-layer-1)));border:1px solid var(--dsw-alias-border-l1);border-radius:16px;padding:14px 16px;min-width:0;box-shadow:inset 0 1px 0 rgba(255,255,255,.04),0 16px 34px -32px rgba(0,0,0,.8)}
.yq-card:before{content:'';position:absolute;left:18px;right:18px;top:0;height:1px;pointer-events:none;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,transparent),transparent);opacity:.75}
.yq-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:11px}
.yq-card-title{font-size:13px;font-weight:620;letter-spacing:.01em;display:inline-flex;align-items:center;gap:7px}
.yq-card-title:before{content:'';width:3px;height:12px;border-radius:2px;background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 82%,transparent),color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent))}
.yq-card-hint{font-size:11px;color:var(--dsw-alias-label-secondary)}
.yq-columns{display:grid;grid-template-columns:minmax(0,1.42fr) minmax(0,1fr);gap:13px;align-items:start}
.yq-main{display:flex;flex-direction:column;gap:13px;min-width:0}
.yq-side{display:flex;flex-direction:column;gap:13px;min-width:0}

/* ---------- 关系网 ---------- */
.yq-graph-wrap{position:relative;border-radius:12px;background:radial-gradient(ellipse at 50% 42%,rgba(84,166,196,.16),transparent 70%)}
.yq-graph{width:100%;height:auto;display:block;border-radius:12px}
.yq-graph-node{cursor:pointer;transition:filter .2s}
.yq-graph-node:hover{filter:brightness(1.18) drop-shadow(0 0 6px rgba(190,240,255,.45))}
.yq-graph-label{font-size:9.5px;fill:rgba(228,246,253,.84);pointer-events:none}
.yq-graph-label-strong{font-size:10px;fill:rgba(232,248,253,.92);pointer-events:none}
.yq-graph-label-topic{font-size:8.5px;fill:rgba(182,212,230,.62);pointer-events:none}
.yq-graph-legend{display:flex;align-items:center;gap:14px;margin-top:8px;font-size:11px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}
.yq-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;vertical-align:1px}
.yq-dot-resident{background:#f2a65a;box-shadow:0 0 6px rgba(242,166,90,.55)}
.yq-dot-guest{background:#bfe6f7;border:1px solid rgba(255,255,255,.6);box-shadow:0 0 6px rgba(191,230,247,.5)}
.yq-dot-topic{background:#7fa9c4;box-shadow:0 0 6px rgba(127,169,196,.5)}
.yq-graph-tip{margin-left:auto;opacity:.72}
.yq-graph-detail{display:flex;align-items:center;gap:10px;margin-top:9px;padding:9px 11px;border-radius:12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.yq-graph-detail-name{font-size:12.5px;font-weight:600}
.yq-graph-detail-meta{font-size:11px;color:var(--dsw-alias-label-secondary);flex:1;min-width:0}

/* ---------- 小按钮 ---------- */
.yq-mini-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 60%,transparent);color:var(--dsw-alias-label-primary);border-radius:999px;padding:4px 10px;font-size:11.5px;cursor:pointer;transition:background .16s,border-color .16s}
.yq-mini-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,var(--dsw-alias-border-l2))}
.yq-mini-btn:disabled{opacity:.45;cursor:default}

/* ---------- 水中絮语 ---------- */
.yq-log{display:flex;flex-direction:column;gap:12px;max-height:520px;overflow-y:auto;padding-right:5px}
.yq-entry{border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;position:relative}
.yq-entry:first-child{border-top:none;padding-top:0}
.yq-entry-head{display:flex;align-items:center;gap:8px;margin-bottom:7px;flex-wrap:wrap}
.yq-kind{font-size:10px;padding:1.5px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);flex-shrink:0;border:1px solid transparent}
.yq-kind-visit-in{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 15%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 76%,var(--dsw-alias-label-primary));border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 32%,transparent)}
.yq-kind-visit-out{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent);color:color-mix(in srgb,var(--dsw-alias-brand-primary) 78%,var(--dsw-alias-label-primary));border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 32%,transparent)}
.yq-kind-say{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 15%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 76%,var(--dsw-alias-label-primary));border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,transparent)}
.yq-entry-topic{font-size:12.5px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:.01em}
.yq-entry-time{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.yq-entry-guest{margin:0 0 7px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.yq-lines{display:flex;flex-direction:column;gap:5px}
.yq-line{margin:0;font-size:12.5px;line-height:1.66;display:flex;gap:9px;align-items:baseline}
.yq-speaker{flex-shrink:0;font-weight:600;font-size:11.5px;min-width:34px}
.yq-said{color:var(--dsw-alias-label-primary)}
.yq-empty{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);padding:6px 0}

/* ---------- 鱼友 ---------- */
.yq-bonds{display:flex;flex-direction:column;gap:10px;max-height:330px;overflow-y:auto;padding-right:5px}
.yq-bond{display:flex;flex-direction:column;gap:6px}
.yq-bond-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.yq-bond-pair{font-size:12px;display:inline-flex;align-items:center;gap:4px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.yq-bond-x{opacity:.45;margin:0 2px}
.yq-bond-kind{font-style:normal;font-size:9px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.yq-chip{font-size:10px;padding:1.5px 8px;border-radius:999px;flex-shrink:0;border:1px solid transparent}
.yq-chip-hot{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 15%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 76%,var(--dsw-alias-label-primary));border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 34%,transparent)}
.yq-chip-cool{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l1)}
.yq-bar{height:5px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 88%,transparent);overflow:hidden}
.yq-bar i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent),color-mix(in srgb,var(--dsw-alias-state-success-primary) 68%,var(--dsw-alias-brand-primary)));box-shadow:0 0 10px -2px color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);transition:width .45s ease}
.yq-bond-foot{display:flex;justify-content:space-between;font-size:10.5px;color:var(--dsw-alias-label-secondary);gap:8px}
.yq-dormant{color:var(--dsw-alias-state-warn-primary)}

/* ---------- 塘口 ---------- */
.yq-gate-row{display:flex;align-items:center;gap:8px;margin-bottom:9px;flex-wrap:wrap}
.yq-label{font-size:11.5px;color:var(--dsw-alias-label-secondary);flex-shrink:0;min-width:52px}
.yq-label-quota{min-width:auto;margin-left:6px}
.yq-input{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:6px 10px;font-size:12px;color:var(--dsw-alias-label-primary);outline:none;min-width:0;transition:border-color .16s,box-shadow .16s}
.yq-input:focus{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 48%,var(--dsw-alias-border-l1));box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 11%,transparent)}
.yq-input-num{width:54px;text-align:center}
.yq-input-flex{flex:1;min-width:120px}
.yq-select{max-width:100%}
.yq-code{font-size:11.5px;padding:6px 9px;border-radius:8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);color:color-mix(in srgb,var(--dsw-alias-brand-primary) 82%,var(--dsw-alias-label-primary));word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.yq-note{margin:0 0 9px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.yq-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer}
.yq-gate-divider{height:1px;background:linear-gradient(90deg,var(--dsw-alias-border-l1),transparent);margin:11px 0}

/* ---------- 鱼证 ---------- */
.yq-roster{display:grid;grid-template-columns:repeat(auto-fill,minmax(244px,1fr));gap:11px}
.yq-fish-card{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:12px 13px;background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-bg-layer-1) 68%,var(--dsw-alias-bg-base)),var(--dsw-alias-bg-base));display:flex;flex-direction:column;gap:8px;min-width:0;transition:border-color .2s,box-shadow .2s}
.yq-fish-card:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 36%,var(--dsw-alias-border-l1));box-shadow:0 16px 28px -28px rgba(0,0,0,.95)}
.yq-fish-card-guest{background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-bg-layer-2) 72%,transparent),var(--dsw-alias-bg-base));border-style:dashed}
.yq-fish-card-head{display:flex;align-items:center;gap:10px;min-width:0}
.yq-fish-avatar{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;flex-shrink:0;overflow:hidden;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 72%,transparent);box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}
.yq-fish-avatar-glyph{transform:translateX(-1px)}
.yq-fish-id{min-width:0;flex:1}
.yq-fish-name{font-size:12.5px;font-weight:620;display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.yq-fish-species{font-size:10px;font-weight:400;color:var(--dsw-alias-label-secondary)}
.yq-fish-address{font-size:10px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;opacity:.86}
.yq-bind-chip{font-size:9.5px;padding:1px 8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent);color:color-mix(in srgb,var(--dsw-alias-brand-primary) 76%,var(--dsw-alias-label-primary));flex-shrink:0;max-width:92px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 28%,transparent)}
.yq-fish-persona{margin:0;font-size:11.5px;line-height:1.58;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.yq-traits{display:flex;flex-wrap:wrap;gap:5px 9px}
.yq-trait{display:flex;align-items:center;gap:4px;font-size:9.5px;color:var(--dsw-alias-label-secondary)}
.yq-trait-bar{width:42px;height:4px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 90%,transparent);overflow:hidden}
.yq-trait-bar i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 52%,transparent),var(--dsw-alias-brand-primary))}
.yq-fish-foot{display:flex;align-items:center;justify-content:space-between;gap:6px}
.yq-tags{display:flex;gap:4px;flex-wrap:wrap;min-width:0}
.yq-tag{font-size:9.5px;padding:1.5px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1)}
.yq-memory{font-size:9.5px;color:var(--dsw-alias-label-secondary);flex-shrink:0}
.yq-fish-memory{margin:0;font-size:10.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);border-left:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent);padding-left:8px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.yq-fish-actions{display:flex;gap:6px;flex-wrap:wrap}

/* ---------- 换皮肤 ---------- */
.yq-skin-fish{display:flex;flex-wrap:wrap;gap:6px}
.yq-skin-fish-btn{appearance:none;display:inline-flex;align-items:center;gap:5px;padding:3px 9px 3px 5px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 62%,transparent);color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer;transition:border-color .16s,color .16s,background .16s}
.yq-skin-fish-btn:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 44%,var(--dsw-alias-border-l1));color:var(--dsw-alias-label-primary)}
.yq-skin-fish-on{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 58%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}
.yq-skin-fish-glyph{display:inline-flex;align-items:center;justify-content:center;width:26px;height:18px}
.yq-skin-fish-glyph svg{width:26px;height:auto}
.yq-skin-fish-name{max-width:56px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.yq-skin-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:7px}
.yq-skin{appearance:none;position:relative;display:flex;flex-direction:column;align-items:center;gap:2px;padding:7px 6px 6px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-bg-layer-2) 70%,transparent),color-mix(in srgb,var(--dsw-alias-bg-base) 62%,transparent));cursor:pointer;transition:transform .16s,border-color .16s,box-shadow .16s}
.yq-skin:hover:not(:disabled){transform:translateY(-1px);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 46%,var(--dsw-alias-border-l2));box-shadow:0 12px 24px -20px rgba(0,0,0,.9)}
.yq-skin:disabled{opacity:.5;cursor:default}
.yq-skin-on{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 66%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent),0 14px 26px -22px color-mix(in srgb,var(--dsw-alias-brand-primary) 80%,transparent)}
.yq-skin-preview{display:block;height:24px;line-height:0;filter:drop-shadow(0 3px 5px rgba(0,0,0,.45))}
.yq-skin-preview svg{width:44px;height:auto}
.yq-skin-label{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.yq-skin-on .yq-skin-label{color:var(--dsw-alias-label-primary)}
.yq-skin-dot{width:7px;height:7px;border-radius:50%;box-shadow:0 0 0 1px rgba(255,255,255,.14) inset;flex-shrink:0}
.yq-skin-tag{font-size:9px;line-height:1;padding:2px 4px;border-radius:5px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 46%,transparent);color:color-mix(in srgb,var(--dsw-alias-brand-primary) 78%,var(--dsw-alias-label-primary));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}

/* ---------- 自定义皮肤 ---------- */
.yq-custom-form{display:grid;grid-template-columns:34px minmax(0,.5fr) minmax(0,1fr);gap:7px;align-items:center}
@media (max-width:620px){.yq-custom-form{grid-template-columns:34px minmax(0,1fr);}.yq-custom-name{grid-column:1/-1}}
.yq-custom-swatch{position:relative;display:flex;align-items:center;justify-content:center;width:34px;height:30px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);cursor:pointer;overflow:hidden}
.yq-custom-swatch input[type=color]{position:absolute;inset:-4px;width:calc(100% + 8px);height:calc(100% + 8px);opacity:0;cursor:pointer;border:none;padding:0}
.yq-custom-swatch-in{display:block;width:20px;height:20px;border-radius:6px;box-shadow:0 0 0 1px rgba(255,255,255,.16) inset,0 2px 6px rgba(0,0,0,.35);pointer-events:none}
.yq-custom-hex{letter-spacing:.02em;font-family:ui-monospace,Menlo,monospace;font-size:11px;text-align:center}
.yq-custom-name{min-width:0}
.yq-custom-row{display:flex;align-items:center;gap:8px}
.yq-custom-preview{display:flex;align-items:center;justify-content:center;width:64px;height:34px;border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 70%,transparent);border:1px dashed var(--dsw-alias-border-l1);filter:drop-shadow(0 3px 5px rgba(0,0,0,.4))}
.yq-custom-preview svg{width:52px;height:auto}
.yq-custom-who{font-size:11px;color:var(--dsw-alias-label-secondary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.yq-custom-save{padding:6px 14px;font-size:11.5px}
.yq-custom-list{display:flex;flex-direction:column;gap:5px}
.yq-custom-chip{display:flex;align-items:stretch;gap:0;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 55%,transparent);overflow:hidden}
.yq-custom-chip-main{appearance:none;flex:1;min-width:0;display:inline-flex;align-items:center;gap:6px;padding:5px 8px;border:none;background:transparent;color:var(--dsw-alias-label-primary);font-size:11px;cursor:pointer;text-align:left}
.yq-custom-chip-main:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.yq-custom-chip-main em{margin-left:auto;font-style:normal;font-family:ui-monospace,Menlo,monospace;font-size:10px;color:var(--dsw-alias-label-secondary)}
.yq-custom-chip-main:disabled{opacity:.5;cursor:default}
.yq-custom-chip-x{appearance:none;width:26px;border:none;border-left:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px;line-height:1}
.yq-custom-chip-x:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 22%,transparent);color:var(--dsw-alias-state-error-primary)}
.yq-custom-chip-x:disabled{opacity:.4;cursor:default}
.yq-custom-photo{display:flex;align-items:stretch;gap:10px;padding:0 2px;min-width:0}
.yq-custom-photo.is-busy{opacity:.72}
.yq-custom-photo-pick{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:9px;padding:9px 12px;border-radius:10px;border:1px dashed var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 45%,transparent);color:var(--dsw-alias-label-secondary);cursor:pointer;transition:border-color .16s,color .16s,background .16s}
.yq-custom-photo-pick:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}
.yq-custom-photo-pick:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 72%,transparent);outline-offset:2px}
.yq-custom-photo-plus{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:7px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);color:var(--dsw-alias-brand-primary);font-size:15px;line-height:1}
.yq-custom-photo-label{flex:0 0 auto;font-size:12px;color:var(--dsw-alias-label-primary)}
.yq-custom-photo-sub{flex:1 1 auto;min-width:0;font-size:10.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.yq-custom-photo-thumb{position:relative;flex:0 0 auto;display:inline-flex;width:66px;height:44px;border-radius:9px;overflow:hidden;border:1px solid var(--dsw-alias-border-l2)}
.yq-custom-photo-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.yq-custom-photo-x{position:absolute;top:2px;right:2px;width:16px;height:16px;padding:0;border:none;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;font-size:11px;line-height:1;cursor:pointer}
.yq-custom-photo-meta{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:3px}
.yq-custom-photo-name{font-size:12px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.yq-custom-photo-swap{width:fit-content;font-size:10.5px;color:var(--dsw-alias-brand-primary);cursor:pointer;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}
.yq-custom-chip-tool{appearance:none;padding:0 7px;border:none;border-left:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:10.5px;cursor:pointer;white-space:nowrap}
.yq-custom-chip-tool:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-label-primary)}
.yq-custom-chip-tool:disabled{opacity:.4;cursor:default}
.yq-custom-chip-img{margin-left:0;font-size:9.5px;color:var(--dsw-alias-brand-primary);border:1px solid currentColor;border-radius:4px;padding:0 3px;line-height:1.3}
.yq-note-error{color:var(--dsw-alias-state-error-primary)}

/* ---------- 幽灵按钮 / 指南 / 反馈 ---------- */
.yq-btn-ghost{background:transparent;border-color:color-mix(in srgb,var(--dsw-alias-border-l2) 80%,transparent);color:var(--dsw-alias-label-secondary)}
.yq-btn-ghost:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 44%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.yq-btn-feedback{position:relative}
.yq-btn-feedback:before{content:'';width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-brand-primary);box-shadow:0 0 6px color-mix(in srgb,var(--dsw-alias-brand-primary) 70%,transparent);margin-right:1px;display:inline-block;vertical-align:1px}
.yq-modal.is-wide{width:min(760px,100%);max-height:min(84vh,760px)}
.yq-guide{display:flex;flex-direction:column;gap:14px}
.yq-guide-quick{display:flex;flex-direction:column;gap:6px;padding:11px 13px;border-radius:12px;background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,var(--dsw-alias-bg-layer-2)),color-mix(in srgb,var(--dsw-alias-bg-layer-1) 94%,transparent));border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,var(--dsw-alias-border-l1))}
.yq-guide-quick-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.yq-guide-quick-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:3px}
.yq-guide-quick-list li{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.yq-guide-nav{display:flex;flex-wrap:wrap;gap:6px}
.yq-guide-nav-item{font:inherit;font-size:11px;line-height:1.4;padding:3px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 70%,transparent);color:var(--dsw-alias-label-secondary);cursor:pointer}
.yq-guide-nav-item:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 46%,var(--dsw-alias-border-l1));color:var(--dsw-alias-label-primary)}
.yq-guide-nav-item:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 72%,transparent);outline-offset:2px}
.yq-guide-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 22px;align-items:start}
.yq-guide-block{display:flex;flex-direction:column;gap:6px;min-width:0;scroll-margin-top:6px}
.yq-guide-title{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0;display:flex;align-items:center;gap:7px}
.yq-guide-title:before{content:'';width:3px;height:12px;border-radius:2px;background:linear-gradient(180deg,var(--dsw-alias-brand-primary),color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent))}
.yq-guide-num{font-size:10px;font-weight:600;font-variant-numeric:tabular-nums;color:color-mix(in srgb,var(--dsw-alias-brand-primary) 78%,var(--dsw-alias-label-secondary));letter-spacing:.06em}
.yq-guide-icon{font-size:12px;line-height:1;filter:saturate(.9)}
.yq-guide-hint{margin:0;font-size:11px;line-height:1.5;color:color-mix(in srgb,var(--dsw-alias-label-secondary) 78%,transparent)}
.yq-guide-list{margin:0;padding-left:16px;display:flex;flex-direction:column;gap:4px}
.yq-guide-list li{font-size:11.5px;line-height:1.62;color:var(--dsw-alias-label-secondary)}
.yq-guide-strong{color:var(--dsw-alias-label-primary);font-weight:600}
.yq-guide-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;padding:1px 5px;border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 80%,transparent);border:1px solid var(--dsw-alias-border-l1);word-break:normal;overflow-wrap:break-word;white-space:normal}
.yq-guide-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%}
.yq-guide-foot-actions{display:flex;align-items:center;gap:8px}
.yq-guide-foot-hint{font-size:11px;color:color-mix(in srgb,var(--dsw-alias-label-secondary) 72%,transparent)}
@media (max-width:720px){.yq-guide-grid{grid-template-columns:minmax(0,1fr)}}
.yq-modal-ok{margin:0;font-size:11.5px;color:var(--dsw-alias-state-success-primary)}
.yq-feedback-list{display:flex;flex-direction:column;gap:6px;padding-top:4px;border-top:1px dashed var(--dsw-alias-border-l1);margin-top:2px}
.yq-feedback-head{font-size:10.5px;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);opacity:.8;padding-top:8px}
.yq-feedback-item{display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 48%,transparent);border:1px solid var(--dsw-alias-border-l1)}
.yq-feedback-time{font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap;padding-top:1px;opacity:.85}
.yq-feedback-text{flex:1;min-width:0;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-primary);word-break:break-word}
.yq-feedback-done{font-size:9.5px;padding:1px 5px;border-radius:5px;white-space:nowrap;color:var(--dsw-alias-state-success-primary);border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent)}

/* ---------- 动画 ---------- */
@keyframes yq-swim{from{transform:translateX(3%)}to{transform:translateX(93%)}}
@keyframes yq-swim-back{from{transform:translateX(93%)}to{transform:translateX(3%)}}
@keyframes yq-bob{from{transform:translateY(-3px)}to{transform:translateY(4px)}}
@keyframes yq-fish-roll{0%{transform:rotate(-1.6deg)}50%{transform:rotate(.8deg)}100%{transform:rotate(1.8deg)}}
@keyframes yq-tail-wag{from{transform:rotate(-7deg)}to{transform:rotate(7deg)}}
@keyframes yq-sway{from{transform:rotate(-4.5deg)}to{transform:rotate(4.5deg)}}
@keyframes yq-rise{0%{transform:translate(0,0) scale(.7);opacity:0}10%{opacity:.75}55%{transform:translate(7px,-110px) scale(1)}100%{transform:translate(-5px,-250px) scale(1.2);opacity:0}}
@keyframes yq-drift{0%{transform:translate(0,0);opacity:0}25%{opacity:.7}60%{transform:translate(14px,-16px)}100%{transform:translate(-8px,-34px);opacity:0}}
@keyframes yq-rays{from{opacity:.55;transform:rotate(-6deg) translateX(-14px)}to{opacity:.92;transform:rotate(-4deg) translateX(14px)}}
@keyframes yq-shaft{from{opacity:.42;transform:skewX(-11deg) translateX(-12px)}to{opacity:.85;transform:skewX(-8deg) translateX(16px)}}
@keyframes yq-caustic{from{background-position:0 0,0 0}to{background-position:180px 0,-140px 0}}
@keyframes yq-surface{from{transform:translateY(-2px)}to{transform:translateY(2px)}}
@keyframes yq-spin{to{transform:rotate(360deg)}}
@media (max-width:980px){.yq-body{grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto;overflow-y:auto;gap:12px}.yq-left{min-height:0}.yq-stage-slot{flex:0 0 auto;height:340px}.yq-stream{flex:0 0 auto;height:300px}.yq-rail{overflow:visible;max-height:none;padding-right:0}.yq-log{max-height:none}.yq-bonds{max-height:none}}
@media (prefers-reduced-motion:reduce){.yq-rays,.yq-shaft,.yq-caustics,.yq-surface,.yq-surface-line,.yq-weed,.yq-tuft,.yq-bubble,.yq-mote,.yq-float,.yq-swim,.yq-fish-body,.yq-tail{animation:none!important}}

/* ---------- 弹层：绑机器人 / 替鱼说话 ---------- */
.yq-mask{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 58%,transparent);backdrop-filter:blur(6px);animation:yq-fade .18s ease-out}
.yq-modal{width:min(520px,100%);max-height:min(76vh,600px);display:flex;flex-direction:column;border-radius:18px;border:1px solid var(--dsw-alias-border-l2);background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-bg-layer-2) 96%,transparent),var(--dsw-alias-bg-layer-1));box-shadow:0 34px 70px -34px rgba(0,0,0,.86),inset 0 1px 0 rgba(255,255,255,.06);animation:yq-pop .2s ease-out}
.yq-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px 20px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.yq-modal-head-text{display:flex;flex-direction:column;gap:6px;min-width:0}
.yq-modal-title{margin:0;font-size:15.5px;font-weight:640;letter-spacing:.01em}
.yq-modal-sub{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.yq-modal-x{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:20px;line-height:1;cursor:pointer;padding:0 2px;border-radius:8px}
.yq-modal-x:hover{color:var(--dsw-alias-label-primary)}
.yq-modal-body{padding:14px 20px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;min-height:0}
.yq-modal-foot{display:flex;align-items:center;justify-content:flex-end;gap:9px;padding:12px 20px 16px;border-top:1px solid var(--dsw-alias-border-l1)}
.yq-modal-off{margin-right:auto;color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.yq-modal-current{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.yq-modal-current b{color:color-mix(in srgb,var(--dsw-alias-brand-primary) 78%,var(--dsw-alias-label-primary));font-weight:600}
.yq-modal-hint{margin:0;font-size:11.5px;line-height:1.65;color:var(--dsw-alias-label-secondary)}
.yq-modal-error{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary)}
.yq-modal-empty{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 52%,transparent);border:1px dashed var(--dsw-alias-border-l2)}
.yq-modal-empty p{margin:0;font-size:12.5px}
.yq-modal-text{width:100%;min-height:96px;resize:vertical;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-base) 58%,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.6;padding:10px 12px}
.yq-modal-text:focus{outline:none;border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 52%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent)}
.yq-modal-row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.yq-modal-counter{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.yq-modal-pick{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.yq-modal-select{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:999px;padding:4px 10px;font-size:11.5px;cursor:pointer}
.yq-modal-check{font-size:12px;gap:7px}

/* ---------- 机器人列表 ---------- */
.yq-bot-list{display:flex;flex-direction:column;gap:8px}
.yq-bot{border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 46%,transparent);overflow:hidden;transition:border-color .16s,background .16s}
.yq-bot-on{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 48%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,var(--dsw-alias-bg-layer-1))}
.yq-bot-main{appearance:none;width:100%;display:flex;align-items:center;gap:9px;padding:9px 11px;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;text-align:left}
.yq-bot-badge{font-size:10.5px;padding:2px 8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);color:color-mix(in srgb,var(--dsw-alias-brand-primary) 82%,var(--dsw-alias-label-primary));flex-shrink:0}
.yq-bot-account{font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.yq-bot-pick{font-size:11px;color:var(--dsw-alias-label-secondary);flex-shrink:0}
.yq-bot-state{font-size:10px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);flex-shrink:0}
.yq-bot-state-on{color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 76%,var(--dsw-alias-label-primary));border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}
.yq-bot-on .yq-bot-pick{color:color-mix(in srgb,var(--dsw-alias-brand-primary) 78%,var(--dsw-alias-label-primary))}
.yq-targets{display:flex;flex-wrap:wrap;gap:6px;padding:2px 11px 11px}
.yq-target{appearance:none;display:inline-flex;align-items:center;gap:6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 60%,transparent);color:var(--dsw-alias-label-primary);font-size:11.5px;padding:4px 10px;cursor:pointer;max-width:100%;transition:border-color .16s,background .16s}
.yq-target:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 46%,var(--dsw-alias-border-l2))}
.yq-target-on{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 56%,transparent)}
.yq-target-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px}
.yq-target-kind{font-size:10px;color:var(--dsw-alias-label-secondary);flex-shrink:0}
.yq-target-ghost{border-style:dashed;color:var(--dsw-alias-label-secondary)}
.yq-bind-chip-im{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 72%,var(--dsw-alias-label-primary));border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 34%,transparent);gap:5px;white-space:nowrap}
.yq-bind-dot{width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.8;flex-shrink:0}
.yq-mini-btn-ghost{background:transparent;color:var(--dsw-alias-label-secondary)}
.yq-mini-btn-ghost:hover{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,transparent)}
@keyframes yq-fade{from{opacity:0}to{opacity:1}}
@keyframes yq-pop{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.yq-mask,.yq-modal{animation:none!important}}

/* 存满 24 套的提示 */
.yq-note-warn{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}

/* 塘口：塘号 / 邀请码 / 夜间打烊 */
.yq-input-time{width:92px;text-align:center}
.yq-gate-left{font-size:11px;color:var(--dsw-alias-label-secondary);margin-left:auto}
.yq-gate-dash{color:var(--dsw-alias-label-secondary);font-size:11px}
.yq-code-wrap{display:inline-block;max-width:100%;font-size:10.5px;line-height:1.5}
.yq-gate-invite{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:-2px 0 10px;padding:8px 10px;border-radius:10px;border:1px dashed color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 5%,transparent)}
.yq-gate-more{margin:2px 0 8px;padding:0;border:none;background:none;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.yq-gate-more:hover{color:var(--dsw-alias-label-primary)}

@media (max-width:620px){
  .yq-gate-left{margin-left:0}
  .yq-input-time{width:76px}
}

/* 视图切换：动态鱼塘 / 关系网 */
.yq-tabs{display:flex;align-items:center;gap:8px;flex:0 0 auto}
.yq-tab{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,transparent);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer;transition:border-color .16s ease,color .16s ease,background .16s ease}
.yq-tab:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.yq-tab.is-on{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 48%,transparent);color:var(--dsw-alias-label-primary)}
.yq-tabs-hint{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.72}
.yq-view-graph{display:flex;flex-direction:column;min-height:0;overflow-y:auto;border-radius:18px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 62%,transparent);padding:10px;flex:1 1 auto}

/* 折叠起来的「鱼友与塘口设置」 */
.yq-fold{flex:0 0 auto;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 62%,transparent);overflow:hidden}
.yq-fold-sum{cursor:pointer;list-style:none;padding:10px 13px;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:8px}
.yq-fold-sum::-webkit-details-marker{display:none}
.yq-fold-sum:before{content:'▸';font-size:11px;opacity:.7;transition:transform .16s ease}
.yq-fold[open] .yq-fold-sum:before{transform:rotate(90deg)}
.yq-fold-body{display:flex;flex-direction:column;gap:12px;padding:0 13px 13px}

/* 水域：航线、饵料、气泡 */
.yq-stage{position:relative;flex:1 1 auto;height:auto;min-height:0;width:100%;max-width:100%;overflow:hidden;border-radius:18px;background:linear-gradient(180deg,#08202b 0%,#0d3442 38%,#0a2b37 68%,#071a23 100%);border:1px solid rgba(122,192,216,.24);box-shadow:inset 0 1px 0 rgba(196,242,255,.16),0 22px 46px -34px rgba(0,0,0,.85);isolation:isolate;touch-action:manipulation}
.yq-stage.is-armed{cursor:crosshair}
.yq-stage-water{position:absolute;inset:0;z-index:0;overflow:hidden;pointer-events:none}
.yq-stage-water:before{content:'';position:absolute;inset:-20%;background:radial-gradient(60% 70% at 50% 0%,rgba(126,214,245,.18),transparent 70%),radial-gradient(50% 60% at 20% 85%,rgba(30,120,150,.22),transparent 70%);animation:yq-stage-wave 18s ease-in-out infinite}
.yq-stage-ray{position:absolute;top:-30%;width:120px;height:150%;background:linear-gradient(180deg,rgba(160,232,255,.16),transparent 70%);filter:blur(8px);transform:rotate(14deg);animation:yq-stage-sway 12s ease-in-out infinite}
.yq-stage-ray-a{left:16%}
.yq-stage-ray-b{left:58%;width:80px;animation-duration:15s;animation-delay:-4s}
.yq-stage-floor{position:absolute;left:-10%;right:-10%;bottom:-26px;height:120px;background:radial-gradient(60% 100% at 50% 100%,rgba(40,90,105,.75),rgba(10,30,40,0) 70%)}
.yq-stage-weed{position:absolute;bottom:14px;width:10px;border-radius:8px 8px 0 0;background:linear-gradient(180deg,rgba(78,190,150,.5),rgba(30,110,90,.18));transform-origin:bottom;animation:yq-stage-kelp 7s ease-in-out infinite}
.yq-stage-weed-a{left:12%;height:64px}
.yq-stage-weed-b{left:34%;height:44px;animation-delay:-2.4s}
.yq-stage-weed-c{right:16%;height:58px;animation-delay:-1.2s}
.yq-stage-vignette{position:absolute;inset:0;background:radial-gradient(120% 90% at 50% 40%,transparent 55%,rgba(2,10,16,.55) 100%)}
.yq-stage-fish-layer{position:absolute;inset:0;z-index:2;pointer-events:none}
.yq-stage-fish{position:absolute;left:0;top:0;display:flex;flex-direction:column;align-items:center;gap:2px;will-change:transform;transform-origin:center}
.yq-stage-name{font-size:10.5px;line-height:1;color:rgba(226,244,255,.86);text-shadow:0 1px 3px rgba(0,0,0,.5);max-width:76px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.yq-stage-fish.is-guest .yq-stage-name{color:#bcd7ff}
.yq-stage-body{transition:transform .16s ease}
.yq-stage-fish.is-eating .yq-stage-body{animation:yq-munch .34s ease}
.yq-bait-layer{position:absolute;inset:0;z-index:3;pointer-events:none}
.yq-bait{position:absolute;left:0;top:0;width:8px;height:8px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#f6e7b8,#c9a24a 70%);box-shadow:0 0 8px rgba(244,222,150,.55);will-change:transform;pointer-events:none}
.yq-bait.is-dropping{animation:yq-bait-drop .18s ease-out}
.yq-route-canvas{position:absolute;inset:0;z-index:4;width:100%;height:100%;pointer-events:none!important}
.yq-bubble-layer{position:absolute;inset:0;z-index:5;pointer-events:none}
.yq-fish-bubble{position:absolute;left:0;top:0;max-width:180px;padding:4px 9px;border-radius:12px;font-size:11.5px;line-height:1.35;background:rgba(8,24,38,.82);border:1px solid rgba(140,220,245,.35);color:#e8f6ff;white-space:nowrap;animation:yq-bubble-in .18s ease-out;will-change:transform}
.yq-fish-bubble.is-sad{background:rgba(30,38,52,.86);border-color:rgba(150,170,200,.32);color:#cfe0f2}
.yq-stage-ui{position:absolute;inset:0;z-index:6;pointer-events:none}
.yq-stage-ui > *{pointer-events:auto}
.yq-route-panel{position:absolute;left:12px;top:12px;max-width:236px;padding:8px 10px;border-radius:12px;background:rgba(6,22,34,.62);border:1px solid rgba(140,220,245,.26);backdrop-filter:blur(6px);font-size:11.5px;color:#dff3ff}
.yq-route-head{display:flex;align-items:center;gap:6px;font-weight:600;font-size:11.5px;opacity:.92;margin-bottom:4px}
.yq-route-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.yq-route-item{display:flex;align-items:center;justify-content:space-between;gap:8px;white-space:nowrap;overflow:hidden}
.yq-route-name{overflow:hidden;text-overflow:ellipsis;max-width:172px}
.yq-route-state{font-style:normal;font-size:10px;padding:1px 6px;border-radius:999px;background:rgba(126,214,245,.16);border:1px solid rgba(140,220,245,.26);flex:none}
.yq-route-in .yq-route-name{color:#bcd7ff}
.yq-route-empty{margin:0;font-size:11px;opacity:.55}
.yq-pack-float{position:absolute;right:12px;top:14px;display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.yq-pack-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;border:1px solid rgba(140,220,245,.28);background:rgba(6,22,34,.6);color:#e8f6ff;font:inherit;font-size:11.5px;cursor:pointer;backdrop-filter:blur(6px)}
.yq-pack-btn:hover{border-color:rgba(140,220,245,.5)}
.yq-pack-emoji{font-size:14px}
.yq-pack-count{opacity:.8}
.yq-pack-pop{width:196px;padding:9px 10px;border-radius:12px;background:rgba(6,22,34,.86);border:1px solid rgba(140,220,245,.3);box-shadow:0 18px 40px -24px rgba(0,0,0,.9);font-size:11.5px;color:#e8f6ff}
.yq-pack-pop-head{font-weight:600;margin-bottom:5px;opacity:.9}
.yq-pack-stock{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px;max-height:168px;overflow:auto}
.yq-pack-stock li{display:flex;justify-content:space-between;gap:8px}
.yq-pack-stock-count{font-style:normal;opacity:.72}
.yq-pack-stock-empty{margin:0;opacity:.55}
.yq-pack-open{margin-top:8px;width:100%;justify-content:center;font-size:11.5px}
.yq-bait-btn{position:absolute;left:12px;bottom:12px;display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border-radius:999px;border:1px solid rgba(244,222,150,.4);background:rgba(48,36,12,.55);color:#ffeec2;font:inherit;font-size:12px;cursor:pointer;backdrop-filter:blur(6px)}
.yq-bait-btn:hover{border-color:rgba(244,222,150,.7)}
.yq-bait-btn.is-armed{background:rgba(122,88,26,.7);box-shadow:0 0 0 3px rgba(244,222,150,.16)}
.yq-bait-btn-emoji{font-size:14px}
.yq-stage-hint{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:12px;letter-spacing:.04em;color:rgba(214,240,255,.34);pointer-events:none;text-align:center;white-space:nowrap}
.yq-postcard{position:absolute;left:50%;top:26%;transform:translate(-50%,0);display:flex;flex-direction:column;gap:3px;padding:10px 14px;border-radius:12px;background:rgba(8,26,40,.9);border:1px solid rgba(140,220,245,.4);box-shadow:0 20px 44px -26px rgba(0,0,0,.95);color:#eaf7ff;max-width:280px;animation:yq-postcard-in .26s ease-out;pointer-events:none}
.yq-postcard-title{font-size:12px;font-weight:600}
.yq-postcard-text{font-size:11.5px;line-height:1.45;opacity:.85}
.yq-pond-meta{position:absolute;right:12px;bottom:12px;display:flex;gap:10px;font-size:11px;color:rgba(214,240,255,.5);pointer-events:none}
@keyframes yq-stage-wave{0%,100%{transform:translate3d(-2%,0,0) scale(1)}50%{transform:translate3d(2%,-1.5%,0) scale(1.04)}}
@keyframes yq-stage-sway{0%,100%{transform:rotate(12deg) translateX(0)}50%{transform:rotate(18deg) translateX(10px)}}
@keyframes yq-stage-kelp{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(6deg)}}
@keyframes yq-bait-drop{from{opacity:0;transform:scale(.4)}to{opacity:1;transform:scale(1)}}
@keyframes yq-postcard-in{from{opacity:0;transform:translate(-50%,-8px)}to{opacity:1;transform:translate(-50%,0)}}
@media (max-width:980px){.yq-stage-slot{height:320px}}
@media (prefers-reduced-motion:reduce){.yq-stage-water:before,.yq-stage-ray,.yq-stage-weed,.yq-bait.is-dropping,.yq-postcard{animation:none}}

/* 整理行囊 */
.yq-pack-group{display:flex;flex-direction:column;gap:8px}
.yq-pack-group-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.yq-pack-group-title{font-size:12.5px;font-weight:600}
.yq-pack-group-hint{font-size:11px;color:var(--dsw-alias-label-secondary)}
.yq-pack-items{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}
.yq-pack-item{display:flex;flex-direction:column;gap:3px;text-align:left;padding:9px 11px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 60%,transparent);color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit}
.yq-pack-item:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,var(--dsw-alias-border-l2))}
.yq-pack-item.is-active{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 52%,transparent)}
.yq-pack-item.is-empty{opacity:.5;cursor:not-allowed}
.yq-pack-item-name{font-size:12.5px;font-weight:600}
.yq-pack-item-count{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.yq-pack-item-desc{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary)}
.yq-pack-note{margin:2px 0 0;font-size:11px;color:var(--dsw-alias-label-secondary)}

@keyframes yq-bubble-in{from{opacity:0}to{opacity:1}}
@keyframes yq-munch{0%,100%{transform:scaleY(1)}45%{transform:scaleY(.72)}}
@media (max-width:620px){.yq-pack-items{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.yq-fish-bubble,.yq-stage-fish.is-eating .yq-stage-body{animation:none!important}}
`

    /* ---------------------------------------------------------------- */
    /* 注册                                                              */
    /* ---------------------------------------------------------------- */

    // 离线渲染检查（.verify/ui-render.mjs）用的出口：正常运行时这个标记不存在，
    // 挂载一次就把组件挂到 window 上，方便在没有真实 state 的情况下逐个渲染。
    if (globalThis.__YQ_RENDER_TEST__) {
      globalThis.__YQ_COMPONENTS__ = { FishGlyph, PondScene, PondStage, PackDialog, SkinCard, CustomSkinCard, RosterCard, GateCard, GuideModal, YuquanPanel }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_KEY }, YuquanPanel))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_KEY,
          order: -10,
          label: () => '鱼圈',
        }, (owner) => h(SidebarFish, { size: owner && owner.size, active: owner && owner.active })))
      },
    }
  },
})
