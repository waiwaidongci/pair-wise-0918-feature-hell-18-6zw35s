# 机械钟表擒纵调校API

纯后端零依赖Node服务，使用 `data/db.json` 持久化钟表档案、调校记录和复测记录。

## 启动

```bash
PORT=3021 node server.js
```

## 主要接口

- `GET /health`
- `GET /clocks`
- `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`
- `POST /clocks/:id/adjustments`
- `POST /clocks/:id/retests`
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=`

## 闭环规则（一次调校、一次复测）

- 最新调校尚无复测时，再次发起调校返回 **409**，必须先复测。
- 只有最新复测**不合格**时才允许继续调校（返修原因可选）。
- 最新复测**合格**后继续调校，必须提供 `reworkReason`（返修原因），否则返回 **400**。
- 复测只能针对**最新一次调校**，且每次调校最多一次复测：无调校记录、重复复测、复测非最新调校均返回 **409/404**。
- 所有拒绝在校验阶段直接返回，**不会写入、不改变原档案**。

闭环状态（`loopStatus`）：

| code | 含义 |
| --- | --- |
| `NOT_STARTED` | 尚未开始调校（首次调校可直接发起） |
| `PENDING_RETEST` | 最新调校尚无复测 |
| `AWAITING_ADJUSTMENT` | 最新复测不合格，可继续调校 |
| `CLOSED_QUALIFIED` | 最新复测合格，闭环已关闭 |

`GET /clocks/:id/history` 在 `steps[]` 中按时间顺序列出每次调校，`retest` 为其对应复测（无则为 `null`），并给出 `stepStatus`（`PENDING_RETEST` / `RETEST_NOT_QUALIFIED` / `RETEST_QUALIFIED`）、`closedLoop` 单步闭环标记；顶层 `loopStatus` / `closedLoop` 为该钟表当前整体闭环状态。

调校记录新增字段：`reworkReason`（返修原因）、`basedOnRetestId`（本次调校依据的复测记录）。

## 闭环示例

```bash
curl http://127.0.0.1:3021/clocks/not-qualified
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":12,"amplitude":252,"note":"复测进入目标范围"}'

# 合格后返修：必须写明返修原因
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/adjustments \
  -H 'Content-Type: application/json' \
  -d '{"currentDailyRateSeconds":12,"direction":"快针方向","amount":"向快侧0.1格","reworkReason":"客户反馈佩戴一周后日差偏慢，需返修"}'
```
