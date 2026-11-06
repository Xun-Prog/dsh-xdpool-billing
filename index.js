/**
 * dsh-xdpool-billing — XD Pool 积分计费面板（宿主半侧）。
 *
 * 数据来源全部是 XD Pool 插件自己已经挂在同一台 Web 服务器上的只读路由，
 * 本插件不重复实现上游协议，也不再去解密 WorkBuddy 的凭据：
 *
 *   GET /plugins/dsh-xdpool/status?region=cn|global  → 各账号剩余积分与积分包明细
 *   GET /plugins/dsh-xdpool/usage                      → token 用量账本（内存窗口）
 *
 * 「已使用多少」有两个口径，本插件都给出，并且分清是「实测」还是「按包推算」：
 *
 * 1. 实测消耗（measured）：本插件每次轮询都记一次余额快照，余额下降的部分
 *    就是这段时间真实花掉的积分。扣多少算多少，不受月度积分包重置影响。
 * 2. 按包推算（fromPackages）：每个一次性积分包都带 remain/size，size-remain
 *    就是这个包已经被用掉的量。月度包会按周期重置，所以它的 consumed 只代表
 *    「本周期已用」，不并入累计。
 *
 * 落盘：$DSH_HOME/storages/xdpool-billing/ledger.json
 * 面板：GET /__xdpool-billing/state.json
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'xdpool-billing'
/** 面板数据端点需要 Web 服务器；Agent 查询工具需要 tools 服务。 */
export const inject = ['webServer', 'tools']

const XDPOOL_STATUS_ROUTE = '/plugins/dsh-xdpool/status'
const XDPOOL_USAGE_ROUTE = '/plugins/dsh-xdpool/usage'
const STATE_ROUTE = '/__xdpool-billing/state.json'

/** 轮询间隔：积分变化不快，但「今天用了多少」要跟得上。 */
const POLL_MS = 60_000
/** 余额请求超时。 */
const FETCH_TIMEOUT_MS = 20_000
/** 账本里保留多少天的日聚合。 */
const KEEP_DAYS = 90
/** 一天多少毫秒。 */
const DAY_MS = 86_400_000
/**
 * 「快过期」的分档（天）。
 *
 * 上游的 `credits.expiringSoon` 用的是一个 **3 天**窗口（`SOON_MS = 2592e5` ms），
 * 所以「3.9 天后到期」的一大批积分在上游那里会显示成 0。用户问的是「有多少快过期」，
 * 3 天太窄，所以这里自己分档算。环境变量 `XDPOOL_BILLING_EXPIRY_WINDOWS`
 * 可覆盖（逗号分隔的天数，升序）。
 */
const DEFAULT_EXPIRY_WINDOWS = [3, 7, 30]

function expiryWindows() {
  const raw = process.env.XDPOOL_BILLING_EXPIRY_WINDOWS
  if (!raw) return DEFAULT_EXPIRY_WINDOWS
  const parsed = raw
    .split(',')
    .map(part => Number(part.trim()))
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)
  return parsed.length > 0 ? parsed : DEFAULT_EXPIRY_WINDOWS
}

/** 本地时区的日期键（到期日按本地日历天分组，不是 UTC）。 */
function localDateKey(ms) {
  const d = new Date(ms)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function dshHome() {
  const home = process.env.DSH_HOME
  return home && home.length > 0 ? home : path.join(os.homedir(), '.dsh')
}

const LEDGER_PATH = path.join(dshHome(), 'storages', 'xdpool-billing', 'ledger.json')

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8')
  fs.renameSync(tmp, file)
}

