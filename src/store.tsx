import { useCallback, useEffect, useState } from "react";
import type {
  AppState,
  BatchItem,
  Cylinder,
  EnqueueInput,
  FillReceipt,
  Label,
  Rejection,
} from "./types";
import { daysFromNowISO, uid, todayISO } from "./fillLogic";

const STORAGE_KEY = "dive-fill-station-v1";

/* ----------------------------- 示例数据 ------------------------------ */

function seed(): AppState {
  const now = new Date().toISOString();
  const cyl = (c: Partial<Cylinder> & { id: string }): Cylinder => ({
    volumeL: 12,
    label: "NITROX",
    workingPressure: 232,
    hydroDate: todayISO(),
    residualPressure: 30,
    residualO2: 21,
    residualHe: 0,
    enqueued: true,
    rush: false,
    rushAt: null,
    lastReject: null,
    lastFill: null,
    createdAt: now,
    ...c,
  });

  const cylinders: Cylinder[] = [
    cyl({ id: "TANK-104", volumeL: 12, label: "NITROX", workingPressure: 232, hydroDate: daysFromNowISO(12), residualPressure: 55, residualO2: 21, rush: true, rushAt: Date.now() - 60_000 }),
    cyl({ id: "TANK-118", volumeL: 11, label: "AIR", workingPressure: 200, hydroDate: daysFromNowISO(40), residualPressure: 40, residualO2: 21 }),
    cyl({ id: "TANK-133", volumeL: 12, label: "NITROX", workingPressure: 232, hydroDate: daysFromNowISO(95), residualPressure: 60, residualO2: 32 }),
    cyl({ id: "TANK-177", volumeL: 10, label: "TRIMIX", workingPressure: 232, hydroDate: daysFromNowISO(-20), residualPressure: 25, residualO2: 18, residualHe: 45 }),
    cyl({ id: "TANK-192", volumeL: 12, label: "AIR", workingPressure: 200, hydroDate: daysFromNowISO(200), residualPressure: 30, residualO2: 32 }),
    cyl({ id: "TANK-205", volumeL: 24, label: "TRIMIX", workingPressure: 232, hydroDate: daysFromNowISO(160), residualPressure: 80, residualO2: 21, residualHe: 30 }),
    cyl({ id: "TANK-260", volumeL: 12, label: "TRIMIX", workingPressure: 200, hydroDate: daysFromNowISO(300), residualPressure: 170, residualO2: 21, residualHe: 35 }),
    cyl({ id: "TANK-088", volumeL: 11, label: "AIR", workingPressure: 200, hydroDate: daysFromNowISO(260), residualPressure: 0, residualO2: 21, enqueued: false }),
  ];

  const daysAgo = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString();
  };

  const receipts: FillReceipt[] = [
    {
      id: uid("F"), cylId: "TANK-104", volumeL: 12, label: "NITROX", gasKind: "高氧",
      targetPressure: 232, targetO2: 32, targetHe: 0,
      addHe: 0, addO2: 32.5, addAir: 144.5,
      actualPressure: 232, actualO2: 32, actualHe: 0,
      operator: "阿海", signedAt: daysAgo(42),
    },
    {
      id: uid("F"), cylId: "TANK-104", volumeL: 12, label: "NITROX", gasKind: "高氧",
      targetPressure: 220, targetO2: 36, targetHe: 0,
      addHe: 0, addO2: 41.2, addAir: 148.8,
      actualPressure: 220, actualO2: 36, actualHe: 0,
      operator: "小周", signedAt: daysAgo(18),
    },
    {
      id: uid("F"), cylId: "TANK-088", volumeL: 11, label: "AIR", gasKind: "空气",
      targetPressure: 200, targetO2: 21, targetHe: 0,
      addHe: 0, addO2: 0, addAir: 200,
      actualPressure: 200, actualO2: 21, actualHe: 0,
      operator: "阿海", signedAt: daysAgo(9),
    },
  ];

  // 用最近一次签收回填档案上的“上次充填”
  const lastFillById = new Map<string, FillReceipt>();
  for (const r of receipts) {
    if (!lastFillById.has(r.cylId)) {
      lastFillById.set(r.cylId, r);
    } else {
      const cur = lastFillById.get(r.cylId)!;
      if (r.signedAt > cur.signedAt) lastFillById.set(r.cylId, r);
    }
  }
  for (const c of cylinders) {
    const last = lastFillById.get(c.id);
    if (last) {
      c.lastFill = { pressure: last.actualPressure, o2: last.actualO2, he: last.actualHe, at: last.signedAt };
    }
  }

  return { cylinders, batch: [], receipts, rejections: [], operator: "阿海" };
}

