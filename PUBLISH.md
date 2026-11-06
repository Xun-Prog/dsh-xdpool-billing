# 发布到插件市场 · 操作清单

本目录已按市场要求改好。下面每一步都是手工动作（要你的账号），按顺序做即可。

---

## 0. 前置事实

| 项 | 值 |
|---|---|
| 包名 | `dsh-xdpool-billing` |
| GitHub | `Xun-Prog/dsh-xdpool-billing` |
| 收录条目分类 | `usage`（用量统计） |
| 上游依赖 | `dsh-xdpool` ≥ 2.5.0（只依赖它的两个只读路由） |

市场不是「提交到市场」，而是**在 awesome-dsh-plugin 提一个 PR**。市场（dshmarket）每次打开都实时拉 `awesome-dsh-plugin.com/plugins.json`，所以收录后最长一天自动出现。

---

## 1. 建仓库并推上去

```bash
cd dsh-xdpool-billing
# 建库（网页上建一个空仓库 dsh-xdpool-billing，不要勾 README/.gitignore/LICENSE）
git remote add origin https://github.com/Xun-Prog/dsh-xdpool-billing.git
git push -u origin main
```

> 仓库里已经有 `LICENSE` / `.gitignore` / `README.md`，网页建库时**别勾**这三样，否则要先 pull --rebase。

**给仓库加 `dsh-plugin` topic**（仓库首页 → 齿轮 Settings → Topics，或首页 tag 图标）。CI 会检查。

## 2. 截图（已完成）

`assets/screenshot-panel.png` 已就位，`screenshots.json` 指向它，README 里也嵌了同一张。

**这张图是用示例数据渲染的**，不是从你真实面板截的——所以不带你的账号昵称、手机尾号和余额。想换成真实截图（或加更多张）：

1. 打开 DSH 把胶囊展开截图
2. 存进 `assets/`，在 `screenshots.json` 里按希望的展示顺序列出（最多 8 张）

⚠️ 截真实面板前先想清楚：面板上是你真实的账号昵称、手机尾号和积分余额，会永久公开在 GitHub 上。**建议就用示例数据这张，或者打码后再传。**

截图路径规则：相对路径，不能跳出插件目录（不能以 `/` 开头、不能含 `..`）；只接受 GitHub 托管的图，第三方图床会被拒。

## 3. 发 npm（推荐）

好处：用户预构建安装，跳过 `allowBuilds` 构建授权那一步；市场能显示下载量。

```bash
npm login                      # 浏览器登录
npm publish --dry-run          # 先看会发哪些文件，确认没有多余东西
npm publish
```

**发布前检查**（都已核对过）：

- `files` 白名单只有 8 个文件，57 KB，没有测试、没有截图、没有本地路径
- `repository` 指回本仓库——发布包的 `repository` 必须指回收录的那个仓库，否则市场无法把包和仓库关联上（这是刻意的防冒名机制）
- 官方包全是 `node:` 内置模块，**零运行时依赖**，不会把 `@deepseek-ai/*` 拖成依赖

**发出去就撤不回**：npm 1.0.0 一旦发布，同版本号不能重发，只能发 1.0.1 或 `npm unpublish`（24 小时内且无依赖者才允许）。所以先用 `--dry-run` 看一眼。

## 4. 提交收录（整个投稿就一个文件）

到 https://github.com/awesome-dsh-plugin/awesome-dsh-plugin ：

1. Fork
2. 把本目录的 `listing/Xun-Prog__dsh-xdpool-billing.yml` 复制到 **`data/plugins/`** 下（文件名必须正好是 `Xun-Prog__dsh-xdpool-billing.yml`）
3. 提 PR，标题随意，正文写一句话即可

**不要改 README。** 那两个 README 由 `data/plugins/*.yml` 生成，手工改会冲突——历史上 296 个开放 PR 里有 218 个就是自己重生成了 README 导致无法合并。

CI 会依次检查：条目数 ≤3 → `package.json` 里有 `dsh.bundle`（有）→ 仓库创建满 1 天 → awesome-lint。**所以第 1 步建完库最好等一天再提 PR**，否则会被「仓库 0.5 天大」挡住。这个门会自动重跑，不用推空提交。

## 5. 之后

- 合并后网站自己重建，最长一天出现在市场里
- 想换截图：推自己的仓库即可，下一次夜间构建生效，不用再来提 PR
- 想改条目描述：**只改你自己那个 yml**，不要动别人的

---

## 已经替你核对过的收录要求

| 要求 | 状态 |
|---|---|
| `package.json` 声明 `dsh.bundle` | ✅ `{"patch": "./cordis.patch.yml"}` |
| 仓库根有 `cordis.patch.yml` | ✅ 已有，内含 `insert` + `id` + `name` |
| 仓库满 1 天 | ⏳ 建库后等一天 |
| `dsh-plugin` topic | ⏳ 手动加 |
| 描述属实、不带营销词 | ✅ 见下方「描述核对」 |
| 分类贴合实际功能 | ✅ `usage` |
| 官方包用 `peerDependencies` | ✅ 不适用：零依赖 |
| `engines.dsh` 能匹配当前宿主 | ✅ `<0.3.0`，实测 `0.2.1-rc.5` 判定 compatible |
| 图标是 GitHub 托管的位图 | ⏳ 可选，现在是 SVG（收录条目已省略 `icon:` 字段） |

---

## 描述核对（评审会逐句对着代码查）

条目里每句话都能在代码里指到：

| 描述里的说法 | 代码位置 |
|---|---|
| 每个账号的剩余积分与积分包明细 | `client.js` 账号列表 + `index.js` `accountPackageTotals` |
| 按余额快照差值实测今日/本月/累计 | `mergeSnapshot()` 用 `record.lastBalance` 算差额 |
| 3/7/30 天分档预警即将过期 | `analyzeExpiry()` + `DEFAULT_EXPIRY_WINDOWS = [3, 7, 30]` |

描述里**没有**写「支持 N 家厂商」「46 个功能」这类没法核对的话。

---

## 已知的坑（发布前想清楚）

1. **上游改名/改路由就挂**。本插件没有实现上游协议，完全依赖 dsh-xdpool 的 `/plugins/dsh-xdpool/status` 和 `/usage` 两个路由。上游哪天改了路径，面板会显示「数据源不可用」。这是刻意的取舍（不重复实现协议、不去解密凭据），但意味着**上游升级后要跟着测**。
2. **上游没装就是灰的**。用户装了本插件但没装 dsh-xdpool，看到的是「数据源不可用」。卡片描述里已经点明了依赖，但评论里大概率还会有人问。
3. **账本是本机文件**。卸载重装不丢（在 `$DSH_HOME/storages/`），但换机器就没了。
4. **不要在 profile 里跑 `pnpm install`** 验证——运行中的 DSH 正在用它，市场本身就有「有 agent 在跑就拒绝安装」的守卫。

---

## 开源前最后一道自检

```bash
cd xdpool-billing-plugin
node --test test/billing.test.mjs test/client-balance.test.mjs   # 26 条全绿
npm pack --dry-run                                              # 看清单
grep -rn "C:\\\\Users" . --exclude-dir=node_modules             # 不该有本机路径
```
