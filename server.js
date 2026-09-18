const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3021);
const DB_FILE = path.join(__dirname, "data", "db.json");

const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      note: "怀表机芯，走时偏快",
      createdAt: new Date().toISOString()
    }
  ],
  adjustments: [
    {
      id: "adjustment_demo",
      clockId: "clock_demo",
      currentDailyRateSeconds: 68,
      direction: "慢针方向",
      amount: "游丝快慢针向慢侧微调0.4格",
      reworkReason: "",
      note: "初次调校，先保守处理",
      createdAt: new Date().toISOString()
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      testedAt: new Date().toISOString(),
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ]
};

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "GET /adjustments",
  "GET /retests"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  return JSON.parse(await readFile(DB_FILE, "utf8"));
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.bizCode = code;
  return error;
}

const LOOP_LABELS = {
  NO_ADJUSTMENT: "尚无调校记录",
  PENDING_RETEST: "最新调校尚无复测",
  RETEST_UNQUALIFIED: "最新复测不合格，可继续调校",
  QUALIFIED: "最新复测合格，闭环完成；继续调校须写明返修原因"
};

const PAIR_LABELS = {
  PENDING_RETEST: "待复测",
  RETEST_UNQUALIFIED: "复测不合格",
  QUALIFIED: "复测合格"
};

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) {
    const error = new Error("钟表不存在");
    error.status = 404;
    throw error;
  }
  return clock;
}

function latestRetest(db, clockId) {
  return db.retests
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null;
}

