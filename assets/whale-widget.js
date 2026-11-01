/* ============================================================================
 * 侧栏余额读数（dsh-balance-plain）
 * ----------------------------------------------------------------------------
 * 纯文本前端：余额 / 今日已用 / 峰谷倒计时 / 每轮消耗 / 余额预警。
 * 数据与设置来自服务端 lib/index.js 的路由，这里只负责渲染与轮询。
 *
 * 显示方式：
 *   ① 侧栏常驻（默认）：**真正嵌进侧栏 footer 的 DOM** —— 插在账号行所在那块
 *      （dsh-claude-style 标记的 settings-area）内部的第一个子节点。footer 是
 *      flex:0 0 auto、列表区是 flex:1 1 0%，所以这行长高会自动挤占列表区，
 *      不覆盖任何内容，也不是钉在屏幕坐标上的浮层；侧栏收起时随 footer 一起消失。
 *   ② 账户菜单打开时：嵌入行先隐藏，改为在菜单里显示一行（克隆原生菜单行）。
 *   ③ 找不到侧栏 footer 时：整行不显示（不回退到浮动层）。
 *
 * 视觉：无背景板、无边框、无阴影、无图标、无动画；颜色继承侧栏文字色。
 * 整个挂载点 pointer-events:none —— 点不动，也不挡住任何点击。
 *
 * 不含：鲸鱼角色图 / 按压 Q 弹 / 拖拽吸附 / 镜像翻转 / 点击泡泡队列 /
 * 泡泡编辑器 / 音效 / 角色与音频管理 / 菜单 / 任何鼠标触摸事件。
 *
 * 依赖的服务端路由（前端只消费这 4 条）：
 *     GET /dsh-whale/balance.json        余额 + 今日已用 + 峰谷
 *     GET /dsh-whale/last-turn.json      上一轮消耗与递增序号
 *     GET /dsh-whale/size.json           每轮消耗开关 / 自动关闭毫秒
 *     GET /dsh-whale/usage-settings.json 余额预警开关与阈值
 * ========================================================================== */
