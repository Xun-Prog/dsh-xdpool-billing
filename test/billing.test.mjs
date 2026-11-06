import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeSnapshot, buildState, fetchPoolState, analyzeExpiry, __internals } from '../index.js'

const { emptyLedger, accountPackageTotals, packageUsage, DAY_MS } = __internals

function account(overrides = {}) {
  return {
    id: 'a1',
    label: '账号一',
    domain: 'www.workbuddy.cn',
    cooling: false,
    creditReserve: 0,
    reserved: false,
    preferred: false,
    disabled: false,
    balance: 1000,
    expiringSoon: 0,
    nearestExpiryMs: null,
    creditsError: null,
    automationToday: null,
    packages: [{ name: '礼包', remain: 400, size: 1000, monthly: false, refreshAtMs: null, expiresAtMs: null }],
    ...overrides,
  }
}

test('packageUsage: 一次性包算已用，月度包只算本周期', () => {
  assert.deepEqual(packageUsage({ size: 1000, remain: 400, monthly: false }), {
    used: 600,
    oneOffUsed: 600,
    monthlyUsed: 0,
  })
  assert.deepEqual(packageUsage({ size: 100, remain: 20, monthly: true }), {
    used: 80,
    oneOffUsed: 0,
    monthlyUsed: 80,
  })
})

test('accountPackageTotals 分开一次性与月度', () => {
  const totals = accountPackageTotals(
    account({
      packages: [
        { size: 1000, remain: 400, monthly: false },
        { size: 100, remain: 20, monthly: true },
      ],
    }),
  )
  assert.equal(totals.oneOffUsed, 600)
  assert.equal(totals.monthlyUsed, 80)
  assert.equal(totals.oneOffGranted, 1000)
  assert.equal(totals.monthlyGranted, 100)
})

test('mergeSnapshot 返回账本本身（契约）', () => {
  const ledger = emptyLedger()
  const returned = mergeSnapshot(ledger, { at: Date.now(), accounts: [account()] })
  assert.equal(returned, ledger)
})

test('mergeSnapshot: 余额下降计为消耗，余额上升不计', () => {
  const ledger = emptyLedger()
  mergeSnapshot(ledger, { at: 1000, accounts: [account({ balance: 1000 })] })
  const second = mergeSnapshot(ledger, { at: 2000, accounts: [account({ balance: 700 })] })
  assert.equal(second.accounts.a1.consumed, 300)
  assert.equal(second.days[Object.keys(second.days)[0]].consumed, 300)
  // 签到领积分导致余额上升：不算消耗。
  mergeSnapshot(ledger, { at: 3000, accounts: [account({ balance: 1200 })] })
  assert.equal(ledger.accounts.a1.consumed, 300)
})

test('mergeSnapshot: 首次见到账号只记基线，不算消耗', () => {
  const ledger = emptyLedger()
  mergeSnapshot(ledger, { at: 1000, accounts: [account({ balance: 5000 })] })
  assert.equal(ledger.accounts.a1.consumed, 0)
  assert.equal(ledger.accounts.a1.firstBalance, 5000)
})

test('buildState 汇总今日/本月/累计', () => {
  const ledger = emptyLedger()
  mergeSnapshot(ledger, { at: Date.now(), accounts: [account({ balance: 1000 })] })
  mergeSnapshot(ledger, { at: Date.now(), accounts: [account({ balance: 900 })] })
  const state = buildState(
    ledger,
    { at: Date.now(), total: 900, accounts: [account({ balance: 900 })] },
    null,
    { ok: true, reason: null },
  )
  assert.equal(state.ok, true)
  assert.equal(state.balance, 900)
  assert.equal(state.today.consumed, 100)
  assert.equal(state.month.consumed, 100)
  assert.equal(state.all.consumed, 100)
  assert.equal(state.accounts[0].measuredConsumed, 100)
})

test('buildState: 数据源不可用时 ok=false', () => {
  const state = buildState(emptyLedger(), null, null, { ok: false, reason: 'xdpool-not-available' })
  assert.equal(state.ok, false)
  assert.equal(state.reason, 'xdpool-not-available')
})

test('fetchPoolState: XD Pool 未安装时返回 ok=false 而不是抛错', async () => {
  const result = await fetchPoolState('http://127.0.0.1:1', async () => {
    throw new Error('ECONNREFUSED')
  })
  assert.equal(result.ok, false)
  assert.equal(result.snapshot, null)
})

test('mergeSnapshot: 中间一轮查询失败后，消耗不丢', () => {
  const ledger = emptyLedger()
  mergeSnapshot(ledger, { at: 1000, accounts: [account({ balance: 1000 })] })
  // 第二轮：查询失败，余额未知。
  mergeSnapshot(ledger, { at: 2000, accounts: [account({ balance: null, creditsError: 'fetch failed' })] })
  // 第三轮：余额回来了，比第一轮低 40。
  mergeSnapshot(ledger, { at: 3000, accounts: [account({ balance: 960 })] })
  assert.equal(ledger.accounts.a1.consumed, 40)
})

