import { useEffect, useMemo, useState } from "react";
import "./styles.css";
import {
  AIR_O2,
  GAS_PRESETS,
  GAS_TYPE_NAME,
  LABEL_NAME,
  blockReason,
  computeRecipe,
  daysUntil,
  validateFill,
} from "./fill";
import {
  loadState,
  newRecordId,
  nextPlanPosition,
  resetState,
  saveState,
} from "./storage";
import type {
  CylinderLabel,
  FillRecord,
  FillRequest,
  GasType,
  PersistState,
  Tank,
} from "./types";

type StatusTab = "QUEUED" | "REMOVED" | "FILLED";
type BottomTab = "RECEIPTS" | "HISTORY" | "NEW";

interface FillForm {
  gasType: GasType;
  targetPressure: number;
  targetO2: number;
  targetHe: number;
}

function todayText(): string {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

function formatSignedAt(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

function defaultForm(tank: Tank): FillForm {
  const gasType: GasType =
    tank.label === "AIR" ? "AIR" : tank.label === "NITROX" ? "NITROX" : "TRIMIX";
  const preset = GAS_PRESETS[gasType];
  return {
    gasType,
    targetPressure: Math.min(tank.ratedPressure, 200),
    targetO2: preset.o2,
    targetHe: preset.he,
  };
}

export default function App() {
  const [state, setState] = useState<PersistState>(() => loadState());
  const [operator, setOperator] = useState<string>(
    () => localStorage.getItem("dive-fillstation-operator") ?? ""
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FillForm | null>(null);
  const [readyTankId, setReadyTankId] = useState<string | null>(null);
  const [statusTab, setStatusTab] = useState<StatusTab>("QUEUED");
  const [bottomTab, setBottomTab] = useState<BottomTab>("RECEIPTS");
  const [historyQuery, setHistoryQuery] = useState("");
  const [signing, setSigning] = useState<{ actual: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // 关掉页面再打开：队列与签收结果全部来自 localStorage
  useEffect(() => {
    saveState(state);
  }, [state]);

  useEffect(() => {
    localStorage.setItem("dive-fillstation-operator", operator);
  }, [operator]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const tanks = state.tanks;
  const records = state.records;

  const selected = tanks.find((t) => t.id === selectedId) ?? null;

  // 默认先排检验期最短的气瓶；加急瓶置顶，原计划位置保留
  const { queueOrder, planMap } = useMemo(() => {
    const queued = tanks.filter((t) => t.status === "QUEUED");
    const withDays = queued.map((t) => ({
      t,
      key: daysUntil(t.inspectionDate),
    }));
    const plan = new Map(
      [...withDays]
        .sort((a, b) => a.key - b.key || a.t.id.localeCompare(b.t.id))
        .map((x, i) => [x.t.id, i + 1])
    );
    const ordered = [...queued].sort((a, b) => {
      if (a.expedited !== b.expedited) return a.expedited ? -1 : 1;
      if (a.expedited && b.expedited) {
        return (a.expeditedAt ?? "").localeCompare(b.expeditedAt ?? "");
      }
      // 非加急：按检验期升序的计划位置
      const pa = plan.get(a.id) ?? a.planPosition;
      const pb = plan.get(b.id) ?? b.planPosition;
      return pa - pb;
    });
    return { queueOrder: ordered, planMap: plan };
  }, [tanks]);

  const removedTanks = tanks
    .filter((t) => t.status === "REMOVED")
    .sort((a, b) => (b.removedAt ?? "").localeCompare(a.removedAt ?? ""));
  const filledTanks = tanks.filter((t) => t.status === "FILLED");

  const todayPrefix = new Date().toISOString().slice(0, 10);
  const metrics = {
    queued: tanks.filter((t) => t.status === "QUEUED").length,
    expiring: tanks.filter(
      (t) => t.status === "QUEUED" && daysUntil(t.inspectionDate) <= 30
    ).length,
    todaySigned: records.filter((r) => r.signedAt.startsWith(todayPrefix)).length,
    totalReceipts: records.length,
  };

  // ---- 选中气瓶 ----------------------------------------------------------
  function selectTank(tank: Tank) {
    setSelectedId(tank.id);
    setForm(defaultForm(tank));
    setReadyTankId(null);
  }

  function patchSelected(patch: Partial<Tank>) {
    if (!selected) return;
    setState((s) => ({
      ...s,
      tanks: s.tanks.map((t) =>
        t.id === selected.id ? { ...t, ...patch } : t
      ),
    }));
    setReadyTankId(null);
  }

  // ---- 加急：置顶，但原计划位置不动 --------------------------------------
  function toggleExpedite(tank: Tank) {
    setState((s) => ({
      ...s,
      tanks: s.tanks.map((t) =>
        t.id === tank.id
          ? t.expedited
            ? { ...t, expedited: false, expeditedAt: undefined }
            : { ...t, expedited: true, expeditedAt: new Date().toISOString() }
          : t
      ),
    }));
  }

  // ---- 校验：block 级问题直接移出当前批次并写明原因 ----------------------
  function runCheck() {
    if (!selected || !form) return;
    const req: FillRequest = form;
    const items = validateFill(selected, req);
    const blocks = items.filter((i) => i.level === "block");
    if (blocks.length > 0) {
      const reason = blockReason(items);
      setState((s) => ({
        ...s,
        tanks: s.tanks.map((t) =>
          t.id === selected.id
            ? {
                ...t,
                status: "REMOVED",
                removeReason: reason,
                removedAt: new Date().toISOString(),
                expedited: false,
                expeditedAt: undefined,
              }
            : t
        ),
      }));
      setStatusTab("REMOVED");
      setToast(`气瓶 ${selected.id} 已移出本批次`);
      setSelectedId(null);
      setForm(null);
      setReadyTankId(null);
      return;
    }
    setReadyTankId(selected.id);
    setToast("校验通过，可以充填");
  }

  // ---- 签收 --------------------------------------------------------------
  function confirmSign(actual: number) {
    if (!selected || !form || !operator.trim()) return;
    const recipe = computeRecipe(selected, form);
    const record: FillRecord = {
      id: newRecordId(),
      tankId: selected.id,
      signedAt: new Date().toISOString(),
      operator: operator.trim(),
      gasType: form.gasType,
      targetPressure: form.targetPressure,
      actualPressure: actual,
      targetO2: form.targetO2,
      targetHe: form.targetHe,
      residualPressure: selected.residualPressure,
      airAdd: recipe.airAdd,
      o2Add: recipe.o2Add,
      heAdd: recipe.heAdd,
    };
    setState((s) => ({
      records: [record, ...s.records],
      tanks: s.tanks.map((t) =>
        t.id === selected.id
          ? {
              ...t,
              status: "FILLED",
              residualPressure: actual,
              residualO2: form.targetO2,
              residualHe: form.targetHe,
              expedited: false,
              expeditedAt: undefined,
              removeReason: undefined,
              removedAt: undefined,
            }
          : t
      ),
    }));
    setSigning(null);
    setStatusTab("FILLED");
    setBottomTab("RECEIPTS");
    setToast(`已签收：${selected.id} · 单号 ${record.id}`);
    setSelectedId(null);
    setForm(null);
    setReadyTankId(null);
  }

  // ---- 移出瓶恢复 / 已签收瓶重新入队 -------------------------------------
  function restoreTank(tank: Tank) {
    setState((s) => ({
      ...s,
      tanks: s.tanks.map((t) =>
        t.id === tank.id
          ? {
              ...t,
              status: "QUEUED",
              removeReason: undefined,
              removedAt: undefined,
            }
          : t
      ),
    }));
    setStatusTab("QUEUED");
    setToast(`${tank.id} 已重新加入批次`);
  }

  function requeue(tank: Tank) {
    setState((s) => ({
      ...s,
      tanks: s.tanks.map((t) =>
        t.id === tank.id
          ? {
              ...t,
              status: "QUEUED",
              expedited: false,
              expeditedAt: undefined,
              planPosition: nextPlanPosition(s.tanks),
            }
          : t
      ),
    }));
    setStatusTab("QUEUED");
    setToast(`${tank.id} 已重新排入待充填队列`);
  }

  const liveItems =
    selected && form ? validateFill(selected, form) : [];
  const liveBlocks = liveItems.filter((i) => i.level === "block");
  const liveWarns = liveItems.filter((i) => i.level === "warn");
  const recipe = selected && form ? computeRecipe(selected, form) : null;

  const sortedRecords = [...records].sort((a, b) =>
    b.signedAt.localeCompare(a.signedAt)
  );

  const historyTank =
    tanks.find((t) => t.id.toUpperCase() === historyQuery.trim().toUpperCase()) ??
    null;
  const historyRecords = historyQuery.trim()
    ? sortedRecords.filter(
        (r) => r.tankId.toUpperCase() === historyQuery.trim().toUpperCase()
      )
    : [];

  function handleResetDemo() {
    if (window.confirm("确定恢复演示数据？当前所有队列与签收记录将被覆盖。")) {
      setState(resetState());
      setSelectedId(null);
      setForm(null);
      setReadyTankId(null);
      setToast("已恢复演示数据");
    }
  }

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <p className="kicker">潜水店充填作业台</p>
          <h1>气瓶充填签收系统</h1>
          <span className="clock">{todayText()}</span>
        </div>
        <div className="operator-box">
          <label>
            <span>当班操作员</span>
            <input
              value={operator}
              onChange={(e) => setOperator(e.target.value)}
              placeholder="签收前请填写姓名"
            />
          </label>
          <button className="ghost" onClick={handleResetDemo} title="恢复演示数据">
            重置演示
          </button>
        </div>
      </header>

      <section className="metrics">
        <article>
          <small>待充填</small>
          <strong>{metrics.queued}</strong>
        </article>
        <article className={metrics.expiring > 0 ? "alert" : ""}>
          <small>30天内到期（含过期）</small>
          <strong>{metrics.expiring}</strong>
        </article>
        <article>
          <small>今日签收</small>
          <strong>{metrics.todaySigned}</strong>
        </article>
        <article>
          <small>累计签收单</small>
          <strong>{metrics.totalReceipts}</strong>
        </article>
      </section>

      <section className="workspace">
        {/* 左：批次队列 */}
        <div className="panel queue-panel">
          <div className="tabs">
            {(
              [
                ["QUEUED", `待充填 (${tanks.filter((t) => t.status === "QUEUED").length})`],
                ["REMOVED", `已移出 (${removedTanks.length})`],
                ["FILLED", `已签收 (${filledTanks.length})`],
              ] as [StatusTab, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                className={"tab" + (statusTab === key ? " active" : "")}
                onClick={() => setStatusTab(key)}
              >
                {label}
              </button>
            ))}
          </div>

          {statusTab === "QUEUED" && (
            <div className="queue">
              {queueOrder.length === 0 && <p className="empty">队列为空</p>}
              {queueOrder.map((tank, idx) => {
                const days = daysUntil(tank.inspectionDate);
                return (
                  <article
                    key={tank.id}
                    className={
                      "queue-card" +
                      (selectedId === tank.id ? " selected" : "") +
                      (tank.expedited ? " rushed" : "")
                    }
                    onClick={() => selectTank(tank)}
                  >
                    <div className="queue-head">
                      <b className="pos">#{idx + 1}</b>
                      <h3>{tank.id}</h3>
                      {tank.expedited && <span className="badge rush">加急</span>}
                      <span className={"badge " + tank.label}>
                        {LABEL_NAME[tank.label].replace("标识", "")}
                      </span>
                      <button
                        className="link"
                        title={tank.expedited ? "取消加急，回到原计划位置" : "临时加急，提到队首"}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpedite(tank);
                        }}
                      >
                        {tank.expedited ? "取消加急" : "加急"}
                      </button>
                    </div>
                    <p className="queue-desc">{tank.description}</p>
                    <p className="queue-meta">
                      <span>余压 {tank.residualPressure} bar</span>
                      <span>额定 {tank.ratedPressure} bar</span>
                      <span
                        className={
                          days < 0 ? "danger" : days <= 30 ? "warning" : "ok"
                        }
                      >
                        检验 {tank.inspectionDate}
                        {days < 0
                          ? `（已过期${-days}天）`
                          : `（剩${days}天）`}
                      </span>
                      {tank.expedited && (
                        <span className="plan-note">
                          原计划位置 #{planMap.get(tank.id) ?? "?"}
                        </span>
                      )}
                    </p>
                  </article>
                );
              })}
            </div>
          )}

          {statusTab === "REMOVED" && (
            <div className="queue">
              {removedTanks.length === 0 && (
                <p className="empty">本批次没有被移出的气瓶</p>
              )}
              {removedTanks.map((tank) => (
                <article key={tank.id} className="queue-card removed">
                  <div className="queue-head">
                    <h3>{tank.id}</h3>
                    <span className="badge danger-badge">已移出批次</span>
                  </div>
                  <p className="queue-desc">{tank.description}</p>
                  <p className="reason">原因：{tank.removeReason}</p>
                  <p className="queue-meta">
                    <span>{tank.removedAt && formatSignedAt(tank.removedAt)}</span>
                  </p>
                  <div className="row-actions">
                    <button onClick={() => restoreTank(tank)}>
                      处理后重新加入批次
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}

          {statusTab === "FILLED" && (
            <div className="queue">
              {filledTanks.length === 0 && (
                <p className="empty">还没有签收完成的气瓶</p>
              )}
              {filledTanks.map((tank) => {
                const last = records.find((r) => r.tankId === tank.id);
                return (
                  <article key={tank.id} className="queue-card filled">
                    <div className="queue-head">
                      <h3>{tank.id}</h3>
                      <span className="badge ok-badge">已签收</span>
                    </div>
                    <p className="queue-desc">
                      {last
                        ? `${GAS_TYPE_NAME[last.gasType]} · ${last.actualPressure}bar · O₂ ${last.targetO2}%${
                            last.targetHe > 0 ? ` / He ${last.targetHe}%` : ""
                          }`
                        : tank.description}
                    </p>
                    <p className="queue-meta">
                      <span>{tank.description}</span>
                      <span>当前压力 {tank.residualPressure} bar</span>
                    </p>
                    <div className="row-actions">
                      <button
                        onClick={() => {
                          setHistoryQuery(tank.id);
                          setBottomTab("HISTORY");
                        }}
                      >
                        查看历史记录
                      </button>
                      <button onClick={() => requeue(tank)}>再次来充，重新入队</button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>

        {/* 右：充填计算与签收 */}
        <div className="panel fill-panel">
          {!selected || !form ? (
            <div className="placeholder">
              <h2>充填作业</h2>
              <p>从左侧待充填队列点选一个气瓶，系统将依据检验日期与上次余压：</p>
              <ul>
                <li>按空气 / 高氧 / Trimix 计算目标压力与混合气配气比例</li>
                <li>检验过期、氧含量与瓶体标识不符时自动移出批次并写明原因</li>
                <li>确认完成后由操作员签收，记录永久保留、可按气瓶编号追溯</li>
              </ul>
            </div>
          ) : (
            <>
              <div className="fill-head">
                <div>
                  <p className="kicker">当前作业气瓶</p>
                  <h2>{selected.id}</h2>
                  <span>{selected.description} · {selected.volume}L · 额定 {selected.ratedPressure}bar</span>
                </div>
                <button className="ghost" onClick={() => { setSelectedId(null); setForm(null); setReadyTankId(null); }}>
                  取消选择
                </button>
              </div>

              <div className="card-section">
                <h3>① 复测数据（上次余压可现场修正）</h3>
                <div className="field-grid">
                  <label>
                    <span>余压 bar</span>
                    <input
                      type="number"
                      value={selected.residualPressure}
                      min={0}
                      onChange={(e) =>
                        patchSelected({ residualPressure: Number(e.target.value) })
                      }
                    />
                  </label>
                  <label>
                    <span>残气 O₂ %</span>
                    <input
                      type="number"
                      step={0.1}
                      value={selected.residualO2}
                      onChange={(e) =>
                        patchSelected({ residualO2: Number(e.target.value) })
                      }
                    />
                  </label>
                  <label>
                    <span>残气 He %</span>
                    <input
                      type="number"
                      step={0.1}
                      value={selected.residualHe}
                      onChange={(e) =>
                        patchSelected({ residualHe: Number(e.target.value) })
                      }
                    />
                  </label>
                  <label className="static-field">
                    <span>瓶体标识 / 检验期</span>
                    <div>
                      {LABEL_NAME[selected.label]} · {selected.inspectionDate}
                    </div>
                  </label>
                </div>
              </div>

              <div className="card-section">
                <h3>② 选择充填气种与目标</h3>
                <div className="gas-switch">
                  {(Object.keys(GAS_TYPE_NAME) as GasType[]).map((g) => (
                    <button
                      key={g}
                      className={"gas-btn" + (form.gasType === g ? " active" : "")}
                      onClick={() => {
                        const preset = GAS_PRESETS[g];
                        setForm({
                          ...form,
                          gasType: g,
                          targetO2: preset.o2,
                          targetHe: preset.he,
                        });
                        setReadyTankId(null);
                      }}
                    >
                      {GAS_TYPE_NAME[g]}
                    </button>
                  ))}
                </div>
                <div className="field-grid">
                  <label>
                    <span>目标压力 bar（≤额定 {selected.ratedPressure}）</span>
                    <input
                      type="number"
                      value={form.targetPressure}
                      max={selected.ratedPressure}
                      onChange={(e) => {
                        setForm({ ...form, targetPressure: Number(e.target.value) });
                        setReadyTankId(null);
                      }}
                    />
                  </label>
                  <label>
                    <span>目标 O₂ %</span>
                    <input
                      type="number"
                      step={0.1}
                      value={form.targetO2}
                      onChange={(e) => {
                        setForm({ ...form, targetO2: Number(e.target.value) });
                        setReadyTankId(null);
                      }}
                    />
                  </label>
                  <label>
                    <span>目标 He %{form.gasType !== "TRIMIX" && "（Trimix 专用）"}</span>
                    <input
                      type="number"
                      step={0.1}
                      disabled={form.gasType !== "TRIMIX"}
                      value={form.gasType === "TRIMIX" ? form.targetHe : 0}
                      onChange={(e) => {
                        setForm({ ...form, targetHe: Number(e.target.value) });
                        setReadyTankId(null);
                      }}
                    />
                  </label>
                </div>
              </div>

              <div className="card-section">
                <h3>③ 配气方案（先加氦 → 再加氧 → 空气补压）</h3>
                {recipe && (
                  <div className="recipe">
                    <div className={"recipe-row " + (recipe.feasible ? "good" : "bad")}>
                      <span>氦气 He</span>
                      <strong>{recipe.heAdd} bar</strong>
                    </div>
                    <div className={"recipe-row " + (recipe.feasible ? "good" : "bad")}>
                      <span>纯氧 O₂</span>
                      <strong>{recipe.o2Add} bar</strong>
                    </div>
                    <div className={"recipe-row " + (recipe.feasible ? "good" : "bad")}>
                      <span>空气（含 O₂ {AIR_O2 * 100}%）</span>
                      <strong>{recipe.airAdd} bar</strong>
                    </div>
                    <div className="recipe-row total">
                      <span>充填总量</span>
                      <strong>
                        {Math.round(
                          (recipe.heAdd + recipe.o2Add + recipe.airAdd) * 10
                        ) / 10}{" "}
                        bar（余压 {selected.residualPressure} → {form.targetPressure}）
                      </strong>
                    </div>
                    {!recipe.feasible && (
                      <p className="danger-text">
                        当前残气成分无法直接补到目标比例，需先泄放至 ≤{" "}
                        {recipe.drainToBar} bar 后重新计算。
                      </p>
                    )}
                  </div>
                )}

                <div className="checks">
                  {liveBlocks.map((c, i) => (
                    <p key={"b" + i} className="check block">⛔ {c.message}</p>
                  ))}
                  {liveWarns.map((c, i) => (
                    <p key={"w" + i} className="check warn">⚠️ {c.message}</p>
                  ))}
                  {liveBlocks.length === 0 && liveWarns.length === 0 && (
                    <p className="check ok">✅ 检验有效，氧/氦含量与瓶体标识相符</p>
                  )}
                </div>
              </div>

              <div className="card-section actions">
                <button className="primary" onClick={runCheck}>
                  执行充填校验
                </button>
                <button
                  className="success"
                  disabled={
                    readyTankId !== selected.id ||
                    !recipe?.feasible ||
                    !operator.trim()
                  }
                  onClick={() =>
                    setSigning({ actual: form.targetPressure })
                  }
                  title={
                    !operator.trim()
                      ? "请先在右上角填写当班操作员"
                      : readyTankId !== selected.id
                      ? "请先执行充填校验"
                      : !recipe?.feasible
                      ? "配气方案不可行，请先泄放"
                      : ""
                  }
                >
                  充填完成，签收
                </button>
              </div>
            </>
          )}
        </div>
      </section>

      {/* 底部：签收单 / 单瓶历史 / 新增气瓶 */}
      <section className="panel bottom-panel">
        <div className="tabs">
          <button
            className={"tab" + (bottomTab === "RECEIPTS" ? " active" : "")}
            onClick={() => setBottomTab("RECEIPTS")}
          >
            签收单
          </button>
          <button
            className={"tab" + (bottomTab === "HISTORY" ? " active" : "")}
            onClick={() => setBottomTab("HISTORY")}
          >
            单瓶历史记录
          </button>
          <button
            className={"tab" + (bottomTab === "NEW" ? " active" : "")}
            onClick={() => setBottomTab("NEW")}
          >
            新到气瓶登记
          </button>
        </div>

        {bottomTab === "RECEIPTS" && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>签收单号</th>
                  <th>气瓶编号</th>
                  <th>时间</th>
                  <th>操作员</th>
                  <th>气种</th>
                  <th>实际压力</th>
                  <th>混合比例</th>
                  <th>配气（He/O₂/空气 bar）</th>
                </tr>
              </thead>
              <tbody>
                {sortedRecords.map((r) => (
                  <tr key={r.id}>
                    <td>{r.id}</td>
                    <td>
                      <button className="link" onClick={() => { setHistoryQuery(r.tankId); setBottomTab("HISTORY"); }}>
                        {r.tankId}
                      </button>
                    </td>
                    <td>{formatSignedAt(r.signedAt)}</td>
                    <td>{r.operator}</td>
                    <td>{GAS_TYPE_NAME[r.gasType]}</td>
                    <td>{r.actualPressure} bar</td>
                    <td>
                      O₂ {r.targetO2}%{r.targetHe > 0 ? ` / He ${r.targetHe}%` : ""}
                    </td>
                    <td>
                      {r.heAdd} / {r.o2Add} / {r.airAdd}
                    </td>
                  </tr>
                ))}
                {sortedRecords.length === 0 && (
                  <tr><td colSpan={8} className="empty">暂无签收单</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {bottomTab === "HISTORY" && (
          <div className="history">
            <div className="history-search">
              <input
                placeholder="输入气瓶编号查询，如 TANK-204"
                value={historyQuery}
                onChange={(e) => setHistoryQuery(e.target.value)}
              />
            </div>
            {historyQuery.trim() === "" ? (
              <p className="empty">输入编号后可追溯该瓶所有历史充填记录</p>
            ) : !historyTank ? (
              <p className="empty">未找到编号 {historyQuery} 的气瓶</p>
            ) : (
              <>
                <div className="history-head">
                  <h3>{historyTank.id}</h3>
                  <span>{historyTank.description}</span>
                  <span className={"badge " + historyTank.label}>
                    {LABEL_NAME[historyTank.label]}
                  </span>
                  <span>检验有效期：{historyTank.inspectionDate}</span>
                </div>
                {historyRecords.length === 0 ? (
                  <p className="empty">该气瓶还没有签收记录</p>
                ) : (
                  <div className="timeline">
                    {historyRecords.map((r) => (
                      <div key={r.id} className="timeline-item">
                        <div className="dot" />
                        <div>
                          <strong>{formatSignedAt(r.signedAt)}</strong>
                          <p>
                            {r.operator} 签收 · {GAS_TYPE_NAME[r.gasType]} ·
                            余压 {r.residualPressure}bar → 实际 {r.actualPressure}bar ·
                            O₂ {r.targetO2}%{r.targetHe > 0 ? ` / He ${r.targetHe}%` : ""}
                          </p>
                          <p className="muted">
                            配气：氦 {r.heAdd}bar / 氧 {r.o2Add}bar / 空气 {r.airAdd}bar · 单号 {r.id}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {bottomTab === "NEW" && (
          <NewTankForm
            onCreate={(tank) => {
              setState((s) => ({
                ...s,
                tanks: [...s.tanks, { ...tank, planPosition: nextPlanPosition(s.tanks) }],
              }));
              setToast(`${tank.id} 已登记并排到队尾`);
              setStatusTab("QUEUED");
            }}
            existingIds={tanks.map((t) => t.id)}
          />
        )}
      </section>

      {/* 签收确认弹窗 */}
      {signing && selected && form && (
        <div className="modal-mask" onClick={() => setSigning(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>充填完成签收</h2>
            <p className="muted">
              气瓶 {selected.id} · {GAS_TYPE_NAME[form.gasType]} · 目标 {form.targetPressure}bar
            </p>
            <div className="summary">
              <div><span>目标比例</span><strong>O₂ {form.targetO2}%{form.targetHe > 0 ? ` / He ${form.targetHe}%` : ""}</strong></div>
              <div><span>配气</span><strong>He {recipe?.heAdd} / O₂ {recipe?.o2Add} / 空气 {recipe?.airAdd} bar</strong></div>
              <div><span>操作员</span><strong>{operator}</strong></div>
            </div>
            <label className="actual-input">
              <span>实测充填压力 bar</span>
              <input
                type="number"
                value={signing.actual}
                autoFocus
                onChange={(e) => setSigning({ actual: Number(e.target.value) })}
              />
            </label>
            {Math.abs(signing.actual - form.targetPressure) > 10 && (
              <p className="warning-text">
                实测压力与目标相差 {Math.abs(signing.actual - form.targetPressure)}bar，请确认读数
              </p>
            )}
            <div className="modal-actions">
              <button onClick={() => setSigning(null)}>取消</button>
              <button
                className="success"
                disabled={signing.actual <= 0 || signing.actual > selected.ratedPressure + 5}
                onClick={() => confirmSign(signing.actual)}
              >
                确认签收
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

/* ---------------- 新到气瓶登记表单 ---------------- */

function NewTankForm({
  onCreate,
  existingIds,
}: {
  onCreate: (t: Tank) => void;
  existingIds: string[];
}) {
  const [id, setId] = useState("");
  const [description, setDescription] = useState("");
  const [volume, setVolume] = useState(12);
  const [ratedPressure, setRatedPressure] = useState(230);
  const [inspectionDate, setInspectionDate] = useState(
    new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10)
  );
  const [label, setLabel] = useState<CylinderLabel>("AIR");
  const [residualPressure, setResidualPressure] = useState(0);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const tid = id.trim().toUpperCase();
    if (!tid) return setError("请填写气瓶编号");
    if (existingIds.includes(tid)) return setError("该编号已存在，请直接在队列中查找");
    if (!description.trim()) return setError("请填写容积/瓶型描述");
    if (daysUntil(inspectionDate) < 0) return setError("检验日期已过期，不能登记入队");
    const preset =
      label === "AIR"
        ? { o2: 21, he: 0 }
        : label === "NITROX"
        ? { o2: 32, he: 0 }
        : { o2: 18, he: 35 };
    onCreate({
      id: tid,
      description: description.trim(),
      volume,
      ratedPressure,
      inspectionDate,
      label,
      residualPressure,
      residualO2: preset.o2,
      residualHe: preset.he,
      status: "QUEUED",
      expedited: false,
      planPosition: 0,
    });
    setId("");
    setDescription("");
    setResidualPressure(0);
    setError(null);
  }

  return (
    <div className="new-form">
      <div className="field-grid">
        <label>
          <span>气瓶编号</span>
          <input value={id} onChange={(e) => setId(e.target.value)} placeholder="TANK-xxx" />
        </label>
        <label>
          <span>瓶型描述</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="12L 铝瓶" />
        </label>
        <label>
          <span>水容积 L</span>
          <input type="number" value={volume} onChange={(e) => setVolume(Number(e.target.value))} />
        </label>
        <label>
          <span>额定压力 bar</span>
          <input type="number" value={ratedPressure} onChange={(e) => setRatedPressure(Number(e.target.value))} />
        </label>
        <label>
          <span>检验有效期</span>
          <input type="date" value={inspectionDate} onChange={(e) => setInspectionDate(e.target.value)} />
        </label>
        <label>
          <span>瓶体标识</span>
          <select value={label} onChange={(e) => setLabel(e.target.value as CylinderLabel)}>
            <option value="AIR">空气瓶标识</option>
            <option value="NITROX">高氧瓶标识（富氧兼容，≤40% O₂）</option>
            <option value="TRIMIX">Trimix 瓶标识（富氧兼容）</option>
          </select>
        </label>
        <label>
          <span>当前余压 bar</span>
          <input type="number" value={residualPressure} onChange={(e) => setResidualPressure(Number(e.target.value))} />
        </label>
      </div>
      {error && <p className="danger-text">{error}</p>}
      <div className="row-actions">
        <button className="primary" onClick={submit}>登记并入队（队尾）</button>
      </div>
    </div>
  );
}