(function () {
  'use strict'
  if (window.__dshBalancePlain) return
  window.__dshBalancePlain = true

  var API = '/dsh-whale'
  var BAL_MS = 10000        // 余额轮询：10 秒
  var BAL_MS_SLOW = 60000   // 连续失败时的退避间隔
  var TURN_MS = 2000
  var TICK_MS = 20000
  var LS_ALERT_ARMED = 'dshbp-alert-armed'
  var LS_LAST_SEQ = 'dshbp-last-seq'
  var DEFAULT_TURN_CLOSE_MS = 5000

  // 侧栏结构锚点：优先用 dsh-claude-style 主题打的 data-dsh-claude-part 标记；
  // 主题被禁用时退回宿主自己的 class（footer 的类名里一定带 footArea）。
  var FOOT_PART = '[data-dsh-claude-part~="foot-area"]'
  var SIDEBAR_PART = '[data-dsh-claude-part~="sidebar-column"]'
  var FOOT_CLASS = '[class*=footArea]'
  var SIDEBAR_CLASS = '[class*=sidebarCol]'
  var EMBED_ID = 'dshbp-embed'

  var POP_ROW_CLASS = '.dsh-claude-account-popover-row'
  var USAGE_TEXT = '账户用量'

  var S = {
    mounted: false,
    embed: null,      // 真正插进侧栏 footer 的那一层
    lineEl: null,     // 余额行
    toastEl: null,    // 提示行（每轮消耗 / 余额预警），平时 display:none
    bal: null,
    size: null,
    settings: null,
    lastSeq: null,
    toastText: '',
    toastUntil: 0,
    toastTimer: 0,
    mountTimer: 0,
    theme: '',
    popOpen: false,
    popRow: null,
    popObserver: null,
    footerEl: null,
    columnEl: null,
    columnPatched: false,
    columnPrevPosition: '',
  }

  /* ---------------------------------------------------------------- 工具 */

  function lsGet(k) { try { return window.localStorage.getItem(k) } catch (e) { return null } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v) } catch (e) {} }

  function getJSON(url) {
    var opt = { credentials: 'same-origin', cache: 'no-store' }
    try { opt.signal = AbortSignal.timeout(20000) } catch (e) {}
    return fetch(url, opt).then(function (r) {
      return r.ok ? r.json() : null
    }).catch(function () { return null })
  }

  function isChatRoot(r) {
    if (!r || !r.querySelector) return false
    return !!(
      r.querySelector('textarea') ||
      r.querySelector('[contenteditable="true"]') ||
      r.querySelector('[data-composer-input]') ||
      r.querySelector('[data-composer-seat],[data-composer-card]') ||
      r.querySelector('[role="textbox"][aria-multiline="true"]')
    )
  }

  function fmtMoney(v) {
    var n = Number(v)
    if (!isFinite(n)) return '—'
    try {
      return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    } catch (e) { return n.toFixed(2) }
  }

  function fmtCost(v) {
    var n = Number(v)
    if (!isFinite(n)) return '—'
    var abs = Math.abs(n)
    if (abs > 0 && abs < 0.01) return n.toFixed(4)
    return fmtMoney(n)
  }

  function fmtTokens(n) {
    n = Number(n) || 0
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
    return String(Math.round(n))
  }

  function fmtRemain(ms) {
    if (!isFinite(ms) || ms <= 0) return ''
    var m = Math.floor(ms / 60000)
    if (m >= 1440) return Math.floor(m / 1440) + 'd' + Math.floor((m % 1440) / 60) + 'h'
    if (m >= 60) return Math.floor(m / 60) + 'h' + (m % 60) + 'm'
    return Math.max(1, m) + 'm'
  }

  function currencySign(cur) {
    var c = String(cur || 'CNY').toUpperCase()
    if (c === 'USD') return '$'
    if (c === 'EUR') return '€'
    return '¥'
  }

  /* ------------------------------------------------------- 主题自适应颜色 */

  function backgroundColorBehind(el) {
    try {
      var x = 30
      var y = window.innerHeight - 60
      var node = el || S.embed
      if (node && node.getBoundingClientRect) {
        var br = node.getBoundingClientRect()
        if (br && br.width > 0 && br.height > 0) {
          x = Math.max(2, Math.round(br.left + Math.min(40, br.width / 2)))
          y = Math.max(2, Math.round(br.top + Math.min(8, br.height / 2)))
        }
      }
      var hit = document.elementFromPoint(x, y)
      while (hit) {
        var cs = window.getComputedStyle(hit)
        var c = cs && cs.backgroundColor
        if (c && c !== 'transparent' && c !== 'rgba(0, 0, 0, 0)') return c
        hit = hit.parentElement
      }
    } catch (e) {}
    return ''
  }

  function isDarkColor(css) {
    var m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(String(css || ''))
    if (!m) return false
    var r = Number(m[1]), g = Number(m[2]), b = Number(m[3])
    if (!isFinite(r) || !isFinite(g) || !isFinite(b)) return false
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128
  }

  function applyTheme(force) {
    var node = S.embed
    if (!node) return
    var bgCss = backgroundColorBehind(node)
    var dark = isDarkColor(bgCss)
    var key = dark ? 'dark' : 'light'
    if (!force && key === S.theme) return
    S.theme = key
    // 文字色继承侧栏，这里只调峰/谷/预警三个强调色
    var peak = dark ? '#ffb3a7' : '#b5523c'
    var valley = dark ? '#9fe0b4' : '#3f7d52'
    var warn = dark ? '#ffd08a' : '#a8621c'
    try {
      node.style.setProperty('--dshbp-peak', peak)
      node.style.setProperty('--dshbp-valley', valley)
      node.style.setProperty('--dshbp-warn', warn)
    } catch (e) {}
  }

  /* ---------------------------------------------------------------- 样式 */

  var RULES = [
    '.dshbp-line,.dshbp-toastline{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    // 提示行：比余额行小一号，叠在余额行上面，不顶替余额
    '.dshbp-toastline{font-size:11px;line-height:1.45;opacity:.95;}',
    // 弱化用透明度而不是写死颜色 —— 文字色继承侧栏，深浅主题自动跟随
    '.dshbp-dim{opacity:.58;}',
    '.dshbp-sep{opacity:.38;margin:0 5px;}',
    '.dshbp-peak{color:var(--dshbp-peak,#b5523c);}',
    '.dshbp-valley{color:var(--dshbp-valley,#3f7d52);}',
    '.dshbp-warn{color:var(--dshbp-warn,#a8621c);}',
  ].join('')

  var CSS = [
    // 真正嵌进侧栏 footer：没有背景、没有边框，宽度跟随 footer 内容区，
    // 高度由内容撑开（footer 是 flex:0 0 auto），列表区 flex:1 1 0% 自动让位。
    '#dshbp-embed{display:block;flex:0 0 auto;width:100%;box-sizing:border-box;',
    'margin:0;padding:2px 8px 4px 8px;',
    'pointer-events:none;user-select:none;-webkit-user-select:none;',
    'font:500 12.5px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
    'letter-spacing:.2px;color:inherit;white-space:nowrap;overflow:hidden;',
    'background:transparent;border:0;text-shadow:none;}',
    RULES,
    // 克隆进账户菜单的那一行：继承菜单样式，只保证不可点
    '[data-dshbp-poprow]{pointer-events:none!important;cursor:default!important;}',
    '[data-dshbp-poprow] .dshbp-poprow-t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
  ].join('')

  function ensureStyle() {
    if (document.getElementById('dshbp-style')) return
    try {
      var st = document.createElement('style')
      st.id = 'dshbp-style'
      st.textContent = CSS
      ;(document.head || document.documentElement).appendChild(st)
    } catch (e) {}
  }

  function span(cls, text) {
    var s = document.createElement('span')
    if (cls) s.className = cls
    if (text != null) s.textContent = text
    return s
  }

  /* ------------------------------------------ 找侧栏锚点：左下角账号行 */

  // 账号行 = 侧栏最底部那个"头像 + 昵称 + 下拉箭头"的按钮。
  // 判据只依赖位置与文本长度，不依赖 class 名（class 由 dsh-claude-style 提供，可能改名）。
  function queryFirst(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var el = null
      try { el = document.querySelector(selectors[i]) } catch (e) { el = null }
      if (el) return el
    }
    return null
  }

  function findAccountRowEl() {
    var list = null
    var scope = queryFirst([SIDEBAR_PART, SIDEBAR_CLASS])
    try { list = (scope || document).querySelectorAll('[role="button"],button') } catch (e) { return null }
    var best = null
    for (var i = 0; i < list.length; i++) {
      var el = list[i]
      if (!el || !el.getBoundingClientRect) continue
      if (el.id === 'dshbp-embed') continue
      if (el.closest && el.closest('#dshbp-embed')) continue
      var r = el.getBoundingClientRect()
      if (!r || r.width < 150 || r.height < 24 || r.height > 80) continue   // 收起态只剩一个头像（很窄）→ 认不到锚点
      if (r.left > 80) continue                          // 贴左侧栏
      if (r.top < window.innerHeight * 0.72) continue     // 在窗口最下面一段
      if (r.bottom > window.innerHeight + 4) continue
      var t = (el.textContent || '').replace(/\s+/g, '')
      if (!t || t.length > 24) continue                   // 昵称很短，排除大容器
      if (el.querySelector && el.querySelector('[role="button"],button')) continue // 排除包着按钮的容器
      if (!best || r.top > best.r.top) best = { el: el, r: r }
    }
    return best ? best.el : null
  }

  // 往上找"纵向 flex"的祖先容器：账号行的直接父级可能是横向 flex（头像+昵称+箭头一排），
  // 直接插兄弟节点会排到同一行去（实测踩到：余额和账号行并排）。
  // 找到纵向容器后，把读数插在"包含账号行的那个块"之前。

  /* ------------------------------------ 真正嵌进侧栏 footer（DOM 内嵌）

    侧栏 footer 的结构（dsh-claude-style 主题标记过）：
      foot-area (flex column, flex:0 0 auto, 高度由内容撑开)
        ├─ footer-actions (0×0)
        └─ settings-area (装账号行那一块)
             └─ … → 账号按钮
    列表区 region-area 是 flex:1 1 0%，footer 长高会自动挤占它 —— 插进去不会盖住任何内容。

    ⚠ 必须插在 settings-area **内部**：
    主题会把 foot-area 的「不认识的直接子节点」标成 data-dsh-claude-footer-entry +
    data-dsh-claude-footer-hidden 并 display:none!important（实测插在外面会被吞掉）。 */

  function findFooterSlot(row) {
    var foot = queryFirst([FOOT_PART, FOOT_CLASS])
    if (!foot || !row) return null
    var el = row
    var guard = 0
    while (el && el.parentElement !== foot && guard++ < 12) el = el.parentElement
    return el && el.parentElement === foot ? el : null
  }

  function ensureEmbed(slot) {
    if (!slot) return null
    var emb = S.embed
    if (!emb) {
      emb = document.createElement('div')
      emb.id = EMBED_ID
      S.toastEl = document.createElement('div')
      S.toastEl.className = 'dshbp-toastline dshbp-warn'
      S.toastEl.style.display = 'none'
      S.lineEl = document.createElement('div')
      S.lineEl.className = 'dshbp-line'
      emb.appendChild(S.toastEl)
      emb.appendChild(S.lineEl)
      S.embed = emb
    }
    try {
      if (!emb.isConnected || emb.parentElement !== slot) slot.insertBefore(emb, slot.firstChild)
      else if (slot.firstElementChild !== emb) slot.insertBefore(emb, slot.firstChild)
    } catch (e) { return null }
    return emb
  }

  function setEmbedVisible(on) {
    var emb = S.embed
    if (!emb) return
    var v = on ? '' : 'none'
    if (emb.style.display !== v) emb.style.display = v
  }

  /* ------------------------------------------ 账户菜单：克隆原生行 */

  function isUsageRowCandidate(el) {
    if (!el || !el.getBoundingClientRect) return false
    var t = el.textContent || ''
    if (t.indexOf(USAGE_TEXT) < 0) return false
    if (t.length > 40) return false
    var r = el.getBoundingClientRect()
    if (!r) return false
    if (r.width < 80 || r.width > 460) return false
    if (r.height < 16 || r.height > 72) return false
    if (r.left > 460) return false
    if (r.top < 0 || r.top > window.innerHeight) return false
    return true
  }

  function normalizeRow(el) {
    if (!el || !el.closest) return el
    if (el.matches && el.matches('[role="button"],button,[role="menuitem"]')) return el
    var b = el.closest('[role="button"],button,[role="menuitem"]')
    return b || el
  }

  function findUsageRow() {
    var rows = null
    try { rows = document.querySelectorAll(POP_ROW_CLASS) } catch (e) { rows = null }
    if (rows) {
      for (var i = 0; i < rows.length; i++) {
        if (isUsageRowCandidate(rows[i])) return normalizeRow(rows[i])
      }
    }
    var btns = null
    try {
      btns = document.querySelectorAll('[role="button"],button,[role="menuitem"],a')
    } catch (e) { btns = null }
    if (btns) {
      for (var j = 0; j < btns.length; j++) {
        if (isUsageRowCandidate(btns[j])) return btns[j]
      }
    }
    return null
  }

  function ensurePopRow(rowEl) {
    if (!rowEl || !rowEl.parentNode) return null
    var clone = S.popRow
    if (clone && clone.isConnected) return clone
    try {
      clone = rowEl.cloneNode(true)
      while (clone.firstChild) clone.removeChild(clone.firstChild)
      clone.setAttribute('data-dshbp-poprow', '1')
      clone.removeAttribute('aria-label')
      clone.removeAttribute('title')
      var t = document.createElement('span')
      t.className = 'dshbp-poprow-t'
      clone.appendChild(t)
      rowEl.parentNode.insertBefore(clone, rowEl)
      S.popRow = clone
      return clone
    } catch (e) {
      S.popRow = null
      return null
    }
  }

  function dropPopRow() {
    var c = S.popRow
    S.popRow = null
    if (c && c.parentNode) {
      try { c.parentNode.removeChild(c) } catch (e) {}
    }
  }

  /* ------------------------------------------------------------ 位置切换 */

  function position() {
    if (!S.mounted) return

    // ① 账户菜单开着 → 菜单里用克隆行显示，嵌入行先收起来避免重复
    var row = findUsageRow()
    S.popOpen = !!row
    if (row) {
      var clone = ensurePopRow(row)
      if (clone) {
        setEmbedVisible(false)
        renderPopRow()
        return
      }
    }
    dropPopRow()

    // ② 真正嵌进侧栏 footer（侧栏收起时 footer 本身 display:none，这里自然找不到）
    var acc = findAccountRowEl()
    var slot = acc ? findFooterSlot(acc) : null
    if (slot) {
      var emb = ensureEmbed(slot)
      if (emb) {
        setEmbedVisible(true)
        render()
        applyTheme(false)
        return
      }
    }

    // ③ 找不到侧栏 footer → 整行不显示，不回退到浮动层
    setEmbedVisible(false)
  }

  /* ---------------------------------------------------------------- 渲染 */

  function peakInfo() {
    var b = S.bal
    if (!b || b.isPeak === undefined || b.isPeak === null) return null
    var isPeak = !!b.isPeak
    var at = Number(b.peakNextChangeAt)
    var left = isFinite(at) && at > 0 ? fmtRemain(at * 1000 - Date.now()) : ''
    return { isPeak: isPeak, left: left, label: isPeak ? '峰' : '谷' }
  }

  function textHost() {
    if (!S.lineEl || !S.embed || !S.embed.isConnected) return null
    return S.lineEl
  }

  function toastActive() {
    return !!S.toastText && Date.now() < S.toastUntil
  }

  function render() {
    if (!S.mounted) return
    var host = textHost()
    if (!host) return
    var b = S.bal
    while (host.firstChild) host.removeChild(host.firstChild)
    host.title = ''

    // 提示不再顶替余额：单独一行小字放在余额行上方，余额那行始终在。
    if (S.toastEl) {
      if (toastActive()) {
        S.toastEl.textContent = S.toastText
        S.toastEl.style.display = ''
      } else {
        S.toastEl.textContent = ''
        S.toastEl.style.display = 'none'
        S.toastText = ''
      }
    }

    if (!b) {
      host.appendChild(span('dshbp-dim', '余额加载中…'))
      return
    }

    var sign = currencySign(b.currency)
    var ok = b.ok !== false && b.totalBalance !== null && b.totalBalance !== undefined

    host.appendChild(span('dshbp-dim', '余额 '))
    if (ok) host.appendChild(span('', sign + fmtMoney(b.totalBalance)))
    else host.appendChild(span('dshbp-warn', '—'))

    if (b.todayUsage !== null && b.todayUsage !== undefined) {
      host.appendChild(span('dshbp-sep', '·'))
      host.appendChild(span('dshbp-dim', '今日 '))
      host.appendChild(span('', currencySign(b.todayUsageCurrency || b.currency) + fmtMoney(b.todayUsage)))
    }

    var p = peakInfo()
    if (p) {
      host.appendChild(span('dshbp-sep', '·'))
      host.appendChild(span(p.isPeak ? 'dshbp-peak' : 'dshbp-valley', p.label))
      if (p.left) host.appendChild(span('dshbp-dim', ' ' + p.left))
    }

    if (b.stale) {
      host.appendChild(span('dshbp-sep', '·'))
      host.appendChild(span('dshbp-dim', '离线'))
    }

    if (b.ok === false) host.title = String(b.error || b.code || '余额获取失败')
    else if (b.ledgerError) host.title = '记账失败：' + String(b.ledgerError)

    renderPopRow()
  }

  function plainText() {
    var b = S.bal
    if (!b) return '余额加载中…'
    var sign = currencySign(b.currency)
    var ok = b.ok !== false && b.totalBalance !== null && b.totalBalance !== undefined
    var out = '余额 ' + (ok ? sign + fmtMoney(b.totalBalance) : '—')
    if (b.todayUsage !== null && b.todayUsage !== undefined) {
      out += ' · 今日 ' + currencySign(b.todayUsageCurrency || b.currency) + fmtMoney(b.todayUsage)
    }
    var p = peakInfo()
    if (p) out += ' · ' + p.label + (p.left ? ' ' + p.left : '')
    if (b.stale) out += ' · 离线'
    return out
  }

  function renderPopRow() {
    var c = S.popRow
    if (!c || !c.isConnected) return
    var t = c.querySelector('.dshbp-poprow-t')
    if (!t) return
    var txt = toastActive() ? S.toastText : plainText()
    if (t.textContent !== txt) t.textContent = txt
  }

  // 提示直接占用那一行显示，到时自动恢复（不额外浮气泡）
  function toast(text, ms) {
    if (!S.mounted) return
    S.toastText = String(text || '')
    S.toastUntil = Date.now() + (ms > 0 ? ms : 365 * 24 * 3600 * 1000)
    if (S.toastTimer) clearTimeout(S.toastTimer)
    S.toastTimer = 0
    render()
    renderPopRow()
    if (ms > 0) {
      S.toastTimer = setTimeout(function () {
        S.toastTimer = 0
        S.toastText = ''
        S.toastUntil = 0
        render()
        renderPopRow()
      }, ms)
    }
  }

  /* ------------------------------------------------------------ 余额预警 */

  function alertArmed() {
    var v = lsGet(LS_ALERT_ARMED)
    return v === null ? true : v === '1'
  }

  function checkAlert() {
    var b = S.bal
    var a = S.settings && S.settings.alert
    if (!b || b.ok === false || !a) return
    if (a.on === false) return
    var below = Number(a.below)
    var total = Number(b.totalBalance)
    if (!isFinite(below) || below <= 0 || !isFinite(total)) return

    if (total >= below) {
      if (!alertArmed()) lsSet(LS_ALERT_ARMED, '1')
      return
    }
    if (!alertArmed()) return
    lsSet(LS_ALERT_ARMED, '0')

    var sign = currencySign(b.currency)
    var msg = String(a.msg || '余额预警：当前余额已低于设定值 {below}')
    msg = msg.split('{below}').join(sign + fmtMoney(below))
    var ttl = Number(a.ttlSec) > 0 ? Number(a.ttlSec) * 1000 : 8000
    toast(msg, a.autoClose === true ? ttl : 0)
  }

  /* ------------------------------------------------------------ 每轮消耗 */

  function turnCostEnabled() {
    return !(S.size && S.size.turnCostOn === false)
  }

  function turnCloseMs() {
    var v = S.size && S.size.turnCostCloseMs
    return typeof v === 'number' && v >= 0 ? v : DEFAULT_TURN_CLOSE_MS
  }

  function showTurn(t) {
    if (!turnCostEnabled()) return
    if (!t || t.amount === null || t.amount === undefined) return
    var amount = Number(t.amount)
    if (!isFinite(amount)) return
    var b = S.bal
    var sign = currencySign((b && b.currency) || 'CNY')
    var text = '上一轮 ' + sign + fmtCost(amount)
    var toks = Number(t.tokens)
    if (isFinite(toks) && toks > 0) text += ' · ' + fmtTokens(toks) + ' tok'
    toast(text, turnCloseMs())
  }

  function pollTurn() {
    return getJSON(API + '/last-turn.json').then(function (r) {
      if (!r || r.ok === false) return
      var seq = Number(r.seq) || 0
      if (S.lastSeq === null) {
        var saved = Number(lsGet(LS_LAST_SEQ)) || 0
        S.lastSeq = seq
        lsSet(LS_LAST_SEQ, String(seq))
        if (seq > saved && saved > 0) showTurn(r)
        return
      }
      if (seq !== S.lastSeq) {
        S.lastSeq = seq
        lsSet(LS_LAST_SEQ, String(seq))
        showTurn(r)
        nudgeBalance() // 这一轮的钱已经花出去了，马上刷一次余额
      }
    })
  }

  /* ------------------------------------------------------------ 数据拉取 */

  function refreshBalance(force) {
    return getJSON(API + '/balance.json' + (force ? '?refresh=1' : '')).then(function (r) {
      if (r) {
        S.bal = r
        render()
        checkAlert()
      }
      return r
    })
  }

  function loadConfig() {
    return Promise.all([
      getJSON(API + '/size.json'),
      getJSON(API + '/usage-settings.json'),
    ]).then(function (pair) {
      var size = pair[0]
      var us = pair[1]
      if (size && typeof size === 'object') S.size = size
      if (us && us.ok !== false && us.settings && typeof us.settings === 'object') S.settings = us.settings
    })
  }

  function refreshAll() {
    return loadConfig().then(function () {
      return refreshBalance(false)
    }).then(function () {
      return pollTurn()
    })
  }

  /* ---------------------------------------------------------------- 挂载 */

  function mount() {
    if (S.mounted) return true
    if (!isChatRoot(document.body)) return false
    try {
      ensureStyle()
      S.mounted = true
      if (S.mountTimer) { clearInterval(S.mountTimer); S.mountTimer = 0 }
      position()
      watchPopover()
      refreshAll()
      return true
    } catch (e) {
      return false
    }
  }

  function startMountLoop() {
    if (S.mounted || S.mountTimer) return
    if (mount()) return
    var started = Date.now()
    S.mountTimer = setInterval(function () {
      if (mount()) return
      if (Date.now() - started > 5 * 60000) {
        clearInterval(S.mountTimer)
        S.mountTimer = 0
      }
    }, 700)
  }

  /* ------------------------------------------------- 菜单开合：即时响应 */

  function popoverOpenNow() {
    return !!findUsageRow()
  }

  function watchPopover() {
    if (S.popObserver) return
    var timer = 0
    var check = function () {
      timer = 0
      var open = popoverOpenNow()
      if (open === S.popOpen) return
      position()
    }
    try {
      S.popObserver = new MutationObserver(function () {
        if (timer) return
        timer = setTimeout(check, 60)
      })
      S.popObserver.observe(document.body, { childList: true, subtree: true })
    } catch (e) {
      S.popObserver = null
    }
  }

  /* ------------------------------------------------------------ 启动 */

  // —— 余额轮询调度 ——
  // 服务端 getBalance 有 25s 缓存（BALANCE_TTL_MS），所以每次都要带 refresh=1 才是真取数；
  // 连续失败 3 次后退避到 60s，避免接口抖动时每 10 秒打一次。
  var balTimer = 0
  var balFail = 0

  function scheduleBalance(ms) {
    if (balTimer) { clearTimeout(balTimer); balTimer = 0 }
    balTimer = setTimeout(function () {
      balTimer = 0
      refreshBalance(true).then(function (r) {
        if (r && r.ok !== false) balFail = 0
        else balFail = Math.min(balFail + 1, 5)
        scheduleBalance(balFail >= 3 ? BAL_MS_SLOW : BAL_MS)
      })
    }, ms)
  }

  function nudgeBalance() {
    balFail = 0
    scheduleBalance(1200)
  }

  function startTimers() {
    // 余额：自调度轮询（10s；连续失败退到 60s），每轮都带 refresh=1 绕过服务端 25s 缓存
    scheduleBalance(BAL_MS)
    setInterval(function () { pollTurn() }, TURN_MS)
    setInterval(function () { applyTheme(false) }, 5000)
    // 侧栏被 React 重渲染（收起/展开/切会话）后，把内嵌元素重新插回去
    setInterval(position, 1500)
    window.addEventListener('resize', function () { position(); applyTheme(true) })
    setInterval(render, TICK_MS)
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') { position(); nudgeBalance() }
    })
    setInterval(loadConfig, 10 * 60000)
  }

  function boot() {
    startMountLoop()
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startMountLoop)
    }
    startTimers()
  }

  boot()
})()