test('fetchPoolState: 有账号余额查不到时，总额为 null 而不是少算', async () => {
  const fetchImpl = async url => {
    if (url.includes('usage')) {
      return { ok: true, json: async () => ({ samples: 0, calls: 0, turns: 0, rows: [] }) }
    }
    const region = url.includes('global') ? 'global' : 'cn'
    return {
      ok: true,
      json: async () => ({
        accounts:
          region === 'cn'
            ? [{ id: 'cn1', label: 'cn', credits: { total: 1000, packages: [] } }]
            : [{ id: 'gl1', label: 'gl', creditsError: 'fetch failed' }],
      }),
    }
  }
  const result = await fetchPoolState('http://127.0.0.1:2593', fetchImpl)
  assert.equal(result.ok, true)
  // 两个账号都被列出来了（cn 区域一次返回了两个）。
  assert.equal(result.snapshot.accounts.length, 2)
  // 总额必须为 null：把失败账号当 0 会让用户以为余额掉了 1000。
  assert.equal(result.snapshot.total, null)
  assert.equal(result.snapshot.partialTotal, 1000)
  assert.equal(result.snapshot.missingBalances, 1)
  assert.match(result.reason, /balance unavailable/)
})

test('buildState: 从没读到过余额的账号，总额是未知而不是 0', () => {
  const ledger = emptyLedger()
  const state = buildState(
    ledger,
    { at: Date.now(), total: null, partialTotal: 1000, missingBalances: 1, accounts: [account({ balance: null })] },
    null,
    { ok: true, reason: '1 account(s) balance unavailable' },
  )
  assert.equal(state.balance, null)
  assert.equal(state.liveTotal, 0)
  assert.equal(state.missingBalances, 1)
})

test('buildState: 余额查询失败时退回上一次读数，并标成旧读数', () => {
  const ledger = emptyLedger()
  // 先建立基线：1000 分。
  mergeSnapshot(ledger, { at: 1000, accounts: [account({ balance: 1000 })] })
  // 这一轮查询失败：余额拿不到，但上一次读数还在。
  const state = buildState(
    ledger,
    { at: 2000, total: null, partialTotal: 0, missingBalances: 1, accounts: [account({ balance: null, creditsError: 'fetch failed' })] },
    null,
    { ok: true, reason: '1 account(s) balance unavailable' },
  )
  // 总额是上一次读数，不是 0，也不是 null。
  assert.equal(state.balance, 1000)
  assert.equal(state.liveTotal, 0)
  assert.equal(state.staleBalances, 1)
  assert.equal(state.accounts[0].balance, null)
  assert.equal(state.accounts[0].effectiveBalance, 1000)
  assert.equal(state.accounts[0].staleBalance, true)
})

test('buildState: 从来没读到过余额的账号不算旧读数', () => {
  const ledger = emptyLedger()
  const state = buildState(
    ledger,
    { at: 2000, total: null, partialTotal: 0, missingBalances: 1, accounts: [account({ id: 'new', balance: null, creditsError: 'fetch failed' })] },
    null,
    { ok: true, reason: '1 account(s) balance unavailable' },
  )
  assert.equal(state.accounts[0].effectiveBalance, null)
  assert.equal(state.accounts[0].staleBalance, false)
  // 没有任何一个账号有可用读数时，总额不能是 0。
  assert.equal(state.balance, null)
})

test('buildState: 全部账号都读到时总额等于实读之和，没有旧读数', () => {
  const ledger = emptyLedger()
  mergeSnapshot(ledger, { at: 1000, accounts: [account({ id: 'a1', balance: 1000 })] })
  const state = buildState(
    ledger,
    {
      at: 2000,
      total: 1300,
      partialTotal: 1300,
      missingBalances: 0,
      accounts: [
        account({ id: 'a1', balance: 1000 }),
        account({ id: 'a2', balance: 300 }),
      ],
    },
    null,
    { ok: true, reason: null },
  )
  assert.equal(state.balance, 1300)
  assert.equal(state.liveTotal, 1300)
  assert.equal(state.staleBalances, 0)
})

