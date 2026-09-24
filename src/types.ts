// 潜水气瓶充填台 - 数据类型定义

/** 充填气种 */
export type GasType = "AIR" | "NITROX" | "TRIMIX";

/** 瓶体标识（瓶阀/密封圈适用等级） */
export type CylinderLabel = "AIR" | "NITROX" | "TRIMIX";

/** 气瓶在批次中的状态 */
export type TankStatus = "QUEUED" | "REMOVED" | "FILLED";

export interface Tank {
  /** 气瓶编号，唯一且长期不变，历史记录靠它串联 */
  id: string;
  /** 容积描述，如 12L铝瓶 */
  description: string;
  /** 水容积 L */
  volume: number;
  /** 额定压力 bar */
  ratedPressure: number;
  /** 检验有效期 yyyy-mm-dd */
  inspectionDate: string;
  /** 瓶体标识 */
  label: CylinderLabel;
  /** 上次余压 bar（可在充填前复测修改） */
  residualPressure: number;
  /** 残气氧含量 % */
  residualO2: number;
  /** 残气氦含量 % */
  residualHe: number;
  status: TankStatus;
  /** 移出批次原因 */
  removeReason?: string;
  /** 移出时间 */
  removedAt?: string;
  /** 是否临时加急 */
  expedited: boolean;
  /** 加急时间，用于多个加急瓶之间排序 */
  expeditedAt?: string;
  /** 原计划位置（按检验期升序排定），加急/取消加急都保留 */
  planPosition: number;
}

/** 一次充填的配气方案，单位均为 bar */
export interface Recipe {
  /** 需充入空气 */
  airAdd: number;
  /** 需充入纯氧 */
  o2Add: number;
  /** 需充入氦气 */
  heAdd: number;
  /** 当前余压下方案是否可行（任一组分为负即不可行，需先泄放） */
  feasible: boolean;
  /** 不可行时，建议先泄放到的最高余压 */
  drainToBar?: number;
}

export interface FillRequest {
  gasType: GasType;
  targetPressure: number;
  /** 目标氧含量 % */
  targetO2: number;
  /** 目标氦含量 % */
  targetHe: number;
}

export type CheckLevel = "block" | "warn";

export interface CheckItem {
  level: CheckLevel;
  message: string;
}

/** 签收单（同一气瓶可有多条，永久保留） */
export interface FillRecord {
  id: string;
  tankId: string;
  signedAt: string;
  operator: string;
  gasType: GasType;
  /** 目标压力 */
  targetPressure: number;
  /** 实际充填压力 */
  actualPressure: number;
  targetO2: number;
  targetHe: number;
  /** 充填前余压 */
  residualPressure: number;
  airAdd: number;
  o2Add: number;
  heAdd: number;
}

export interface PersistState {
  tanks: Tank[];
  records: FillRecord[];
}
