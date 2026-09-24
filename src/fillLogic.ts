import type { Cylinder, Label } from "./types";

/* ----------------------------- 常量与标识 ----------------------------- */

export const AIR_O2 = 21; // 空气氧含量 %
export const NEAR_EXPIRY_DAYS = 30; // 检验临期提醒窗口

export interface LabelSpec {
  value: Label;
  name: string;
  maxO2: number; // 该标识允许充入的最高氧含量
  allowsHe: boolean;
  blurb: string;
}

export const LABEL_SPECS: Record<Label, LabelSpec> = {
  AIR: {
    value: "AIR",
    name: "空气瓶",
    maxO2: AIR_O2,
    allowsHe: false,
    blurb: "仅可充空气（O₂ ≤ 21%，不含氦）",
  },
  NITROX: {
    value: "NITROX",
    name: "高氧气瓶",
    maxO2: 40,
    allowsHe: false,
    blurb: "可充空气或高氧（O₂ ≤ 40%，不含氦）",
  },
  TRIMIX: {
    value: "TRIMIX",
    name: "Trimix 瓶",
    maxO2: 100,
    allowsHe: true,
    blurb: "可充空气 / 高氧 / Trimix（含氦）",
  },
};

export interface Preset {
  key: string;
  name: string;
  gasKind: string;
  o2: number;
  he: number;
}

export const PRESETS: Preset[] = [
  { key: "air", name: "空气", gasKind: "空气", o2: AIR_O2, he: 0 },
  { key: "ean32", name: "高氧 EAN32", gasKind: "高氧", o2: 32, he: 0 },
  { key: "ean36", name: "高氧 EAN36", gasKind: "高氧", o2: 36, he: 0 },
  { key: "tx1845", name: "Trimix 18/45", gasKind: "Trimix", o2: 18, he: 45 },
  { key: "tx2135", name: "Trimix 21/35", gasKind: "Trimix", o2: 21, he: 35 },
];

export function gasKindOf(o2: number, he: number): string {
  if (he > 0) return "Trimix";
  if (Math.abs(o2 - AIR_O2) < 0.5) return "空气";
  return "高氧";
}

/* ------------------------------- 日期 -------------------------------- */

/** 今天，本地时区的 YYYY-MM-DD */
export function todayISO(): string {
  return toDateISO(new Date());
}

export function toDateISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 相对今天偏移 n 天的 YYYY-MM-DD（演示数据用） */
export function daysFromNowISO(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return toDateISO(d);
}

function parseDate(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1).getTime();
}