/* ----------------------------- 持久化 -------------------------------- */

function load(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AppState;
      if (parsed && Array.isArray(parsed.cylinders)) {
        return { ...seed(), ...parsed };
      }
    }
  } catch {
    /* 数据损坏时回落到示例数据 */
  }
  return seed();
}

/* ------------------------------ Store -------------------------------- */

export function useFillStore() {
  const [state, setState] = useState<AppState>(load);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* 配额超限时忽略，页面仍可操作 */
    }
  }, [state]);

  const updateCyl = useCallback((id: string, patch: Partial<Cylinder>) => {
    setState((s) => ({
      ...s,
      cylinders: s.cylinders.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));
  }, []);

  /** 新瓶登记或旧瓶再次到店入队 */
  const enqueue = useCallback((input: EnqueueInput): { isNew: boolean } => {
    let isNew = false;
    setState((s) => {
      const existing = s.cylinders.find((c) => c.id === input.id);
      isNew = !existing;
      const now = new Date().toISOString();
      if (existing) {
        return {
          ...s,
          cylinders: s.cylinders.map((c) =>
            c.id === input.id
              ? {
                  ...c,
                  ...input,
                  enqueued: true,
                  rush: false,
                  rushAt: null,
                  lastReject: null,
                  createdAt: c.createdAt,
                }
              : c
          ),
          batch: s.batch.filter((b) => b.cylId !== input.id),
        };
      }
      const c: Cylinder = {
        ...input,
        enqueued: true,
        rush: false,
        rushAt: null,
        lastReject: null,
        lastFill: null,
        createdAt: now,
      };
      return { ...s, cylinders: [...s.cylinders, c] };
    });
    return { isNew };
  }, []);

  const addToBatch = useCallback((ids: string[]) => {
    setState((s) => {
      const additions: BatchItem[] = [];
      for (const id of ids) {
        if (s.batch.some((b) => b.cylId === id)) continue;
        const c = s.cylinders.find((x) => x.id === id);
        if (!c) continue;
        // 默认沿用残气配方续充；空气瓶默认空气；无残气的高氧/Trimix 瓶给常用默认值
        let targetO2 = 21;
        let targetHe = 0;
        if (c.label === "NITROX") targetO2 = c.residualO2 > 21 ? Math.round(c.residualO2) : 32;
        if (c.label === "TRIMIX") {
          if (c.residualHe > 0) {
            targetO2 = Math.round(c.residualO2);
            targetHe = Math.round(c.residualHe);
          } else if (c.residualO2 > 21) {
            targetO2 = Math.round(c.residualO2);
          } else {
            targetO2 = 21;
          }
        }
        const targetPressure = c.workingPressure;
        additions.push({
          cylId: id,
          targetO2,
          targetHe,
          targetPressure,
          actualPressure: targetPressure,
          actualO2: targetO2,
          actualHe: targetHe,
        });
      }
      if (additions.length === 0) return s;
      return {
        ...s,
        batch: [...s.batch, ...additions],
        cylinders: s.cylinders.map((c) =>
          additions.some((a) => a.cylId === c.id) ? { ...c, enqueued: false } : c
        ),
      };
    });
  }, []);

  const updateBatchItem = useCallback((cylId: string, patch: Partial<BatchItem>) => {
    setState((s) => ({
      ...s,
      batch: s.batch.map((b) => (b.cylId === cylId ? { ...b, ...patch } : b)),
    }));
  }, []);

  /** 移出当前充填批次（拦截原因留痕，瓶回队列） */
  const rejectFromBatch = useCallback(
    (cylId: string, requested: string, reason: string) => {
      setState((s) => {
        if (!s.batch.some((b) => b.cylId === cylId)) return s;
        const rec: Rejection = {
          id: uid("J"),
          cylId,
          requested,
          reason,
          at: new Date().toISOString(),
          operator: s.operator,
        };
        return {
          ...s,
          batch: s.batch.filter((b) => b.cylId !== cylId),
          rejections: [rec, ...s.rejections],
          cylinders: s.cylinders.map((c) =>
            c.id === cylId
              ? { ...c, enqueued: true, lastReject: { reason, at: rec.at } }
              : c
          ),
        };
      });
    },
    []
  );

  /** 操作员完成充填并签收 */
  const signOff = useCallback(
    (
      cylId: string,
      actual: { pressure: number; o2: number; he: number },
      addAmounts: { addHe: number; addO2: number; addAir: number },
      target: { pressure: number; o2: number; he: number; gasKind: string }
    ): FillReceipt | null => {
      let receipt: FillReceipt | null = null;
      setState((s) => {
        const c = s.cylinders.find((x) => x.id === cylId);
        if (!c) return s;
        const r: FillReceipt = {
          id: uid("F"),
          cylId,
          volumeL: c.volumeL,
          label: c.label,
          gasKind: target.gasKind,
          targetPressure: target.pressure,
          targetO2: target.o2,
          targetHe: target.he,
          addHe: addAmounts.addHe,
          addO2: addAmounts.addO2,
          addAir: addAmounts.addAir,
          actualPressure: actual.pressure,
          actualO2: actual.o2,
          actualHe: actual.he,
          operator: s.operator,
          signedAt: new Date().toISOString(),
        };
        receipt = r;
        return {
          ...s,
          batch: s.batch.filter((b) => b.cylId !== cylId),
          receipts: [r, ...s.receipts],
          cylinders: s.cylinders.map((x) =>
            x.id === cylId
              ? {
                  ...x,
                  enqueued: false,
                  rush: false,
                  rushAt: null,
                  lastReject: null,
                  residualPressure: actual.pressure,
                  residualO2: actual.o2,
                  residualHe: actual.he,
                  lastFill: {
                    pressure: actual.pressure,
                    o2: actual.o2,
                    he: actual.he,
                    at: r.signedAt,
                  },
                }
              : x
          ),
        };
      });
      return receipt;
    },
    []
  );

  const toggleRush = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      cylinders: s.cylinders.map((c) =>
        c.id === id
          ? c.rush
            ? { ...c, rush: false, rushAt: null }
            : { ...c, rush: true, rushAt: Date.now() }
          : c
      ),
    }));
  }, []);

  const setOperator = useCallback((operator: string) => {
    setState((s) => ({ ...s, operator }));
  }, []);

  const resetDemo = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setState(seed());
  }, []);

  return {
    state,
    enqueue,
    addToBatch,
    updateBatchItem,
    rejectFromBatch,
    signOff,
    toggleRush,
    updateCyl,
    setOperator,
    resetDemo,
  };
}

/** 计划排序：检验有效期最短在前，同日期按编号 */
export function plannedRank(a: Cylinder, b: Cylinder): number {
  if (a.hydroDate !== b.hydroDate) return a.hydroDate < b.hydroDate ? -1 : 1;
  return a.id.localeCompare(b.id);
}

/** 实际队列顺序：临时加急瓶按加急时间置顶，其余保持计划位置 */
export function sortQueue(list: Cylinder[]): Cylinder[] {
  return [...list].sort((a, b) => {
    if (a.rush !== b.rush) return a.rush ? -1 : 1;
    if (a.rush && b.rush) return (a.rushAt ?? 0) - (b.rushAt ?? 0);
    return plannedRank(a, b);
  });
}

export type { Label };
