export type Label = "AIR" | "NITROX" | "TRIMIX";

/** 气瓶档案（同一编号反复到店，档案与历史长期保留） */
export interface Cylinder {
  id: string; // 气瓶编号
  volumeL: number; // 容积 L
  label: Label; // 气瓶标识：空气瓶 / 高氧气瓶 / Trimix 瓶
  workingPressure: number; // 工作压力 bar（充填目标上限）
  hydroDate: string; // 检验有效期 YYYY-MM-DD
  residualPressure: number; // 上次余压 bar
  residualO2: number; // 残气氧含量 %
  residualHe: number; // 残气氦含量 %
  enqueued: boolean; // 是否在待充填队列
  rush: boolean; // 临时加急
  rushAt: number | null;
  lastReject: { reason: string; at: string } | null;
  lastFill: { pressure: number; o2: number; he: number; at: string } | null;
  createdAt: string;
}

/** 当前充填批次中的一个瓶及其本次充填要求 / 实测值 */
export interface BatchItem {
  cylId: string;
  targetO2: number; // %
  targetHe: number; // %
  targetPressure: number; // bar
  actualPressure: number;
  actualO2: number;
  actualHe: number;
}

/** 签收单 */
export interface FillReceipt {
  id: string;
  cylId: string;
  volumeL: number;
  label: Label;
  gasKind: string; // 空气 / 高氧 / Trimix
  targetPressure: number;
  targetO2: number;
  targetHe: number;
  addHe: number; // 充入氦分压 bar
  addO2: number; // 充入纯氧分压 bar
  addAir: number; // 空气补压 bar
  actualPressure: number; // 实际压力
  actualO2: number; // 实测氧含量
  actualHe: number; // 实测氦含量
  operator: string; // 签收操作员
  signedAt: string; // 签收时间 ISO
}

/** 批次拦截（检验过期 / 标识不符等移出批次的原因留痕） */
export interface Rejection {
  id: string;
  cylId: string;
  requested: string;
  reason: string;
  at: string;
  operator: string;
}

export interface AppState {
  cylinders: Cylinder[];
  batch: BatchItem[];
  receipts: FillReceipt[];
  rejections: Rejection[];
  operator: string;
}

export interface EnqueueInput {
  id: string;
  volumeL: number;
  label: Label;
  workingPressure: number;
  hydroDate: string;
  residualPressure: number;
  residualO2: number;
  residualHe: number;
}