/** 检验状态：过期天数（负数表示剩余天数） */
export function hydroStatus(hydroDate: string, now: string = todayISO()): {
  expired: boolean;
  daysLeft: number;
  near: boolean;
} {
  const ms = parseDate(now) - parseDate(hydroDate);
  const daysLeft = Math.round(-ms / 86_400_000);
  return {
    expired: daysLeft < 0,
    daysLeft,
    near: daysLeft >= 0 && daysLeft <= NEAR_EXPIRY_DAYS,
  };
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/* --------------------------- 充填方案计算 ---------------------------- */

export interface FillPlan {
  ok: boolean;
  errors: string[]; // 阻断性问题（需移出本批次）
  warnings: string[]; // 提示（不阻断）
  residualPressure: number;
  targetPressure: number;
  targetO2: number;
  targetHe: number;
  gasKind: string;
  addHe: number; // 充入氦分压 bar
  addO2: number; // 充入纯氧分压 bar
  addAir: number; // 空气补压 bar
}

export function planFill(
  cyl: Pick<
    Cylinder,
    "id" | "label" | "hydroDate" | "workingPressure" | "residualPressure" | "residualO2" | "residualHe"
  >,
  req: { targetPressure: number; targetO2: number; targetHe: number },
  now: string = todayISO()
): FillPlan {
  const errors: string[] = [];
  const warnings: string[] = [];

  const targetPressure = Math.round(req.targetPressure);
  const targetO2 = clamp(req.targetO2, 1, 100);
  const targetHe = clamp(req.targetHe, 0, 99);
  const P0 = cyl.residualPressure;
  const spec = LABEL_SPECS[cyl.label];

  // 1) 检验有效期 —— 过期一律阻断
  const hydro = hydroStatus(cyl.hydroDate, now);
  if (hydro.expired) {
    errors.push(`检验已过期 ${-hydro.daysLeft} 天（有效期至 ${cyl.hydroDate}），禁止充填`);
  } else if (hydro.near) {
    warnings.push(`检验有效期剩余 ${hydro.daysLeft} 天（至 ${cyl.hydroDate}），请尽快送检`);
  }

  // 2) 目标混合气本身合法性
  if (targetHe + targetO2 > 100) {
    errors.push(`目标比例不合法：O₂ ${targetO2}% + He ${targetHe}% 超过 100%`);
  }

  // 3) 氧含量 / 氦含量与气瓶标识是否相符
  if (targetHe > 0 && !spec.allowsHe) {
    errors.push(`氧含量/瓶标识不符：${spec.name}不能充含氦混合气（目标 He ${targetHe}%）`);
  }
  if (targetO2 > spec.maxO2 + 0.001) {
    errors.push(
      `氧含量与气瓶标识不符：${spec.name}允许 O₂ ≤ ${spec.maxO2}%，目标为 ${targetO2}%`
    );
  }

  // 4) 压力合理性
  if (!Number.isFinite(targetPressure) || targetPressure <= 0) {
    errors.push("目标压力必须大于 0 bar");
  } else if (targetPressure > cyl.workingPressure + 0.001) {
    errors.push(`目标 ${targetPressure} bar 超过气瓶工作压力 ${cyl.workingPressure} bar`);
  }
  if (P0 < 0) errors.push("余压不能为负");
  if (targetPressure > 0 && P0 >= targetPressure + 0.001) {
    errors.push(`余压 ${P0} bar 已达到/超过目标 ${targetPressure} bar，本次无需充填`);
  }

  // 5) 残气能否配出目标（分压法：先加氦、再加纯氧、最后空气补压）
  let addHe = 0;
  let addO2 = 0;
  let addAir = 0;

  if (errors.length === 0) {
    // 氦无法被稀释去除：残气氦分压不得高于目标
    const heNeed = (targetPressure * targetHe) / 100;
    const heHave = (P0 * cyl.residualHe) / 100;
    addHe = round1(heNeed - heHave);
    if (heHave > heNeed + 0.5) {
      errors.push(
        `残气无法配出目标：余压 ${P0} bar 含 He ${cyl.residualHe}%，氦无法靠补压降低（需先抽残气）`
      );
    }

    if (errors.length === 0) {
      // 加氦后压力
      const pAfterHe = P0 + addHe;
      // 空气补压量 A：pAfterHe 段氧 + 纯氧 + 空气中的氧 = 目标氧量
      const oxygenNeed = (targetPressure * targetO2) / 100;
      const oxygenHave = (P0 * cyl.residualO2) / 100;
      const denom = 1 - AIR_O2 / 100;
      // X(纯氧) + A(空气) = 剩余填充量；X + 0.21A = 净需氧量
      addAir = round1(((targetPressure - pAfterHe) - (oxygenNeed - oxygenHave)) / denom);
      addO2 = round1(targetPressure - pAfterHe - addAir);

      if (addO2 < -0.5) {
        errors.push(
          `残气无法配出目标：余压 ${P0} bar 含 O₂ ${cyl.residualO2}%，氧含量无法靠补压降到 ${targetO2}%（需先抽残气）`
        );
        addO2 = 0;
      } else {
        addO2 = Math.max(0, addO2);
        addAir = Math.max(0, round1(targetPressure - pAfterHe - addO2));
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    residualPressure: P0,
    targetPressure,
    targetO2,
    targetHe,
    gasKind: gasKindOf(targetO2, targetHe),
    addHe,
    addO2,
    addAir,
  };
}

/* ------------------------------- 工具 -------------------------------- */

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function uid(prefix = "R"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
