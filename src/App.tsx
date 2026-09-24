import { useMemo, useState, type ReactNode } from "react";
import "./styles.css";
import type { BatchItem, Cylinder, Label } from "./types";
import {
  AIR_O2,
  LABEL_SPECS,
  NEAR_EXPIRY_DAYS,
  PRESETS,
  formatDateTime,
  gasKindOf,
  hydroStatus,
  planFill,
  todayISO,
} from "./fillLogic";
import { plannedRank, sortQueue, useFillStore } from "./store";

/* ------------------------------ 小组件 ------------------------------- */

function Badge({ tone, children }: { tone: "air" | "nitrox" | "trimix" | "danger" | "warn" | "muted"; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function labelTone(label: Label): "air" | "nitrox" | "trimix" {
  return label === "AIR" ? "air" : label === "NITROX" ? "nitrox" : "trimix";
}

function HydroTag({ date }: { date: string }) {
  const h = hydroStatus(date);
  if (h.expired) return <Badge tone="danger">检验过期 {-h.daysLeft} 天</Badge>;
  if (h.near) return <Badge tone="warn">检验剩 {h.daysLeft} 天</Badge>;
  return <Badge tone="muted">检验至 {date.slice(2)}</Badge>;
}

function NumField({
  label, value, onChange, min, max, step = 1, suffix, width,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  width?: string;
}) {
  return (
    <label className="num-field" style={width ? { width } : undefined}>
      <span>{label}</span>
      <span className="num-input">
        <input
          type="number"
          value={Number.isFinite(value) ? value : ""}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
        />
        {suffix && <em>{suffix}</em>}
      </span>
    </label>
  );
}

/* ------------------------------ 主应用 ------------------------------- */

type QueueFilter = "ALL" | "AIR" | "NITROX" | "TRIMIX" | "EXPIRY" | "RUSH";

export default function App() {
  const store = useFillStore();
  const { state } = store;

  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState<QueueFilter>("ALL");
  const [confirmedSign, setConfirmedSign] = useState<Record<string, boolean>>({});
  const [rejectDrafts, setRejectDrafts] = useState<Record<string, string>>({});
  const [historyQuery, setHistoryQuery] = useState("");
  const [intakeMsg, setIntakeMsg] = useState<string | null>(null);

  const cylById = useMemo(() => {
    const m = new Map<string, Cylinder>();
    state.cylinders.forEach((c) => m.set(c.id, c));
    return m;
  }, [state.cylinders]);

  /* ---------------------------- 队列派生 ---------------------------- */

  const queue = useMemo(() => sortQueue(state.cylinders.filter((c) => c.enqueued)), [state.cylinders]);

  const plannedPositions = useMemo(() => {
    const plan = [...state.cylinders.filter((c) => c.enqueued)].sort(plannedRank);
    return new Map(plan.map((c, i) => [c.id, i + 1]));
  }, [state.cylinders]);

  const filteredQueue = useMemo(() => {
    return queue.filter((c) => {
      if (filter === "ALL" || filter === "RUSH") return filter === "ALL" ? true : c.rush;
      if (filter === "EXPIRY") {
        const h = hydroStatus(c.hydroDate);
        return h.expired || h.near;
      }
      return c.label === filter;
    });
  }, [queue, filter]);

  const selectableIds = filteredQueue.map((c) => c.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.includes(id));

  const toggleSelect = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const expiryCount = state.cylinders.filter((c) => {
    if (!c.enqueued) return false;
    const h = hydroStatus(c.hydroDate);
    return h.expired || h.near;
  }).length;

  const signedToday = state.receipts.filter((r) => r.signedAt.slice(0, 10) === todayISO()).length;

  /* ---------------------------- 批次派生 ---------------------------- */

  const batchRows = state.batch.map((item) => {
    const cyl = cylById.get(item.cylId);
    const plan = cyl
      ? planFill(cyl, {
          targetPressure: item.targetPressure,
          targetO2: item.targetO2,
          targetHe: item.targetHe,
        })
      : null;
    return { item, cyl, plan };
  });

  const patchItem = (cylId: string, patch: Partial<BatchItem>) => store.updateBatchItem(cylId, patch);

  const applyPreset = (item: BatchItem, o2: number, he: number) => {
    patchItem(item.cylId, {
      targetO2: o2,
      targetHe: he,
      actualO2: o2,
      actualHe: he,
    });
  };

  const setTargetPressure = (item: BatchItem, p: number) =>
    patchItem(item.cylId, { targetPressure: p, actualPressure: p });

  /* ------------------------------ 操作 ------------------------------ */

  const addSelectedToBatch = () => {
    if (selected.length === 0) return;
    store.addToBatch(selected);
    setSelected([]);
  };

  const doSignOff = (cylId: string) => {
    const row = batchRows.find((r) => r.item.cylId === cylId);
    if (!row || !row.cyl || !row.plan || !row.plan.ok) return;
    if (!state.operator.trim()) return;
    const { item, plan } = row;
    if (!(item.actualPressure > 0)) return;
    store.signOff(
      cylId,
      { pressure: item.actualPressure, o2: item.actualO2, he: item.actualHe },
      { addHe: plan.addHe, addO2: plan.addO2, addAir: plan.addAir },
      { pressure: plan.targetPressure, o2: plan.targetO2, he: plan.targetHe, gasKind: plan.gasKind }
    );
    setConfirmedSign((m) => {
      const n = { ...m };
      delete n[cylId];
      return n;
    });
  };

  const doReject = (cylId: string) => {
    const row = batchRows.find((r) => r.item.cylId === cylId);
    if (!row || !row.cyl) return;
    const autoReason = row.plan?.errors.join("；") || "操作员手动移出";
    const draft = (rejectDrafts[cylId] ?? "").trim();
    const reason = draft || autoReason;
    const requested = `${gasKindOf(row.item.targetO2, row.item.targetHe)}，目标 ${row.item.targetPressure} bar / O₂ ${row.item.targetO2}%${
      row.item.targetHe ? ` / He ${row.item.targetHe}%` : ""
    }`;
    store.rejectFromBatch(cylId, requested, draft);
    setRejectDrafts((m) => {
      const n = { ...m };
      delete n[cylId];
      return n;
    });
  };

  /* --------------------------- 单瓶历史查询 -------------------------- */

  const historyCyl = historyQuery.trim() ? cylById.get(historyQuery.trim().toUpperCase()) : undefined;
  const historyReceipts = historyCyl ? state.receipts.filter((r) => r.cylId === historyCyl.id) : [];
  const historyRejects = historyCyl ? state.rejections.filter((r) => r.cylId === historyCyl.id) : [];
  const quickIds = Array.from(new Set([...state.receipts.map((r) => r.cylId), ...queue.map((c) => c.id)])).slice(0, 8);

  /* ------------------------------ 渲染 ------------------------------ */

  return (
    <main className="app">
      {/* 顶部 */}
      <header className="topbar">
        <div>
          <h1>气瓶充填台</h1>
          <p>待充填队列 → 计算目标压力与配气 → 异常移出 → 完成签收（记录本机保留）</p>
        </div>
        <div className="operator-box">
          <label>
            <span>当班操作员</span>
            <input value={state.operator} onChange={(e) => store.setOperator(e.target.value)} placeholder="输入姓名" />
          </label>
          <button className="ghost" onClick={store.resetDemo} title="清空本机记录并恢复演示数据">重置演示数据</button>
        </div>
      </header>

      <section className="metrics">
        <article><small>待充填</small><strong>{queue.length}</strong></article>
        <article><small>本批次瓶数</small><strong>{state.batch.length}</strong></article>
        <article className={expiryCount ? "metric-alert" : ""}><small>检验临期/过期</small><strong>{expiryCount}</strong></article>
        <article><small>今日签收</small><strong>{signedToday}</strong></article>
      </section>

      <div className="workspace">
        {/* 左：待充填队列 */}
        <section className="panel queue-panel">
          <div className="panel-head">
            <h2>待充填队列</h2>
            <div className="chips">
              {([
                ["ALL", "全部"],
                ["AIR", "空气"],
                ["NITROX", "高氧"],
                ["TRIMIX", "Trimix"],
                ["EXPIRY", `临期${NEAR_EXPIRY_DAYS}天`],
                ["RUSH", "加急"],
              ] as [QueueFilter, string][]).map(([k, label]) => (
                <button key={k} className={filter === k ? "chip on" : "chip"} onClick={() => setFilter(k)}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="queue-actions">
            <label className="check-all">
              <input type="checkbox" checked={allSelected} onChange={() =>
                setSelected(allSelected ? [] : selectableIds)} />
              全选当前列表
            </label>
            <button className="primary" disabled={selected.length === 0} onClick={addSelectedToBatch}>
              加入充填批次{selected.length ? `（${selected.length}）` : ""}
            </button>
          </div>

          <div className="queue-list">
            {filteredQueue.length === 0 && <p className="empty">队列中没有符合条件的气瓶</p>}
            {filteredQueue.map((c) => {
              const pos = plannedPositions.get(c.id);
              const h = hydroStatus(c.hydroDate);
              return (
                <article
                  key={c.id}
                  className={`queue-card ${selected.includes(c.id) ? "sel" : ""} ${
                    h.expired ? "is-expired" : h.near ? "is-near" : ""
                  } ${c.rush ? "is-rush" : ""}`}
                >
                  <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggleSelect(c.id)} />
                  <div className="queue-main">
                    <div className="queue-title">
                      <h3>{c.id}</h3>
                      <Badge tone={labelTone(c.label)}>{LABEL_SPECS[c.label].name}</Badge>
                      {c.rush && <Badge tone="warn">加急 ↑</Badge>}
                    </div>
                    <p className="queue-meta">
                      {c.volumeL}L · 工作 {c.workingPressure} bar · 余压 {c.residualPressure} bar ·
                      残气 O₂ {c.residualO2}%{c.residualHe > 0 ? ` / He ${c.residualHe}%` : ""}
                    </p>
                    <div className="queue-tags">
                      <HydroTag date={c.hydroDate} />
                      <span className="plan-pos">计划位置 #{pos}</span>
                      {c.lastFill && <span className="plan-pos">上次充填 {formatDateTime(c.lastFill.at).slice(5)}</span>}
                      {c.lastReject && <span className="reject-note" title={c.lastReject.reason}>上次被拦：{c.lastReject.reason}</span>}
                    </div>
                  </div>
                  <div className="queue-side">
                    <button
                      className={c.rush ? "rush-btn on" : "rush-btn"}
                      onClick={() => store.toggleRush(c.id)}
                      title={c.rush ? "取消加急，回到计划位置" : "临时加急，提到队首（原计划位置保留）"}
                    >
                      {c.rush ? "取消加急" : "加急"}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
          <p className="hint">默认按检验有效期最短优先排序；加急瓶按加急时间临时置顶，取消后回到原计划位置。</p>
        </section>

        {/* 右：当前充填批次 */}
        <section className="panel batch-panel">
          <div className="panel-head">
            <h2>当前充填批次</h2>
            <span className="muted-text">依据检验日期与上次余压计算目标压力和混合气比例</span>
          </div>

          {batchRows.length === 0 && (
            <p className="empty">从左侧队列勾选气瓶加入本批次后，这里会给出每个瓶的配气方案。</p>
          )}

          <div className="batch-list">
            {batchRows.map(({ item, cyl, plan }) => {
              if (!cyl || !plan) return null;
              const rejectText = rejectDrafts[item.cylId] ?? plan.errors.join("；");
              const canSign = plan.ok && state.operator.trim() && item.actualPressure > 0 && confirmedSign[item.cylId];
              return (
                <article key={item.cylId} className={`batch-card ${plan.ok ? "" : "has-error"}`}>
                  <div className="batch-head">
                    <div className="queue-title">
                      <h3>{item.cylId}</h3>
                      <Badge tone={labelTone(cyl.label)}>{LABEL_SPECS[cyl.label].name}</Badge>
                      <HydroTag date={cyl.hydroDate} />
                      <Badge tone="muted">{cyl.volumeL}L</Badge>
                    </div>
                    <span className="muted-text">
                      余压 {cyl.residualPressure} bar · 残气 O₂ {cyl.residualO2}%
                      {cyl.residualHe > 0 ? ` / He ${cyl.residualHe}%` : ""}
                    </span>
                  </div>

                  <div className="presets">
                    {PRESETS.map((p) => (
                      <button
                        key={p.key}
                        className={item.targetO2 === p.o2 && item.targetHe === p.he ? "chip on" : "chip"}
                        onClick={() => applyPreset(item, p.o2, p.he)}
                        disabled={p.he > 0 && !LABEL_SPECS[cyl.label].allowsHe}
                        title={p.he > 0 && !LABEL_SPECS[cyl.label].allowsHe ? LABEL_SPECS[cyl.label].blurb : undefined}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>

                  <div className="batch-grid">
                    <div className="batch-col">
                      <h4>目标（计划）</h4>
                      <div className="field-row">
                        <NumField label="目标压力" value={item.targetPressure} min={0} max={cyl.workingPressure}
                          onChange={(n) => setTargetPressure(item, n)} suffix="bar" width="120px" />
                        <NumField label="目标 O₂" value={item.targetO2} min={1} max={100}
                          onChange={(n) => {
                            patchItem(item.cylId, { targetO2: n, actualO2: n });
                          }} suffix="%" width="100px" />
                        <NumField label="目标 He" value={item.targetHe} min={0} max={99}
                          onChange={(n) => {
                            patchItem(item.cylId, { targetHe: n, actualHe: n });
                          }} suffix="%" width="100px" />
                      </div>
                    </div>
                    <div className="batch-col">
                      <h4>实测（签收）</h4>
                      <div className="field-row">
                        <NumField label="实际压力" value={item.actualPressure} min={0}
                          onChange={(n) => patchItem(item.cylId, { actualPressure: n })} suffix="bar" width="120px" />
                        <NumField label="实测 O₂" value={item.actualO2} min={0} max={100}
                          onChange={(n) => patchItem(item.cylId, { actualO2: n })} suffix="%" width="100px" />
                        <NumField label="实测 He" value={item.actualHe} min={0} max={100}
                          onChange={(n) => patchItem(item.cylId, { actualHe: n })} suffix="%" width="100px" />
                      </div>
                    </div>
                  </div>

                  {plan.ok ? (
                    <div className="plan-ok">
                      <strong>{plan.gasKind}充装配算</strong>
                      <span>目标压力 <b>{plan.targetPressure} bar</b></span>
                      <span>最终比例 <b>O₂ {plan.targetO2}%{plan.targetHe > 0 ? ` / He ${plan.targetHe}%` : ""}</b></span>
                      <span>充氦 <b>{plan.addHe} bar</b></span>
                      <span>充纯氧 <b>{plan.addO2} bar</b></span>
                      <span>空气补压 <b>{plan.addAir} bar</b></span>
                    </div>
                  ) : (
                    <div className="plan-errors">
                      {plan.errors.map((e, i) => <p key={i}>⛔ {e}</p>)}
                    </div>
                  )}
                  {plan.warnings.length > 0 && (
                    <div className="plan-warnings">
                      {plan.warnings.map((w, i) => <p key={i}>⚠️ {w}</p>)}
                    </div>
                  )}

                  <div className="batch-foot">
                    {plan.ok ? (
                      <>
                        <label className="confirm-check">
                          <input
                            type="checkbox"
                            checked={!!confirmedSign[item.cylId]}
                            onChange={(e) =>
                              setConfirmedSign((m) => ({ ...m, [item.cylId]: e.target.checked }))
                            }
                          />
                          我确认 {item.cylId} 已按方案充填完成
                        </label>
                        <button className="primary" disabled={!canSign} onClick={() => doSignOff(item.cylId)}>
                          签收{state.operator ? `（${state.operator}）` : ""}
                        </button>
                      </>
                    ) : (
                      <div className="reject-box">
                        <input
                          value={rejectText}
                          onChange={(e) => setRejectDrafts((m) => ({ ...m, [item.cylId]: e.target.value }))}
                          placeholder="写明移出原因"
                        />
                        <button className="danger" onClick={() => doReject(item.cylId)}>移出本批次并回队列</button>
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      </div>

      {/* 底部：登记 + 历史 + 台账 */}
      <div className="lower-grid">
        {/* 登记 / 再次到店 */}
        <IntakeForm onSubmit={(input) => {
          const { isNew } = store.enqueue(input);
          setIntakeMsg(isNew ? `${input.id} 已建档并入队` : `${input.id} 是回头瓶，已更新余压并入队，旧记录保留`);
        }} message={intakeMsg} />

        {/* 单瓶历史 */}
        <section className="panel">
          <div className="panel-head"><h2>单瓶历史记录</h2></div>
          <div className="history-search">
            <input value={historyQuery} onChange={(e) => setHistoryQuery(e.target.value)} placeholder="输入气瓶编号，如 TANK-104" />
            <div className="quick-tags">
              {quickIds.map((id) => (
                <button key={id} className="chip" onClick={() => setHistoryQuery(id)}>{id}</button>
              ))}
            </div>
          </div>
          {historyQuery.trim() && !historyCyl && <p className="empty">没有找到 {historyQuery.trim().toUpperCase()} 的档案</p>}
          {historyCyl && (
            <div className="history-body">
              <p className="history-info">
                <Badge tone={labelTone(historyCyl.label)}>{LABEL_SPECS[historyCyl.label].name}</Badge>
                {" "}{historyCyl.volumeL}L · 工作压力 {historyCyl.workingPressure} bar · <HydroTag date={historyCyl.hydroDate} />
                {" "}当前余压 {historyCyl.residualPressure} bar / O₂ {historyCyl.residualO2}%
                {historyCyl.residualHe ? ` / He ${historyCyl.residualHe}%` : ""}
                {historyCyl.enqueued ? <Badge tone="warn">在队列中</Badge> : <Badge tone="muted">不在队列</Badge>}
              </p>
              <h4>签收记录（{historyReceipts.length}）</h4>
              {historyReceipts.length === 0 && <p className="empty">暂无签收单</p>}
              {historyReceipts.map((r) => (
                <div key={r.id} className="history-row">
                  <div>
                    <b>{formatDateTime(r.signedAt)}</b> · {r.operator} · {r.gasKind}
                  </div>
                  <div className="muted-text">
                    实际 {r.actualPressure} bar · O₂ {r.actualO2}%{r.actualHe ? ` / He ${r.actualHe}%` : ""}
                    {" "}（目标 {r.targetPressure} bar · O₂ {r.targetO2}%{r.targetHe ? ` / He ${r.targetHe}%` : ""}）
                  </div>
                  <div className="muted-text small">
                    配气：氦 {r.addHe} bar · 纯氧 {r.addO2} bar · 空气补压 {r.addAir} bar
                  </div>
                </div>
              ))}
              <h4>拦截记录（{historyRejects.length}）</h4>
              {historyRejects.length === 0 && <p className="empty">暂无拦截记录</p>}
              {historyRejects.map((j) => (
                <div key={j.id} className="history-row reject-row">
                  <b>{formatDateTime(j.at)}</b> · {j.operator} · 申请：{j.requested}
                  <div>{j.reason}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* 签收台账 */}
      <section className="panel ledger">
        <div className="panel-head">
          <h2>签收单台账</h2>
          <span className="muted-text">共 {state.receipts.length} 张，同一气瓶的每次充填都可在“单瓶历史”中追溯</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>签收时间</th><th>气瓶编号</th><th>操作员</th><th>气体</th>
                <th>实际压力</th><th>混合比例</th><th>目标压力/比例</th><th>充入分压（He/O₂/空气）</th>
              </tr>
            </thead>
            <tbody>
              {state.receipts.length === 0 && (
                <tr><td colSpan={8} className="empty">还没有签收单</td></tr>
              )}
              {state.receipts.map((r) => (
                <tr key={r.id}>
                  <td>{formatDateTime(r.signedAt)}</td>
                  <td><button className="link-btn" onClick={() => setHistoryQuery(r.cylId)}>{r.cylId}</button></td>
                  <td>{r.operator}</td>
                  <td>{r.gasKind}</td>
                  <td><b>{r.actualPressure} bar</b></td>
                  <td>O₂ {r.actualO2}%{r.actualHe ? ` / He ${r.actualHe}%` : ""}</td>
                  <td>{r.targetPressure} bar · O₂ {r.targetO2}%{r.targetHe ? ` / He ${r.targetHe}%` : ""}</td>
                  <td>{r.addHe} / {r.addO2} / {r.addAir} bar</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 拦截留痕 */}
      {state.rejections.length > 0 && (
        <section className="panel ledger">
          <div className="panel-head"><h2>批次拦截记录</h2><span className="muted-text">移出当前充填批次的气瓶及原因</span></div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>时间</th><th>气瓶编号</th><th>操作员</th><th>本次申请</th><th>移出原因</th></tr>
              </thead>
              <tbody>
                {state.rejections.map((j) => (
                  <tr key={j.id}>
                    <td>{formatDateTime(j.at)}</td>
                    <td><button className="link-btn" onClick={() => setHistoryQuery(j.cylId)}>{j.cylId}</button></td>
                    <td>{j.operator}</td>
                    <td>{j.requested}</td>
                    <td className="reason-cell">{j.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <footer className="app-foot">
        数据保存在本机浏览器（localStorage）：刷新或关闭页面后，队列位置、加急状态与签收单都会保留。
        配气按分压法估算（空气按 O₂ {AIR_O2}% 计），实际充填请以氧分析仪实测为准。
      </footer>
    </main>
  );
}

/* --------------------------- 登记/再次到店 --------------------------- */

function IntakeForm({ onSubmit, message }: { onSubmit: (input: import("./types").EnqueueInput) => void; message: string | null }) {
  const [id, setId] = useState("");
  const [volumeL, setVolumeL] = useState(12);
  const [label, setLabel] = useState<Label>("NITROX");
  const [wp, setWp] = useState(232);
  const [hydro, setHydro] = useState(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().slice(0, 10);
  });
  const [resP, setResP] = useState(30);
  const [resO2, setResO2] = useState(21);
  const [resHe, setResHe] = useState(0);

  const submit = () => {
    const trimmed = id.trim().toUpperCase();
    if (!trimmed) return;
    onSubmit({
      id: trimmed,
      volumeL,
      label,
      workingPressure: wp,
      hydroDate: hydro,
      residualPressure: resP,
      residualO2: label === "AIR" ? 21 : resO2,
      residualHe: label === "TRIMIX" ? resHe : 0,
    });
    setId("");
  };

  return (
    <section className="panel">
      <div className="panel-head"><h2>气瓶登记 / 再次到店</h2></div>
      <p className="muted-text small">已存在的编号会按回头瓶处理：更新余压并重新入队，历史签收单保留。</p>
      <div className="intake-grid">
        <label><span>气瓶编号 *</span><input value={id} onChange={(e) => setId(e.target.value)} placeholder="TANK-xxx" /></label>
        <label><span>容积 (L)</span><input type="number" value={volumeL} onChange={(e) => setVolumeL(Number(e.target.value))} /></label>
        <label>
          <span>气瓶标识</span>
          <select value={label} onChange={(e) => setLabel(e.target.value as Label)}>
            <option value="AIR">空气瓶（O₂ ≤ 21%）</option>
            <option value="NITROX">高氧气瓶（O₂ ≤ 40%）</option>
            <option value="TRIMIX">Trimix 瓶（可含氦）</option>
          </select>
        </label>
        <label><span>工作压力 (bar)</span><input type="number" value={wp} onChange={(e) => setWp(Number(e.target.value))} /></label>
        <label><span>检验有效期</span><input type="date" value={hydro} onChange={(e) => setHydro(e.target.value)} /></label>
        <label><span>上次余压 (bar)</span><input type="number" value={resP} onChange={(e) => setResP(Number(e.target.value))} /></label>
        <label>
          <span>残气 O₂ (%)</span>
          <input type="number" value={label === "AIR" ? 21 : resO2} disabled={label === "AIR"}
            onChange={(e) => setResO2(Number(e.target.value))} />
        </label>
        <label>
          <span>残气 He (%)</span>
          <input type="number" value={label === "TRIMIX" ? resHe : 0} disabled={label !== "TRIMIX"}
            onChange={(e) => setResHe(Number(e.target.value))} />
        </label>
      </div>
      <div className="intake-foot">
        <button className="primary" onClick={submit} disabled={!id.trim()}>入队</button>
        {message && <span className="ok-msg">{message}</span>}
      </div>
    </section>
  );
}