test('fetchPoolState: 汇总两个区域的账号与总额', async () => {
  const fetchImpl = async url => {
    if (url.includes('usage')) {
      return { ok: true, json: async () => ({ samples: 1, calls: 1, turns: 1, rows: [] }) }
    }
    const region = url.includes('global') ? 'global' : 'cn'
    return {
      ok: true,
      json: async () => ({
        accounts: [
          {
            id: region === 'cn' ? 'cn1' : 'gl1',
            label: region,
            credits: { total: region === 'cn' ? 100 : 200, packages: [] },
          },
        ],
      }),
    }
  }
  const result = await fetchPoolState('http://127.0.0.1:2593', fetchImpl)
  assert.equal(result.ok, true)
  assert.equal(result.snapshot.accounts.length, 2)
  assert.equal(result.snapshot.total, 300)
  assert.equal(result.usage.calls, 1)
})

// ---------------------------------------------------------------- 过期分析

const NOW = Date.UTC(2026, 10, 1, 0, 0, 0)

function pkg(overrides = {}) {
  return {
    name: '礼包',
    remain: 100,
    size: 100,
    monthly: false,
    refreshAtMs: null,
    expiresAtMs: NOW + 2 * DAY_MS,
    ...overrides,
  }
}

test('analyzeExpiry: 分档是累计口径（7 天档包含 3 天档）', () => {
  const account = {
    packages: [
      pkg({ remain: 100, expiresAtMs: NOW + 1 * DAY_MS }),
      pkg({ remain: 200, expiresAtMs: NOW + 5 * DAY_MS }),
      pkg({ remain: 400, expiresAtMs: NOW + 20 * DAY_MS }),
    ],
  }
  const result = analyzeExpiry(account, NOW, [3, 7, 30])
  assert.deepEqual(result.buckets.map(b => b.credits), [100, 300, 700])
  assert.deepEqual(result.buckets.map(b => b.days), [3, 7, 30])
  assert.equal(result.expiringTotal, 700)
  assert.equal(result.expiringPackages, 3)
})

test('analyzeExpiry: 月度包不计入「快过期」', () => {
  const account = {
    packages: [pkg({ monthly: true, remain: 500, expiresAtMs: null, refreshAtMs: NOW + DAY_MS })],
  }
  const result = analyzeExpiry(account, NOW, [3, 7, 30])
  assert.equal(result.expiringTotal, 0)
  assert.equal(result.nextExpiry, null)
  assert.deepEqual(result.buckets.map(b => b.credits), [0, 0, 0])
})

test('analyzeExpiry: 已过期的包不计入', () => {
  const account = { packages: [pkg({ remain: 100, expiresAtMs: NOW - DAY_MS })] }
  const result = analyzeExpiry(account, NOW, [3, 7, 30])
  assert.equal(result.expiringTotal, 0)
  assert.equal(result.nextExpiry, null)
})

test('analyzeExpiry: 最近到期给出剩余天数与积分', () => {
  const account = { packages: [pkg({ remain: 294, expiresAtMs: NOW + 3.94 * DAY_MS })] }
  const result = analyzeExpiry(account, NOW, [3, 7, 30])
  assert.ok(result.nextExpiry)
  assert.equal(result.nextExpiry.credits, 294)
  assert.equal(Math.round(result.nextExpiry.daysLeft * 100) / 100, 3.94)
  // date 必须是可读的日期键，前端直接显示它。
  assert.match(result.nextExpiry.date, /^\d{4}-\d{2}-\d{2}$/)
  // 3.94 天 > 3 天窗口：上游的 expiringSoon（3 天窗口）会漏掉它。
  assert.equal(result.buckets[0].credits, 0)
  assert.equal(result.buckets[1].credits, 294)
})

test('analyzeExpiry: 到期日历按本地日期聚合', () => {
  const account = {
    packages: [
      pkg({ remain: 100, expiresAtMs: NOW + 1 * DAY_MS }),
      pkg({ remain: 200, expiresAtMs: NOW + 1 * DAY_MS + 3600_000 }),
    ],
  }
  const result = analyzeExpiry(account, NOW, [3, 7, 30])
  assert.equal(result.timeline.length, 1)
  assert.equal(result.timeline[0].credits, 300)
  assert.equal(result.timeline[0].packages, 2)
})

test('buildState: 跨账号汇总过期积分与最近到期', () => {
  const ledger = emptyLedger()
  const shared = { packages: [pkg({ remain: 100, expiresAtMs: NOW + 2 * DAY_MS })] }
  const snapshot = {
    at: NOW,
    total: 200,
    accounts: [
      { id: 'a1', label: '甲', packages: shared.packages, balance: 100 },
      { id: 'a2', label: '乙', packages: shared.packages, balance: 100 },
    ],
  }
  const state = buildState(ledger, snapshot, null, { ok: true, reason: null }, NOW)
  assert.equal(state.expiry.expiringTotal, 200)
  assert.equal(state.expiry.expiringPackages, 2)
  assert.equal(state.expiry.buckets[0].credits, 200)
  assert.ok(state.expiry.nextExpiry)
  assert.equal(state.expiry.nextExpiry.daysLeft < 3, true)
})