function latestAdjustment(db, clockId) {
  return db.adjustments
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function retestsForAdjustment(db, adjustmentId) {
  return db.retests
    .filter((item) => item.adjustmentId === adjustmentId)
    .sort((a, b) => new Date(a.testedAt) - new Date(b.testedAt));
}

// 钟表当前闭环状态
function closedLoopState(db, clockId) {
  const adjustment = latestAdjustment(db, clockId);
  if (!adjustment) {
    return { status: "NO_ADJUSTMENT", label: LOOP_LABELS.NO_ADJUSTMENT, latestAdjustment: null, latestRetest: null };
  }
  const pairs = retestsForAdjustment(db, adjustment.id);
  const retest = pairs[pairs.length - 1] || null;
  if (!retest) {
    return { status: "PENDING_RETEST", label: LOOP_LABELS.PENDING_RETEST, latestAdjustment: adjustment, latestRetest: null };
  }
  if (!retest.qualified) {
    return { status: "RETEST_UNQUALIFIED", label: LOOP_LABELS.RETEST_UNQUALIFIED, latestAdjustment: adjustment, latestRetest: retest };
  }
  return { status: "QUALIFIED", label: LOOP_LABELS.QUALIFIED, latestAdjustment: adjustment, latestRetest: retest };
}

// 单次“调校—复测”配对状态
function adjustmentWithPair(db, adjustment) {
  const pairs = retestsForAdjustment(db, adjustment.id);
  const retest = pairs[pairs.length - 1] || null;
  const loopStatus = !retest ? "PENDING_RETEST" : retest.qualified ? "QUALIFIED" : "RETEST_UNQUALIFIED";
  return {
    ...adjustment,
    retest,
    retestId: retest ? retest.id : null,
    closedLoopStatus: loopStatus,
    closedLoopStatusLabel: PAIR_LABELS[loopStatus]
  };
}

function clockSummary(db, clock) {
  const loop = closedLoopState(db, clock.id);
  return {
    ...clock,
    latestAdjustment: loop.latestAdjustment,
    latestRetest: loop.latestRetest,
    qualified: loop.latestRetest ? loop.latestRetest.qualified : false,
    closedLoopStatus: loop.status,
    closedLoopStatusLabel: loop.label
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
  }

  if (req.method === "GET" && pathname === "/clocks") {
    const qualified = url.searchParams.get("qualified");
    let data = db.clocks.map((clock) => clockSummary(db, clock));
    if (qualified !== null) {
      const expected = qualified === "true";
      data = data.filter((clock) => clock.qualified === expected);
    }
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
    const body = await parseBody(req);
    required(body, ["code", "escapementType", "balanceFrequency"]);
    const clock = {
      id: makeId("clock"),
      code: body.code,
      escapementType: body.escapementType,
      balanceFrequency: body.balanceFrequency,
      targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.clocks.push(clock);
    await writeDb(db);
    return send(res, 201, { data: clockSummary(db, clock) });
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const data = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const clock = findClock(db, historyMatch[1]);
    const adjustments = db.adjustments
      .filter((item) => item.clockId === clock.id)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .map((item) => adjustmentWithPair(db, item));
    const retests = db.retests
      .filter((item) => item.clockId === clock.id)
      .sort((a, b) => new Date(a.testedAt) - new Date(b.testedAt));
    const loop = closedLoopState(db, clock.id);
    return send(res, 200, {
      data: {
        clock,
        adjustments,
        retests,
        latestAdjustment: loop.latestAdjustment,
        latestRetest: loop.latestRetest,
        closedLoopStatus: loop.status,
        closedLoopStatusLabel: loop.label
      }
    });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const clock = findClock(db, adjustmentMatch[1]);
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);

    // 闭环前置校验：任何拒绝都在写入前发生，不改变原档案
    const loop = closedLoopState(db, clock.id);
    let reworkReason = "";
    if (loop.status === "PENDING_RETEST") {
      throw httpError(409, "最新调校尚无复测，按一次调校、一次复测闭环要求，必须先复测后才能再次调校", "PENDING_RETEST");
    }
    if (loop.status === "RETEST_UNQUALIFIED") {
      reworkReason = (body.reworkReason ?? body.rework_reason ?? "").toString().trim();
    }
    if (loop.status === "QUALIFIED") {
      reworkReason = (body.reworkReason ?? body.rework_reason ?? "").toString().trim();
      if (!reworkReason) {
        throw httpError(409, "最新复测已合格，继续调校（返修）必须写明返修原因 reworkReason", "REWORK_REASON_REQUIRED");
      }
    }

    const adjustment = {
      id: makeId("adjustment"),
      clockId: clock.id,
      currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
      direction: body.direction,
      amount: body.amount,
      reworkReason,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.adjustments.push(adjustment);
    await writeDb(db);
    return send(res, 201, { data: adjustmentWithPair(db, adjustment) });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    const clock = findClock(db, retestMatch[1]);
    const body = await parseBody(req);
    required(body, ["dailyRateSeconds", "amplitude"]);

    // 闭环前置校验：复测必须挂在一次调校上，且一调一测
    const latest = latestAdjustment(db, clock.id);
    if (!latest) {
      throw httpError(409, "该钟表尚无调校记录，无法复测；请先创建调校", "NO_ADJUSTMENT");
    }
    let adjustment = latest;
    if (body.adjustmentId) {
      adjustment = db.adjustments.find((item) => item.id === body.adjustmentId);
      if (!adjustment) {
        throw httpError(400, "指定的调校记录不存在", "ADJUSTMENT_NOT_FOUND");
      }
      if (adjustment.clockId !== clock.id) {
        throw httpError(400, "指定的调校记录不属于该钟表", "ADJUSTMENT_CLOCK_MISMATCH");
      }
      if (adjustment.id !== latest.id) {
        throw httpError(409, "只能对最新一次调校进行复测；已有复测的调校不能重复补测", "RETEST_TARGET_NOT_LATEST");
      }
    }
    if (retestsForAdjustment(db, adjustment.id).length > 0) {
      throw httpError(409, "该调校已存在复测，按一次调校、一次复测要求不得重复复测", "RETEST_EXISTS");
    }

    const qualified = body.qualified !== undefined
      ? Boolean(body.qualified)
      : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
    const retest = {
      id: makeId("retest"),
      clockId: clock.id,
      adjustmentId: adjustment.id,
      testedAt: body.testedAt || new Date().toISOString(),
      dailyRateSeconds: Number(body.dailyRateSeconds),
      amplitude: Number(body.amplitude),
      qualified,
      note: body.note || ""
    };
    db.retests.push(retest);
    await writeDb(db);
    return send(res, 201, { data: retest, clock: clockSummary(db, clock) });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    findClock(db, latestMatch[1]);
    return send(res, 200, { data: latestRetest(db, latestMatch[1]) });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const data = db.retests.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchQualified = qualified === null || item.qualified === (qualified === "true");
      return matchClock && matchQualified;
    });
    return send(res, 200, { data });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    const body = { error: error.message || "服务器错误" };
    if (error.bizCode) body.code = error.bizCode;
    send(res, error.status || 500, body);
  });
});

server.listen(PORT, () => {
  console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
});