function localDayKey(ms = Date.now()) {
  const d = new Date(ms)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function emptyLedger() {
  return {
    version: 1,
    createdAt: Date.now(),
    days: {},
    accounts: {},
    lastSnapshot: null,
  }
}

/** 一个账号在一次快照里的样子。 */
function normalizeAccount(row) {
  const credits = row.credits ?? null
  const packages = Array.isArray(credits?.packages) ? credits.packages : []
  return {
    id: String(row.id ?? ''),
    label: String(row.nickname ?? row.label ?? row.id ?? 'unknown'),
    domain: row.domain ?? '',
    cooling: row.cooling === true,
    creditReserve: num(row.creditReserve),
    reserved: row.reserved === true,
    preferred: row.preferred === true,
    disabled: row.disabled === true,
    balance: credits ? num(credits.total) : null,
    expiringSoon: credits ? num(credits.expiringSoon) : 0,
    nearestExpiryMs: credits?.nearestExpiryMs ?? null,
    creditsError: typeof row.creditsError === 'string' ? row.creditsError : null,
    automationToday: row.automationToday ?? null,
    packages: packages.map(pkg => ({
      name: String(pkg.packageName ?? 'package'),
      remain: num(pkg.remain),
      size: num(pkg.size),
      monthly: pkg.monthly === true,
      refreshAtMs: pkg.refreshAtMs ?? null,
      expiresAtMs: pkg.expiresAtMs ?? null,
    })),
  }
}

/**
 * 一个积分包的已用量。
 *
 * 一次性包（monthly=false）是「用完即逝」的钱：size-remain 就是已经花掉的。
 * 月度包按周期重置，所以它的 used 只代表本周期已用，累计消耗由快照差值负责。
 */
function packageUsage(pkg) {
  const used = Math.max(0, pkg.size - pkg.remain)
  return { used, oneOffUsed: pkg.monthly ? 0 : used, monthlyUsed: pkg.monthly ? used : 0 }
}

function accountPackageTotals(account) {
  let oneOffUsed = 0
  let monthlyUsed = 0
  let oneOffGranted = 0
  let monthlyGranted = 0
  for (const pkg of account.packages) {
    const { used, oneOffUsed: o, monthlyUsed: m } = packageUsage(pkg)
    void used
    oneOffUsed += o
    monthlyUsed += m
    if (pkg.monthly) monthlyGranted += pkg.size
    else oneOffGranted += pkg.size
  }
  return { oneOffUsed, monthlyUsed, oneOffGranted, monthlyGranted }
}

/**
 * 过期分析：一个账号的积分有多少快到期、还有多少天。
 *
 * 只看**一次性包**（monthly=false）。月度包按周期刷新，不存在「过期作废」——
 * 把它算进「快过期」会吓用户以为要丢钱。
 *
 * 输出：
 *   buckets   —— 按窗口（3/7/30 天）累计的待过期积分。窗口是**累计**的：
 *                「7 天内」包含「3 天内」，所以这些数不能相加。
 *   nextExpiry—— 最近一个到期包的到期时刻与剩余天数。
 *   timeline  —— 按到期日聚合的日历（哪一天会过期多少），用于「什么时候用掉」。
 *   expiringTotal —— 全部有到期日的一次性包的剩余积分合计。
 */
export function analyzeExpiry(account, now = Date.now(), windows = expiryWindows()) {
  const expiring = account.packages.filter(pkg => {
    if (pkg.monthly) return false
    if (typeof pkg.expiresAtMs !== 'number') return false
    if (!Number.isFinite(pkg.expiresAtMs)) return false
    return pkg.expiresAtMs > now
  })
  const sorted = [...expiring].sort((a, b) => a.expiresAtMs - b.expiresAtMs)
  const buckets = windows.map(days => ({
    days,
    credits: 0,
    packages: 0,
  }))
  for (const pkg of sorted) {
    const remaining = pkg.expiresAtMs - now
    for (const bucket of buckets) {
      if (remaining <= bucket.days * DAY_MS) {
        bucket.credits += pkg.remain
        bucket.packages += 1
      }
    }
  }
  const timelineMap = new Map()
  for (const pkg of sorted) {
    const key = localDateKey(pkg.expiresAtMs)
    const entry = timelineMap.get(key) ?? { date: key, credits: 0, packages: 0, at: pkg.expiresAtMs }
    entry.credits += pkg.remain
    entry.packages += 1
    // 同一日的包里最早的到期时刻作为这一日的时刻。
    if (pkg.expiresAtMs < entry.at) entry.at = pkg.expiresAtMs
    timelineMap.set(key, entry)
  }
  const timeline = [...timelineMap.values()].sort((a, b) => (a.at < b.at ? -1 : 1))
  const next = sorted[0]
  return {
    buckets,
    timeline,
    expiringTotal: sorted.reduce((sum, pkg) => sum + pkg.remain, 0),
    expiringPackages: sorted.length,
    nextExpiry: next
      ? {
          at: next.expiresAtMs,
          date: localDateKey(next.expiresAtMs),
          daysLeft: (next.expiresAtMs - now) / DAY_MS,
          credits: next.remain,
          name: next.name,
        }
      : null,
  }
}

/**
 * 把新快照并进账本。
 *
 * 契约：返回**账本本身**（调用方拿它继续记账）；本次并入的结果放在
 * ledger.lastMerge 里，便于单测断言。
 */
export function mergeSnapshot(ledger, snapshot) {
  const merge = { at: snapshot.at, added: 0, accounts: 0, day: localDayKey(snapshot.at) }
  if (!snapshot || !Number.isFinite(snapshot.at)) return ledger
  const previous = ledger.lastSnapshot
  const day = (ledger.days[merge.day] ??= { consumed: 0, grants: 0, polls: 0, at: merge.day })
  day.polls += 1

  for (const account of snapshot.accounts) {
    if (!account.id) continue
    const record = (ledger.accounts[account.id] ??= {
      id: account.id,
      label: account.label,
      firstSeenAt: snapshot.at,
      lastSeenAt: snapshot.at,
      firstBalance: null,
      lastBalance: null,
      consumed: 0,
      granted: 0,
      daily: {},
    })
    record.label = account.label || record.label
    record.lastSeenAt = snapshot.at
    const nowBalance = typeof account.balance === 'number' ? account.balance : null
    if (record.firstBalance === null && nowBalance !== null) record.firstBalance = nowBalance
    // 实测消耗：与「上一次已知的余额」比较，而不是与上一次快照比较。
    // 快照比较在一次查询失败后就断了：失败那轮余额记为 null，下一轮余额回来时
    // 前值是 null，差额就被吞掉。这里用 lastBalance（最后一次已知值）兜住，
    // 中间断了几轮也不丢消耗。
    const beforeBalance = record.lastBalance
    if (nowBalance !== null) {
      if (beforeBalance !== null) {
        const drop = beforeBalance - nowBalance
        if (drop > 0) {
          record.consumed += drop
          day.consumed += drop
          const drec = (record.daily[merge.day] ??= { consumed: 0 })
          drec.consumed += drop
          merge.added += drop
        }
      }
      record.lastBalance = nowBalance
    }
    const totals = accountPackageTotals(account)
    if (totals.oneOffGranted > 0) {
      record.granted = Math.max(record.granted, totals.oneOffGranted)
      day.grants = Math.max(day.grants, 0)
    }
    merge.accounts += 1
  }
  ledger.lastSnapshot = {
    at: snapshot.at,
    total: snapshot.total,
    accounts: snapshot.accounts.map(a => ({ id: a.id, balance: a.balance })),
  }
  // 只保留最近 KEEP_DAYS 天。
  const keys = Object.keys(ledger.days).sort()
  while (keys.length > KEEP_DAYS) {
    const oldest = keys.shift()
    delete ledger.days[oldest]
  }
  ledger.lastMerge = merge
  return ledger
}

/**
 * 从账本算出一份面板状态。
 *
 * `now` 必须可注入：过期分档是**相对当前时刻**算的，写死 `Date.now()` 会让
 * 「3 天后到期」这类断言随真实时间漂移，测试过几天就红 —— 而且红得像插件坏了。
 * 生产调用方不传，默认值就是此刻。
 */
export function buildState(ledger, snapshot, usage, availability, now = Date.now()) {
  const today = localDayKey(now)
  const day = ledger.days[today] ?? { consumed: 0, grants: 0, polls: 0 }
  let monthConsumed = 0
  const monthPrefix = today.slice(0, 7)
  for (const [date, value] of Object.entries(ledger.days)) {
    if (!date.startsWith(monthPrefix)) continue
    monthConsumed += num(value.consumed)
  }
  let totalConsumed = 0
  for (const value of Object.values(ledger.days)) totalConsumed += num(value.consumed)

  const accounts = (snapshot?.accounts ?? []).map(account => {
    const totals = accountPackageTotals(account)
    const record = ledger.accounts[account.id]
    // 余额查不到时退回「上一次已知的余额」，而不是把总额打成 null 或 0。
    // 账本里存着每个账号的 lastBalance，所以这个兜底是真实数据，
    // 只是不是此刻的读数 —— stale 标记会如实说明这一点。
    const liveBalance = typeof account.balance === 'number' ? account.balance : null
    const lastKnown = record && typeof record.lastBalance === 'number' ? record.lastBalance : null
    const effectiveBalance = liveBalance ?? lastKnown
    return {
      ...account,
      balance: liveBalance,
      effectiveBalance,
      staleBalance: liveBalance === null && lastKnown !== null,
      packageTotals: totals,
      expiry: analyzeExpiry(account, now),
      measuredConsumed: record ? num(record.consumed) : 0,
      measuredToday: record ? num(record.daily?.[today]?.consumed) : 0,
    }
  })

  // 跨账号的过期汇总：同一个到期日的积分合并成一行，
  // 这样「哪一天会过期多少」是全局的一张表，而不是每个账号各说各话。
  const windows = expiryWindows()
  const expiryBuckets = windows.map(days => ({ days, credits: 0, packages: 0 }))
  const expiryTimelineMap = new Map()
  let expiryTotal = 0
  let expiryPackages = 0
  let nearestExpiry = null
  for (const account of accounts) {
    for (const bucket of account.expiry.buckets) {
      const target = expiryBuckets.find(item => item.days === bucket.days)
      if (!target) continue
      target.credits += bucket.credits
      target.packages += bucket.packages
    }
    expiryTotal += account.expiry.expiringTotal
    expiryPackages += account.expiry.expiringPackages
    for (const entry of account.expiry.timeline) {
      const merged = expiryTimelineMap.get(entry.date) ?? { date: entry.date, credits: 0, packages: 0, at: entry.at }
      merged.credits += entry.credits
      merged.packages += entry.packages
      if (entry.at < merged.at) merged.at = entry.at
      expiryTimelineMap.set(entry.date, merged)
    }
    const next = account.expiry.nextExpiry
    if (next && (nearestExpiry === null || next.at < nearestExpiry.at)) {
      nearestExpiry = { ...next, account: account.label }
    }
  }
  const expiryTimeline = [...expiryTimelineMap.values()].sort((a, b) => (a.at < b.at ? -1 : 1))

  const usageTokens = (usage?.rows ?? []).reduce(
    (acc, row) => {
      acc.input += num(row.inputTokens)
      acc.output += num(row.outputTokens)
      acc.reasoning += num(row.reasoningTokens)
      acc.cached += num(row.cachedTokens)
      return acc
    },
    { input: 0, output: 0, reasoning: 0, cached: 0 },
  )
  usageTokens.total = usageTokens.input + usageTokens.output + usageTokens.reasoning

  // 总额：优先用这一轮的实读值；读不到的账号用它的上一次已知余额补上。
  // 于是总额永远是一个**有依据的数字**，而不是 null（前端会当成 0）或 0。
  //
  // 三个数各有明确含义，不能混：
  //   liveTotal   —— 这一轮真的读到的余额之和
  //   balance     —— liveTotal + 旧读数兜底，是「当前可知的总余额」
  //   staleBalances —— 有多少账号用的是旧读数
  let effectiveTotal = 0
  let liveTotal = 0
  let liveCount = 0
  let staleCount = 0
  for (const account of accounts) {
    if (typeof account.effectiveBalance === 'number') effectiveTotal += account.effectiveBalance
    if (typeof account.balance === 'number') {
      liveTotal += account.balance
      liveCount += 1
    } else if (account.staleBalance) staleCount += 1
  }
  const hasKnownBalance = accounts.some(account => typeof account.effectiveBalance === 'number')

  return {
    ok: availability?.ok === true,
    reason: availability?.reason ?? null,
    generatedAt: now,
    balance: hasKnownBalance ? effectiveTotal : null,
    liveTotal,
    staleBalances: staleCount,
    missingBalances: snapshot?.missingBalances ?? 0,
    accountCount: accounts.length,
    today: { consumed: num(day.consumed), polls: num(day.polls) },
    month: { consumed: monthConsumed },
    all: { consumed: totalConsumed },
    accounts,
    expiry: {
      buckets: expiryBuckets,
      timeline: expiryTimeline,
      expiringTotal: expiryTotal,
      expiringPackages: expiryPackages,
      nextExpiry: nearestExpiry,
    },
    usage: usage
      ? {
          samples: num(usage.samples),
          calls: num(usage.calls),
          turns: num(usage.turns),
          failedTurns: num(usage.failedTurns),
          recoveredTurns: num(usage.recoveredTurns),
          usageReported: usage.usageReported === true,
          tokens: usageTokens,
          rows: (usage.rows ?? []).slice(0, 40),
          accounts: (usage.accounts ?? []).slice(0, 20),
          days: (usage.days ?? []).slice(0, 14),
        }
      : null,
    ledgerPath: LEDGER_PATH,
  }
}

/**
 * 拉一次 XD Pool 的状态与用量。
 *
 * XD Pool 未安装/未启用时路由不存在（404），此时返回 ok:false 而不是抛错：
 * 面板要显示「数据源不可用」，不是一个空白卡片。
 */
export async function fetchPoolState(origin, fetchImpl = fetch) {
  if (!origin) return { ok: false, reason: 'web-server-not-ready', snapshot: null, usage: null }
  const get = async path => {
    try {
      const res = await fetchImpl(`${origin}${path}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) return { ok: false, status: res.status }
      return { ok: true, body: await res.json() }
    } catch (error) {
      return { ok: false, status: 0, error: String(error) }
    }
  }

  const usageRes = await get(XDPOOL_USAGE_ROUTE)
  const usage = usageRes.ok ? usageRes.body : null

  const accounts = []
  let anyStatus = false
  let lastStatus = null
  for (const region of ['cn', 'global']) {
    const res = await get(`${XDPOOL_STATUS_ROUTE}?region=${region}`)
    if (!res.ok) continue
    anyStatus = true
    lastStatus = res.body
    for (const row of Array.isArray(res.body?.accounts) ? res.body.accounts : []) {
      accounts.push(normalizeAccount(row))
    }
  }
  if (!anyStatus) {
    const status = usageRes.ok ? 404 : usageRes.status
    return {
      ok: false,
      reason: usageRes.ok ? 'xdpool-status-unavailable' : `xdpool-not-available(${status})`,
      snapshot: null,
      usage,
    }
  }
  // 合计：只有当每个账号都拿到了余额时才给出总额。
  // 部分账号查询失败时把总额置为 null 并记下缺口——把失败账号当成 0 会被读成
  // 「余额掉了几千」，那是编造的数字，不是事实。
  let total = 0
  let missing = 0
  for (const account of accounts) {
    if (typeof account.balance === 'number') total += account.balance
    else missing += 1
  }
  return {
    ok: true,
    reason: missing > 0 ? `${missing} account(s) balance unavailable` : null,
    snapshot: {
      at: Date.now(),
      total: missing > 0 ? null : total,
      partialTotal: total,
      missingBalances: missing,
      accounts,
      regionStatus: lastStatus,
    },
    usage,
  }
}

export function apply(ctx) {
  const ledger = readJson(LEDGER_PATH) ?? emptyLedger()
  if (!ledger.days) ledger.days = {}
  if (!ledger.accounts) ledger.accounts = {}

  let latest = { ok: false, reason: 'not-polled-yet', snapshot: null, usage: null }
  let polling = null
  let timer = null
  let disposed = false

  const origin = () => {
    try {
      return ctx.webServer.getOrigin()
    } catch {
      return undefined
    }
  }

  const persist = () => {
    try {
      writeJsonAtomic(LEDGER_PATH, ledger)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-xdpool-billing: 账本写入失败: ${String(error)}`)
    }
  }

  /**
   * 拉一次上游。
   *
   * 并发调用会**共用同一个 in-flight promise**：早先的写法是「正在轮询就直接
   * return」，于是工具在插件刚装上、第一轮 poll 还在飞的时候拿到的是空快照，
   * 回答成「not-polled-yet」。等同一个 promise 才对。
   */
  const poll = async () => {
    if (disposed) return
    if (polling) return polling
    polling = (async () => {
      try {
        const result = await fetchPoolState(origin())
        latest = result
        if (result.ok && result.snapshot) {
          mergeSnapshot(ledger, result.snapshot)
          persist()
        }
      } catch (error) {
        latest = { ok: false, reason: String(error), snapshot: null, usage: latest.usage }
      } finally {
        polling = null
      }
    })()
    return polling
  }

  ctx.effect(() => {
    void poll()
    const handle = setInterval(() => {
      void poll()
    }, POLL_MS)
    handle.unref?.()
    timer = handle
    return () => {
      disposed = true
      if (timer) clearInterval(timer)
      timer = null
    }
  }, 'xdpool-billing: poll')

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: STATE_ROUTE,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405).end()
          return
        }
        const url = new URL(req.url ?? STATE_ROUTE, 'http://127.0.0.1')
        if (url.searchParams.get('refresh') === '1') await poll()
        const state = buildState(ledger, latest.snapshot, latest.usage, {
          ok: latest.ok === true,
          reason: latest.reason ?? null,
        })
        const body = Buffer.from(JSON.stringify(state), 'utf8')
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': body.length,
        })
        res.end(req.method === 'HEAD' ? undefined : body)
      },
    })
    return () => dispose?.()
  }, 'xdpool-billing: http route')

  // 给 Agent 用的查询工具：同一份数据，不另开一条上游链路。
  ctx.tools.register({
    name: 'xdpool_billing',
    description:
      '查询 XD Pool（WorkBuddy）的积分余额、已用量与过期预警。返回：当前剩余积分总额、每个账号的余额与积分包明细、实测已消耗积分（今日/本月/累计，按余额快照差值统计）、即将过期积分（按 3/7/30 天分档，含最近到期日与剩余天数）、以及 token 用量汇总。' +
      '当用户问「我还剩多少积分 / 用了多少 / XD Pool 余额 / 有多少积分快过期」时使用本工具。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        refresh: {
          type: 'boolean',
          description: '为 true 时先立即拉一次上游再回答（默认 false，用最近一次轮询结果）。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          reason: { type: 'string' },
          missingBalances: { type: 'number' },
          staleBalances: { type: 'number' },
          liveTotal: { type: 'number' },
          balance: { type: 'number' },
          todayConsumed: { type: 'number' },
          monthConsumed: { type: 'number' },
          allConsumed: { type: 'number' },
          accounts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                balance: { type: 'number' },
                effectiveBalance: { type: 'number' },
                staleBalance: { type: 'boolean' },
                measuredConsumed: { type: 'number' },
                packages: { type: 'number' },
                error: { type: 'string' },
              },
              required: ['id', 'label', 'measuredConsumed', 'packages'],
            },
          },
          tokens: {
            type: 'object',
            additionalProperties: false,
            properties: {
              input: { type: 'number' },
              output: { type: 'number' },
              reasoning: { type: 'number' },
              cached: { type: 'number' },
              calls: { type: 'number' },
            },
          },
          expiry: {
            type: 'object',
            additionalProperties: false,
            properties: {
              expiringTotal: { type: 'number' },
              expiringPackages: { type: 'number' },
              buckets: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    days: { type: 'number' },
                    credits: { type: 'number' },
                    packages: { type: 'number' },
                  },
                  required: ['days', 'credits'],
                },
              },
              nextExpiry: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  at: { type: 'number' },
                  date: { type: 'string' },
                  daysLeft: { type: 'number' },
                  credits: { type: 'number' },
                  name: { type: 'string' },
                  account: { type: 'string' },
                },
                required: ['at', 'daysLeft', 'credits'],
              },
              timeline: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    date: { type: 'string' },
                    credits: { type: 'number' },
                    packages: { type: 'number' },
                    at: { type: 'number' },
                  },
                  required: ['date', 'credits'],
                },
              },
            },
          },
        },
        required: ['ok', 'todayConsumed', 'monthConsumed', 'allConsumed', 'accounts'],
      },
      render: (_args, value) => {
        if (!value.ok) {
          return [{ type: 'text', text: `XD Pool 余额不可用：${value.reason ?? 'unknown'}` }]
        }
        const lines = [
          `剩余积分：${value.balance ?? `未知（${value.missingBalances ?? 0} 个账号查询失败）`}` +
            (value.staleBalances > 0 ? `（其中 ${value.staleBalances} 个是上一次读数，本轮实读 ${value.liveTotal ?? 0}）` : ''),
          `已消耗：今日 ${value.todayConsumed} · 本月 ${value.monthConsumed} · 累计 ${value.allConsumed}`,
        ]
        if (value.expiry) {
          const buckets = (value.expiry.buckets ?? [])
            .map(bucket => `${bucket.days}天内 ${bucket.credits}`)
            .join(' · ')
          lines.push(
            `即将过期：${value.expiry.expiringTotal ?? 0}（一次性积分包 ${value.expiry.expiringPackages ?? 0} 个）${buckets ? ` — ${buckets}` : ''}`,
          )
          if (value.expiry.nextExpiry) {
            const next = value.expiry.nextExpiry
            lines.push(
              `最近到期：${next.date ?? new Date(next.at).toISOString().slice(0, 10)}（还有 ${next.daysLeft.toFixed(1)} 天）· ${next.credits} 积分 · ${next.account ?? ''} ${next.name ?? ''}`,
            )
          }
          for (const entry of (value.expiry.timeline ?? []).slice(0, 6)) {
            lines.push(`  ${entry.date} 到期 ${entry.credits}（${entry.packages} 包）`)
          }
        }
        if (value.tokens) {
          lines.push(
            `Token 用量：输入 ${value.tokens.input} · 输出 ${value.tokens.output} · 思考 ${value.tokens.reasoning} · 缓存 ${value.tokens.cached} · 调用 ${value.tokens.calls}`,
          )
        }
        for (const account of value.accounts) {
          lines.push(
            `- ${account.label}: 余额 ${account.effectiveBalance ?? account.balance ?? '—'}` +
              (account.staleBalance ? '（旧读数）' : '') +
              ` · 实测已用 ${account.measuredConsumed} · 积分包 ${account.packages}` +
              (account.error ? ` · 错误 ${account.error}` : ''),
          )
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      // 还没轮询过就立刻拉一次：插件刚装上时第一轮 poll 可能还没回来，
      // 此时工具不应该回答「not-polled-yet」。
      if (args?.refresh === true || latest.snapshot === null) await poll()
      const state = buildState(ledger, latest.snapshot, latest.usage, {
        ok: latest.ok === true,
        reason: latest.reason ?? null,
      })
      const accounts = state.accounts.map(account => ({
        id: account.id,
        label: account.label,
        measuredConsumed: account.measuredConsumed,
        packages: account.packages.length,
        ...(typeof account.balance === 'number' ? { balance: account.balance } : {}),
        ...(typeof account.effectiveBalance === 'number' ? { effectiveBalance: account.effectiveBalance } : {}),
        ...(account.staleBalance ? { staleBalance: true } : {}),
        ...(account.creditsError ? { error: account.creditsError } : {}),
      }))
      return {
        ok: state.ok,
        ...(state.reason ? { reason: state.reason } : {}),
        ...(typeof state.balance === 'number' ? { balance: state.balance } : {}),
        ...(typeof state.liveTotal === 'number' ? { liveTotal: state.liveTotal } : {}),
        missingBalances: state.missingBalances,
        staleBalances: state.staleBalances,
        todayConsumed: state.today.consumed,
        monthConsumed: state.month.consumed,
        allConsumed: state.all.consumed,
        accounts,
        expiry: {
          expiringTotal: state.expiry.expiringTotal,
          expiringPackages: state.expiry.expiringPackages,
          buckets: state.expiry.buckets,
          ...(state.expiry.nextExpiry ? { nextExpiry: state.expiry.nextExpiry } : {}),
          timeline: state.expiry.timeline.slice(0, 12),
        },
        ...(state.usage
          ? {
              tokens: {
                input: state.usage.tokens.input,
                output: state.usage.tokens.output,
                reasoning: state.usage.tokens.reasoning,
                cached: state.usage.tokens.cached,
                calls: state.usage.calls,
              },
            }
          : {}),
      }
    },
  })

  ctx.logger?.info?.(`dsh-xdpool-billing: 已加载，账本 ${LEDGER_PATH}`)
}

/** 便于本地单测：导出纯函数。 */
export const __internals = {
  LEDGER_PATH,
  STATE_ROUTE,
  localDayKey,
  localDateKey,
  DAY_MS,
  DEFAULT_EXPIRY_WINDOWS,
  expiryWindows,
  emptyLedger,
  normalizeAccount,
  packageUsage,
  accountPackageTotals,
  analyzeExpiry,
  mergeSnapshot,
  buildState,
  fetchPoolState,
}
