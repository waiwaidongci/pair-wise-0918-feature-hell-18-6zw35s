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

## 闭环管理规则（一次调校、一次复测）

按钟表当前闭环状态控制 `POST /clocks/:id/adjustments`：

| 当前状态 | 再次调校 |
| --- | --- |
| 尚无调校（`NO_ADJUSTMENT`） | 允许（首次调校） |
| 最新调校尚无复测（`PENDING_RETEST`） | **409 拒绝**（`code: PENDING_RETEST`），必须先复测 |
| 最新复测不合格（`RETEST_UNQUALIFIED`） | 允许继续调校 |
| 最新复测合格（`QUALIFIED`） | 允许返修，但必须在请求体写明 `reworkReason`，否则 **409**（`code: REWORK_REASON_REQUIRED`） |

复测侧同样强制一对一（`POST /clocks/:id/retests`）：

- 无任何调校时复测 → 409（`NO_ADJUSTMENT`）；
- 只能对最新一次、且尚无复测的调校复测；对旧调校补测 → 409（`RETEST_TARGET_NOT_LATEST`），重复复测 → 409（`RETEST_EXISTS`）；
- 指定的 `adjustmentId` 不存在或不属于该钟表 → 400。

所有拒绝均发生在写库之前，不会改变原档案。调校记录新增 `reworkReason` 字段（非返修场景为空串）。

`GET /clocks/:id/history` 返回：

- `adjustments[]`：每条调校内嵌对应的 `retest`、`retestId`，以及配对状态 `closedLoopStatus` / `closedLoopStatusLabel`（`PENDING_RETEST` 待复测、`RETEST_UNQUALIFIED` 复测不合格、`QUALIFIED` 复测合格）；
- 顶层 `closedLoopStatus` / `closedLoopStatusLabel`：该钟表当前闭环状态（另含 `NO_ADJUSTMENT` 尚无调校记录）。

`GET /clocks` 的每条汇总也带当前闭环状态字段。

## 闭环示例

```bash
curl http://127.0.0.1:3021/clocks/clock_demo/history
# 最新复测不合格 -> 可继续调校
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/adjustments \
  -H 'Content-Type: application/json' \
  -d '{"currentDailyRateSeconds":31,"direction":"慢针方向","amount":"再向慢侧微调0.2格"}'
# 一调一测
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":12,"amplitude":252,"note":"复测进入目标范围"}'
# 合格后返修必须写明原因
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/adjustments \
  -H 'Content-Type: application/json' \
  -d '{"currentDailyRateSeconds":13,"direction":"快针方向","amount":"游丝外桩微调","reworkReason":"返修：佩戴一周后日慢8秒"}'
```
