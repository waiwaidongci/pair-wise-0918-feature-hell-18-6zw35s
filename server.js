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

const LOOP_STATUS = Object.freeze({
  NOT_STARTED: { code: "NOT_STARTED", text: "尚未开始调校" },
  PENDING_RETEST: { code: "PENDING_RETEST", text: "最新调校尚无复测" },
  AWAITING_ADJUSTMENT: { code: "AWAITING_ADJUSTMENT", text: "最新复测不合格，可继续调校" },
  CLOSED_QUALIFIED: { code: "CLOSED_QUALIFIED", text: "最新复测合格，闭环已关闭" }
});

const STEP_STATUS = Object.freeze({
  PENDING_RETEST: { code: "PENDING_RETEST", text: "待复测", closedLoop: false },
  RETEST_NOT_QUALIFIED: { code: "RETEST_NOT_QUALIFIED", text: "复测不合格", closedLoop: true },
  RETEST_QUALIFIED: { code: "RETEST_QUALIFIED", text: "复测合格", closedLoop: true }
});

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

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

function retestForAdjustment(db, adjustmentId) {
  // 一次调校只对应一次复测；兼容历史脏数据时取时间最新的一条
  return db.retests
    .filter((item) => item.adjustmentId === adjustmentId)
    .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null;
}

function loopStatus(db, clockId) {
  const adjustment = latestAdjustment(db, clockId);
  if (!adjustment) return LOOP_STATUS.NOT_STARTED;
  const retest = retestForAdjustment(db, adjustment.id);
  if (!retest) return LOOP_STATUS.PENDING_RETEST;
  return retest.qualified ? LOOP_STATUS.CLOSED_QUALIFIED : LOOP_STATUS.AWAITING_ADJUSTMENT;
}

function historySteps(db, clockId) {
  return db.adjustments
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .map((adjustment, index) => {
      const retest = retestForAdjustment(db, adjustment.id);
      const status = !retest
        ? STEP_STATUS.PENDING_RETEST
        : retest.qualified
          ? STEP_STATUS.RETEST_QUALIFIED
          : STEP_STATUS.RETEST_NOT_QUALIFIED;
      return {
        seq: index + 1,
        adjustment,
        retest,
        stepStatus: status.code,
        stepStatusText: status.text,
        closedLoop: status.closedLoop
      };
    });
}

function clockSummary(db, clock) {
  const retest = latestRetest(db, clock.id);
  const adjustment = latestAdjustment(db, clock.id);
  const status = loopStatus(db, clock.id);
  return {
    ...clock,
    latestAdjustment: adjustment,
    latestRetest: retest,
    qualified: retest ? retest.qualified : false,
    loopStatus: status.code,
    loopStatusText: status.text,
    closedLoop: status.code === LOOP_STATUS.CLOSED_QUALIFIED.code
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
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const retests = db.retests
      .filter((item) => item.clockId === clock.id)
      .sort((a, b) => new Date(a.testedAt) - new Date(b.testedAt));
    const status = loopStatus(db, clock.id);
    return send(res, 200, {
      data: {
        clock,
        steps: historySteps(db, clock.id),
        adjustments,
        retests,
        latestRetest: latestRetest(db, clock.id),
        loopStatus: status.code,
        loopStatusText: status.text,
        closedLoop: status.code === LOOP_STATUS.CLOSED_QUALIFIED.code
      }
    });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const clock = findClock(db, adjustmentMatch[1]);
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);

    // 闭环闸门：以下校验全部通过后才允许写入，任何拒绝都不改变原档案
    const latestAdj = latestAdjustment(db, clock.id);
    if (latestAdj && !retestForAdjustment(db, latestAdj.id)) {
      fail(409, "最新调校尚无复测，必须先完成复测才能再次调校");
    }
    const latest = latestRetest(db, clock.id);
    const reworkReason = (body.reworkReason || "").trim();
    if (latest && latest.qualified && !reworkReason) {
      // 合格后继续调校属于返修，必须写明返修原因；
      // 最新复测不合格时为正常返修，返修原因可选
      fail(400, "最新复测已合格，继续调校必须写明返修原因（reworkReason）");
    }

    const adjustment = {
      id: makeId("adjustment"),
      clockId: clock.id,
      currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
      direction: body.direction,
      amount: body.amount,
      basedOnRetestId: latest ? latest.id : null,
      reworkReason,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.adjustments.push(adjustment);
    await writeDb(db);
    return send(res, 201, { data: adjustment, clock: clockSummary(db, clock) });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    const clock = findClock(db, retestMatch[1]);
    const body = await parseBody(req);
    required(body, ["dailyRateSeconds", "amplitude"]);

    // 闭环闸门：一次调校只允许一次复测，且只能复测最新调校
    const latestAdj = latestAdjustment(db, clock.id);
    if (!latestAdj) {
      fail(409, "该钟表尚无调校记录，无法复测");
    }
    if (body.adjustmentId && body.adjustmentId !== latestAdj.id) {
      const target = db.adjustments.find(
        (item) => item.id === body.adjustmentId && item.clockId === clock.id
      );
      if (!target) fail(404, "指定的调校记录不存在");
      fail(409, "只能对最新一次调校进行复测");
    }
    if (retestForAdjustment(db, latestAdj.id)) {
      fail(409, "最新调校已有复测，不能重复复测");
    }

    const qualified = body.qualified !== undefined
      ? Boolean(body.qualified)
      : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
    const retest = {
      id: makeId("retest"),
      clockId: clock.id,
      adjustmentId: latestAdj.id,
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
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
});
