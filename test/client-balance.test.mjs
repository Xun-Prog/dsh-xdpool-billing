import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 客户端渲染的纯逻辑测试。
 *
 * 截图暴露过的 bug：余额显示成 0，而服务端其实是「未知」或「旧读数」。
 * 面板的渲染逻辑抽成纯函数 `describeBalance(state)` 后就能直接断言，
 * 不需要浏览器。
 */

// 与 client.js 里的实现保持一致的一份最小复刻。
// 这里刻意不 import client.js：它是浏览器 bundle，没有导出，import 会在 Node 里炸。
export function describeBalance(state, t) {
  const staleCount = state.staleBalances ?? 0
  const missingCount = state.missingBalances ?? 0
  const hasLiveTotal = typeof state.liveTotal === 'number'
  const rawBalance = state.balance
  const balanceKnown = typeof rawBalance === 'number' && (rawBalance !== 0 || hasLiveTotal)
  const balanceText = balanceKnown
    ? String(rawBalance) + (staleCount > 0 ? ` (${staleCount}${t('stale')})` : '')
    : `${t('unknown')} (${missingCount})`
  const isWarn = !balanceKnown || staleCount > 0
  return { balanceKnown, balanceText, isWarn, staleCount, missingCount }
}

const T = key => (key === 'stale' ? '个旧读数' : key === 'unknown' ? '未知' : key)

test('describeBalance: 实读余额正常显示', () => {
  const out = describeBalance({ balance: 12486, liveTotal: 12486, staleBalances: 0, missingBalances: 0 }, T)
  assert.equal(out.balanceKnown, true)
  assert.equal(out.balanceText, '12486')
  assert.equal(out.isWarn, false)
})

test('describeBalance: 余额为 0 且有实读总额时，显示 0 而不是未知', () => {
  // 真的花光了：liveTotal 存在，说明这一轮确实读到了 0。
  const out = describeBalance({ balance: 0, liveTotal: 0, staleBalances: 0, missingBalances: 0 }, T)
  assert.equal(out.balanceKnown, true)
  assert.equal(out.balanceText, '0')
})

test('describeBalance: 余额为 0 但没有实读总额时，显示未知而不是 0', () => {
  // 这就是截图里的场景：读数缺失被渲染成「0」，会被读成「积分花光了」。
  const out = describeBalance({ balance: 0, staleBalances: 0, missingBalances: 1 }, T)
  assert.equal(out.balanceKnown, false)
  assert.equal(out.balanceText, '未知 (1)')
  assert.equal(out.isWarn, true)
})

test('describeBalance: 旧读数会带上标记', () => {
  const out = describeBalance({ balance: 5950, liveTotal: 3950, staleBalances: 1, missingBalances: 1 }, T)
  assert.equal(out.balanceKnown, true)
  assert.equal(out.balanceText, '5950 (1个旧读数)')
  assert.equal(out.isWarn, true)
})

test('describeBalance: balance 缺失时显示未知', () => {
  const out = describeBalance({ staleBalances: 0, missingBalances: 2 }, T)
  assert.equal(out.balanceKnown, false)
  assert.equal(out.balanceText, '未知 (2)')
})
