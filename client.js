/**
 * dsh-xdpool-billing — 浏览器半侧：XD Pool 积分余额与已用量面板。
 *
 * 宿主半侧把状态放在同源的 `GET /__xdpool-billing/state.json`；
 * 这里只做轮询 + 渲染，注册进 `conversation.composer.dock`。
 * 组件完全自包含：拿不到数据就渲染 null，绝不影响输入区。
 */
window.__ModuleLoader__.load({
  id: 'dsh-xdpool-billing',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const NS = 'dsh-xdpool-billing'
    const STATE_URL = '/__xdpool-billing/state.json'
    const POLL_MS = 30000

    const zh = {
      pill: 'XD Pool 积分',
      balance: '余额',
      today: '今日已用',
      month: '本月已用',
      all: '累计已用',
      accounts: '账号',
      packages: '积分包',
      tokens: 'Token',
      input: '输入',
      output: '输出',
      reasoning: '思考',
      cached: '缓存',
      calls: '调用',
      refresh: '刷新',
      collapse: '收起',
      unavailable: '数据源不可用',
      unknown: '未知',
      partial: '已知部分',
      stale: '个旧读数',
      staleHint: '部分账号本次查询失败，显示的是上一次读数：',
      expiry: '过期预警',
      noExpiry: '暂无快过期的积分',
      nextExpiry: '最近到期',
      days: '天',
      daysWithin: '天内',
      credits: '积分',
      hint: '积分余额与用量来自 XD Pool 插件；已用量按余额快照差值实测统计。',
    }
    const en = {
      pill: 'XD Pool credits',
      balance: 'Balance',
      today: 'Used today',
      month: 'Used this month',
      all: 'Used all-time',
      accounts: 'Accounts',
      packages: 'packages',
      tokens: 'Tokens',
      input: 'input',
      output: 'output',
      reasoning: 'reasoning',
      cached: 'cached',
      calls: 'calls',
      refresh: 'Refresh',
      collapse: 'Collapse',
      unavailable: 'source unavailable',
      unknown: 'unknown',
      partial: 'known',
      stale: 'stale',
      staleHint: 'Some accounts failed to refresh; showing last known reading:',
      expiry: 'Expiry',
      noExpiry: 'No credits expiring soon',
      nextExpiry: 'Next expiry',
      days: 'd',
      daysWithin: 'd within',
      credits: 'credits',
      hint: 'Balance and usage come from the XD Pool plugin; consumption is measured from balance snapshots.',
    }

    function tok(n) {
      const v = Number(n) || 0
      if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B'
      if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
      if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k'
      return String(v)
    }

    const S = {
      pill: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 999,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 11,
        lineHeight: 1.6,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      dot: { width: 6, height: 6, borderRadius: 999, background: 'var(--dsw-alias-brand-primary)', flex: '0 0 auto' },
      card: {
        marginTop: 6,
        padding: '8px 10px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-overlay)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 11,
        lineHeight: 1.7,
        minWidth: 260,
      },
      row: { display: 'flex', justifyContent: 'space-between', gap: 12 },
      dim: { color: 'var(--dsw-alias-label-secondary)' },
      warn: { color: 'var(--dsw-alias-state-warn-primary)' },
      err: { color: 'var(--dsw-alias-state-error-primary)' },
      bar: { position: 'relative', height: 6, borderRadius: 999, background: 'var(--dsw-alias-bg-layer-2)', overflow: 'hidden', marginTop: 2 },
      barFill: { position: 'absolute', inset: 0, width: '0%', background: 'var(--dsw-alias-brand-primary)' },
      acct: { borderTop: '1px solid var(--dsw-alias-border-l1)', marginTop: 5, paddingTop: 4 },
      ok: { color: 'var(--dsw-alias-state-success-primary)' },
      sep: { color: 'var(--dsw-alias-label-secondary)', opacity: 0.55 },
    }

    /**
     * 过期预警区块。
     *
     * 三个层次，从急到缓：
     *   1. 最近一次到期：还有多少天、过期多少积分（用户最想知道的）
     *   2. 3/7/30 天分档：各档累计多少积分要过期（累计口径，不可相加）
     *   3. 到期日历：哪一天会过期多少，用于安排「先花掉它」
     */
    function expiryBlock(expiry, t) {
      if (!expiry) return null
      const buckets = Array.isArray(expiry.buckets) ? expiry.buckets : []
      const timeline = Array.isArray(expiry.timeline) ? expiry.timeline : []
      const next = expiry.nextExpiry
      const total = expiry.expiringTotal ?? 0
      if (total <= 0 && timeline.length === 0) {
        return h(
          'div',
          { style: { marginTop: 6 } },
          h('div', { style: S.dim }, t('expiry')),
          h('div', { style: { ...S.ok, fontSize: 11 } }, t('noExpiry')),
        )
      }
      const urgent = next && next.daysLeft <= 7
      return h(
        'div',
        { style: { marginTop: 6, borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 4 } },
        h(
          'div',
          { style: S.row },
          h('span', { style: S.dim }, t('expiry')),
          h('span', { style: urgent ? S.err : undefined }, `${total} ${t('credits')}`),
        ),
        next
          ? h(
              'div',
              { style: S.row },
              h('span', { style: S.dim }, t('nextExpiry')),
              h(
                'span',
                { style: urgent ? S.err : undefined },
                `${next.date ?? clock(next.at)} · ${next.daysLeft.toFixed(1)} ${t('days')} · ${next.credits}`,
              ),
            )
          : null,
        buckets.length
          ? h(
              'div',
              { style: { ...S.dim, marginTop: 2 } },
              buckets.map(bucket => `${bucket.days}${t('daysWithin')} ${bucket.credits}`).join(' · '),
            )
          : null,
        timeline.length
          ? h(
              'div',
              { style: { marginTop: 3 } },
              timeline.slice(0, 5).map(entry =>
                h(
                  'div',
                  { key: entry.date, style: { ...S.row, fontSize: 10 } },
                  h('span', { style: S.dim }, entry.date),
                  h('span', null, `${entry.credits} (${entry.packages})`),
                ),
              ),
            )
          : null,
      )
    }

    // Panel 在工厂作用域里定义，而 ctx 只在 apply 里可见：
    // 用一个模块级引用把两者接起来（apply 一定先于任何渲染发生）。
    let hostCtx = null

    /**
     * 翻译函数。宿主 locale 服务不可用时退回中文表，而不是让组件崩掉：
     * 一个崩掉的 slot entry 会让整格空白，界面上看不出插件坏在哪。
     */
    function translator() {
      const fallback = key => (zh[key] !== undefined ? zh[key] : key)
      try {
        if (!hostCtx || !hostCtx.locale || typeof hostCtx.locale.bind !== 'function') return fallback
        const translate = hostCtx.locale.bind(NS)
        return key => {
          try {
            const value = translate(key)
            return value === undefined || value === null || value === key ? fallback(key) : value
          } catch {
            return fallback(key)
          }
        }
      } catch {
        return fallback
      }
    }

    function Panel() {
      const [state, setState] = useState(null)
      const [failed, setFailed] = useState(false)
      const [open, setOpen] = useState(false)
      // 翻译函数每次渲染现取：locale 切换时靠一个计数器触发重渲染，
      // 避免把函数塞进 state（setState 的函数参数会被当成更新器）。
      const [, setLocaleVersion] = useState(0)
      const t = translator()

      const load = useCallback(async () => {
        try {
          const res = await fetch(STATE_URL, { cache: 'no-store', credentials: 'same-origin' })
          if (!res.ok) throw new Error(String(res.status))
          setState(await res.json())
          setFailed(false)
        } catch {
          setFailed(true)
        }
      }, [])

      useEffect(() => {
        let alive = true
        void load()
        const timer = setInterval(() => {
          if (alive) void load()
        }, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [load])

      useEffect(() => {
        if (!hostCtx || !hostCtx.locale || typeof hostCtx.locale.subscribe !== 'function') return
        return hostCtx.locale.subscribe(() => setLocaleVersion(v => v + 1))
      }, [])

      if (failed) return null
      if (!state) return null

      if (!state.ok) {
        return h(
          'div',
          { style: { display: 'flex', justifyContent: 'flex-end' } },
          h(
            'button',
            { type: 'button', style: S.pill, title: t('unavailable'), onClick: () => void load() },
            h('span', { style: { ...S.dot, background: 'var(--dsw-alias-state-warn-primary)' } }),
            h('span', null, t('pill')),
            h('span', { style: S.warn }, t('unavailable')),
          ),
        )
      }

      // 余额总额的三种状态，都要如实区分：
      //   有实读值  → 显示数字
      //   补了旧值  → 显示数字 + 「(旧读数)」标记
      //   完全未知  → 显示「未知 (N)」，绝不显示 0
      //
      // 关键防线：`balance === 0` 单独处理。0 是「余额真的是 0」和「读数缺失」
      // 撞在一起的样子，而后者会被读成「积分花光了」。所以只有在确实没有任何
      // 已知读数时才显示 0，并且标成未知。
      const staleCount = state.staleBalances ?? 0
      const missingCount = state.missingBalances ?? 0
      const hasLiveTotal = typeof state.liveTotal === 'number'
      const rawBalance = state.balance
      const balanceKnown = typeof rawBalance === 'number' && (rawBalance !== 0 || hasLiveTotal)
      const balanceText = balanceKnown
        ? String(rawBalance) + (staleCount > 0 ? ` (${staleCount}${t('stale')})` : '')
        : `${t('unknown')} (${missingCount})`
      const balanceStyle = balanceKnown ? (staleCount > 0 ? S.warn : undefined) : S.warn

      const pill = h(
        'button',
        { type: 'button', style: S.pill, title: t('hint'), onClick: () => setOpen(v => !v) },
        h('span', { style: S.dot }),
        h('span', null, t('pill')),
        h('span', { style: S.dim }, balanceText),
        // 分隔符：没有它，「XD Pool 积分 12486 今日已用 403」会连成一串读不出来。
        h('span', { style: S.sep }, '·'),
        h('span', { style: S.dim }, t('today') + ' ' + (state.today?.consumed ?? 0)),
        // 7 天内有积分要过期时，胶囊上直接亮一个警示角标：
        // 折叠状态下也能看见，这是这个功能存在的意义。
        state.expiry?.nextExpiry && state.expiry.nextExpiry.daysLeft <= 7
          ? h(
              'span',
              { style: { ...S.err, fontSize: 11 } },
              '⏳ ' + state.expiry.nextExpiry.daysLeft.toFixed(1) + t('days'),
            )
          : null,
      )

      if (!open) return h('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, pill)

      const accounts = Array.isArray(state.accounts) ? state.accounts : []
      const usage = state.usage
      const granted = accounts.reduce((sum, a) => sum + (a.packageTotals?.oneOffGranted ?? 0), 0)
      const usedPct = granted > 0 ? Math.min(100, ((state.all?.consumed ?? 0) / granted) * 100) : null

      return h(
        'div',
        { style: { display: 'flex', justifyContent: 'flex-end' } },
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: { ...S.row, marginBottom: 4 } },
            h('strong', null, 'XD Pool ' + t('balance')),
            h(
              'span',
              { style: { display: 'inline-flex', gap: 6 } },
              h('button', { type: 'button', style: { ...S.pill, padding: '0 6px' }, onClick: () => void load() }, t('refresh')),
              h('button', { type: 'button', style: { ...S.pill, padding: '0 6px' }, onClick: () => setOpen(false) }, t('collapse')),
            ),
          ),
          h('div', { style: S.row }, h('span', { style: S.dim }, t('balance')), h('span', { style: balanceStyle }, balanceText)),
          !balanceKnown
            ? h(
                'div',
                { style: { ...S.warn, fontSize: 10 } },
                `${t('unknown')} · ${state.reason ?? ''}`,
              )            : staleCount > 0
              ? h(
                  'div',
                  { style: { ...S.warn, fontSize: 10 } },
                  `${t('staleHint')} ${state.reason ?? ''}`,
                )
              : null,
          h('div', { style: S.row }, h('span', { style: S.dim }, t('today')), h('span', null, state.today?.consumed ?? 0)),
          h('div', { style: S.row }, h('span', { style: S.dim }, t('month')), h('span', null, state.month?.consumed ?? 0)),
          h('div', { style: S.row }, h('span', { style: S.dim }, t('all')), h('span', null, state.all?.consumed ?? 0)),
          usedPct !== null
            ? h(
                'div',
                { style: { marginTop: 4 } },
                h('div', { style: S.row }, h('span', { style: S.dim }, t('all') + ' / ' + granted), h('span', null, usedPct.toFixed(1) + '%')),
                h('div', { style: S.bar }, h('span', { style: { ...S.barFill, width: usedPct + '%' } })),
              )
            : null,
          expiryBlock(state.expiry, t),
          usage
            ? h(
                'div',
                { style: { marginTop: 6 } },
                h('div', { style: S.dim }, t('tokens')),
                h(
                  'div',
                  { style: S.row },
                  h('span', { style: S.dim }, `${t('input')} / ${t('output')} / ${t('reasoning')}`),
                  h('span', null, `${tok(usage.tokens?.input)} / ${tok(usage.tokens?.output)} / ${tok(usage.tokens?.reasoning)}`),
                ),
                h(
                  'div',
                  { style: S.row },
                  h('span', { style: S.dim }, `${t('cached')} · ${t('calls')}`),
                  h('span', null, `${tok(usage.tokens?.cached)} · ${usage.calls ?? 0}`),
                ),
              )
            : null,
          accounts.length
            ? h(
                'div',
                { style: S.acct },
                h('div', { style: S.dim }, t('accounts')),
                accounts.map(account =>
                  h(
                    'div',
                    { key: account.id, style: S.row },
                    h('span', { style: { ...S.dim, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' } }, account.label),
                    h(
                      'span',
                      { style: account.creditsError ? S.err : undefined },
                      // 余额查不到时用最后一次已知读数，并明确标成旧读数。
                      `${account.effectiveBalance ?? '—'}${account.staleBalance ? ` (${t('stale')})` : ''} · ${t('today')} ${account.measuredToday ?? 0} · ${t('all')} ${account.measuredConsumed ?? 0}`,
                    ),
                  ),
                ),
                // 每个账号各自的「最近一次到期」：全局那张表回答「什么时候过期」，
                // 这一行回答「我哪个号有积分要过期」。
                accounts.some(account => account.expiry?.nextExpiry)
                  ? accounts.map(account => {
                      const next = account.expiry?.nextExpiry
                      if (!next) return null
                      const urgent = next.daysLeft <= 7
                      return h(
                        'div',
                        { key: account.id + ':expiry', style: { ...S.row, fontSize: 10 } },
                        h(
                          'span',
                          { style: { ...S.dim, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' } },
                          account.label,
                        ),
                        h(
                          'span',
                          { style: urgent ? S.err : S.dim },
                          `${t('expiry')} ${next.daysLeft.toFixed(1)}${t('days')} · ${next.credits}`,
                        ),
                      )
                    })
                  : null,
              )
            : null,
          h('div', { style: { ...S.dim, marginTop: 6 } }, t('hint')),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        hostCtx = ctx
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'xdpool-billing: dictionaries')
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'xdpool-billing', order: 7 }, Panel),
        )
      },
    }
  },
})
