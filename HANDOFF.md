# HANDOFF.md — `evolve_read(action="handoff")`

A fork of [ZK-Andy/dsh-continual-evolve](https://github.com/ZK-Andy/dsh-continual-evolve) adding one feature. Everything else is upstream, unchanged.

## What it does

`evolve_read(kind="memory", action="handoff")` renders this workspace's memories as four questions and nothing else:

```
## ① 我是谁      ← user / feedback memories
## ② 干到哪      ← what landed, with evidence
## ③ 下一步      ← L2 session state, stated as empty
## ④ 卡在哪      ← same
```

The idea is borrowed from a handoff discipline used in another workbench project: a session's value is the files it produces, not how much it chatted — so before switching sessions, the only thing worth writing down is **who I am / what landed / what's next / what's blocked**.

## Why a projection, not a new store

The store already has the raw material. It classifies every row by `type`:

| type | answers |
|---|---|
| `user` | ① what this workspace is, and its rules |
| `feedback` | how work gets done (carries `Why:` / `How to apply:`) |
| `reference` | where things are |

Questions ③ and ④ are **L2 session state**, which by design never enters the store. So this view renders them as an explicit empty slot *with the reason*, instead of fabricating a memory that would rot within a week.

A handoff file that someone has to hand-maintain becomes a weekly report nobody reads. A projection cannot go stale — it is always exactly what the store holds right now.

## Two failure modes this guards against

Both were hit during development, which is why they are called out here.

### 1. Contract labels swallowing a whole memory

`feedback` rows are gated on carrying `**Why:**` and `**How to apply:**`. The first implementation filtered lines starting with those labels out as noise — which emptied the summary of every feedback memory, so they **vanished from the view entirely** while sitting safely in the store.

Now: labels are stripped, text is kept, and the `How to apply` line is preferred (it is the actionable half).

### 2. Silent clipping

The injection layer degrades quietly on purpose — it must never fail a turn. A handoff view cannot do that, because its entire value is *read this, then start working*. A view that looks complete but dropped a memory gives the reader no signal at all.

So every dropped or shortened entry is reported:

```
（另 2 条因体积上限未展开，用 `evolve_read(…, query)` 检索）
⚠ 因体积上限裁掉 2 条——这意味着交接可能不完整，优先看 ②「干到哪」是否有缺口。
```

And when the budget is smaller than the fixed skeleton (headings, headers, empty slots, footer — roughly 1.3 KB), it says so rather than pretending to honour the number:

```
⚠ 条目预算 600 小于固定结构本身（约 1290 字节），实际输出必然超出。
```

## Clipping order

Least-valuable-first: `progress → who → next → blocked`. Two passes — drop whole lines first (keeping at least one per question so no slot goes blank when it has content), then shorten survivors by bytes without splitting a multi-byte character. Partial information beats an empty slot.

## Tests

`test/evolve-handoff.test.ts`, 17 cases:

- question order and the ③/④ empty-slot marker
- type routing, unknown type falls back to ① rather than dropping the row
- contract-label handling (the regression above)
- `How to apply` preferred over `Why`; `Why` as fallback
- `notWhen` caveat rendering
- per-question limit disclosure
- budget clipping disclosure, and the skeleton-larger-than-budget warning
- counter accuracy

Full suite is unchanged apart from the additions: **41 failures exist upstream too** (CI gate fixtures are not shipped in the repo's npm layout), 900 → 917 passing.

## Diff surface

```
src/surfaces/evolve-handoff.ts   (new, ~300 lines)
src/surfaces/evolve-memory.ts    (+11: route on action, import)
src/surfaces/evolve-tools.ts     (+12: action param, pass-through)
test/evolve-handoff.test.ts      (new, 17 tests)
```

## Upstream

If this is wanted upstream, it is a self-contained addition — no schema change, no migration, no behaviour change to any existing read path. The `action` parameter is optional and enum-constrained to `handoff`, so an unknown value is a validation error rather than a silent fallback.
