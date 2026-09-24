import type { FillRecord, PersistState, Tank } from "./types";

const STORAGE_KEY = "dive-fillstation-v1";

function isoOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function nowOffset(daysAgo: number, hhmm: string): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const [h, m] = hhmm.split(":");
  d.setHours(Number(h), Number(m), 0, 0);
  return d.toISOString();
}

/** 演示数据：检验日期相对今天生成，保证长期可用 */
export function seedData(): PersistState {
  const tanks: Tank[] = [
    {
      id: "TANK-231",
      description: "11.1L 钢瓶（双瓶组之一）",
      volume: 11.1,
      ratedPressure: 232,
      inspectionDate: isoOffset(12),
      label: "AIR",
      residualPressure: 40,
      residualO2: 21,
      residualHe: 0,
      status: "QUEUED",
      expedited: false,
      planPosition: 1,
    },
    {
      id: "TANK-219",
      description: "11L 钢瓶",
      volume: 11,
      ratedPressure: 230,
      inspectionDate: isoOffset(45),
      label: "NITROX",
      residualPressure: 30,
      residualO2: 32,
      residualHe: 0,
      status: "QUEUED",
      expedited: true,
      expeditedAt: nowOffset(0, "08:15"),
      planPosition: 2,
    },
    {
      id: "TANK-204",
      description: "12L 铝瓶",
      volume: 12,
      ratedPressure: 207,
      inspectionDate: isoOffset(80),
      label: "AIR",
      residualPressure: 55,
      residualO2: 21,
      residualHe: 0,
      status: "QUEUED",
      expedited: false,
      planPosition: 3,
    },
    {
      id: "TANK-260",
      description: "12.2L 钢瓶",
      volume: 12.2,
      ratedPressure: 232,
      inspectionDate: isoOffset(130),
      label: "TRIMIX",
      residualPressure: 60,
      residualO2: 18,
      residualHe: 35,
      status: "QUEUED",
      expedited: false,
      planPosition: 4,
    },
    {
      id: "TANK-188",
      description: "10L 钢瓶",
      volume: 10,
      ratedPressure: 200,
      inspectionDate: isoOffset(200),
      label: "NITROX",
      residualPressure: 20,
      residualO2: 32,
      residualHe: 0,
      status: "QUEUED",
      expedited: false,
      planPosition: 5,
    },
    {
      id: "TANK-312",
      description: "80cuft 铝瓶",
      volume: 11.1,
      ratedPressure: 207,
      inspectionDate: isoOffset(-9),
      label: "AIR",
      residualPressure: 10,
      residualO2: 21,
      residualHe: 0,
      status: "QUEUED",
      expedited: false,
      planPosition: 6,
    },
    {
      id: "TANK-277",
      description: "12L 钢瓶",
      volume: 12,
      ratedPressure: 230,
      inspectionDate: isoOffset(95),
      label: "AIR",
      // 空气瓶但残气含氧 30%：校验时会按"氧含量与标识不符"被移出
      residualPressure: 45,
      residualO2: 30,
      residualHe: 0,
      status: "QUEUED",
      expedited: false,
      planPosition: 7,
    },
  ];

  const records: FillRecord[] = [
    {
      id: "R-1001",
      tankId: "TANK-204",
      signedAt: nowOffset(21, "10:42"),
      operator: "陈曦",
      gasType: "AIR",
      targetPressure: 200,
      actualPressure: 200,
      targetO2: 21,
      targetHe: 0,
      residualPressure: 50,
      airAdd: 150,
      o2Add: 0,
      heAdd: 0,
    },
    {
      id: "R-0998",
      tankId: "TANK-219",
      signedAt: nowOffset(34, "15:05"),
      operator: "李海",
      gasType: "NITROX",
      targetPressure: 200,
      actualPressure: 198,
      targetO2: 32,
      targetHe: 0,
      residualPressure: 25,
      airAdd: 150.6,
      o2Add: 24.4,
      heAdd: 0,
    },
  ];

  return { tanks, records };
}

export function loadState(): PersistState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistState;
      if (Array.isArray(parsed.tanks) && Array.isArray(parsed.records)) {
        return parsed;
      }
    }
  } catch {
    // 损坏的存档直接回落到演示数据
  }
  const seed = seedData();
  saveState(seed);
  return seed;
}

export function saveState(state: PersistState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存储空间不足时静默失败，不影响当次操作
  }
}

export function resetState(): PersistState {
  const seed = seedData();
  saveState(seed);
  return seed;
}

/** 签收单号：R + 时间戳后六位风格 */
export function newRecordId(): string {
  return "R-" + Date.now().toString(36).toUpperCase();
}

/** 给新入队气瓶分配计划位置（现有最大位置 + 1） */
export function nextPlanPosition(tanks: Tank[]): number {
  return tanks.reduce((m, t) => Math.max(m, t.planPosition), 0) + 1;
}

export type { FillRecord };
