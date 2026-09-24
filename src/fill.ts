import type {
  CheckItem,
  CylinderLabel,
  FillRequest,
  GasType,
  Recipe,
  Tank,
} from "./types";

/** 空气含氧量 */
export const AIR_O2 = 0.21;

export const GAS_TYPE_NAME: Record<GasType, string> = {
  AIR: "空气",
  NITROX: "高氧 Nitrox",
  TRIMIX: "Trimix",
};

export const LABEL_NAME: Record<CylinderLabel, string> = {
  AIR: "空气瓶标识",
  NITROX: "高氧瓶标识（富氧兼容）",
  TRIMIX: "Trimix 瓶标识（富氧兼容）",
};

/** 气种默认目标参数 */
export const GAS_PRESETS: Record<
  GasType,
  { o2: number; he: number }
> = {
  AIR: { o2: 21, he: 0 },
  NITROX: { o2: 32, he: 0 },
  TRIMIX: { o2: 18, he: 35 },
};

const round1 = (v: number) => Math.round(v * 10) / 10;

/** 检验剩余天数（负数表示已过期） */
export function daysUntil(dateStr: string, today = new Date()): number {
  const d = new Date(dateStr + "T00:00:00");
  const t = new Date(
    today.getFullYear() +
      "-" +
      String(today.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(today.getDate()).padStart(2, "0") +
      "T00:00:00"
  );
  return Math.round((d.getTime() - t.getTime()) / 86400000);
}

/**
 * 分压配气计算（bar 线性叠加，残气保留）。
 * 先加氦、再加氧、最后用空气补压（空气含 O₂ 21% / N₂ 79%）。
 * 氮守恒（氮只来自残气与补入空气）：
 *   0.79 * airAdd = (1 - to - th)*P - (1 - ro - rh)*r
 * 氦守恒：heAdd = th*P - rh*r
 * 压力总和：o2Add = P - r - heAdd - airAdd
 */
export function computeRecipe(
  tank: Pick<Tank, "residualPressure" | "residualO2" | "residualHe">,
  req: FillRequest
): Recipe {
  const r = tank.residualPressure;
  const P = req.targetPressure;
  const ro = tank.residualO2 / 100;
  const rh = tank.residualHe / 100;
  const to = req.targetO2 / 100;
  const th = req.targetHe / 100;

  const heAdd = th * P - rh * r;
  const airAdd =
    ((1 - to - th) * P - (1 - ro - rh) * r) / (1 - AIR_O2);
  const o2Add = P - r - heAdd - airAdd;

  const feasible = heAdd >= -0.05 && o2Add >= -0.05 && airAdd >= -0.05;

  let drainToBar: number | undefined;
  if (!feasible) {
    // 以 0.5bar 为步长找各组分仍非负的最高残压
    let maxR = 0;
    for (let x = r; x >= 0; x -= 0.5) {
      const h = th * P - rh * x;
      const a = ((1 - to - th) * P - (1 - ro - rh) * x) / (1 - AIR_O2);
      const o = P - x - h - a;
      if (h >= -0.05 && o >= -0.05 && a >= -0.05) {
        maxR = x;
        break;
      }
    }
    drainToBar = round1(maxR);
  }

  return {
    heAdd: round1(Math.max(heAdd, 0)),
    o2Add: round1(Math.max(o2Add, 0)),
    airAdd: round1(Math.max(airAdd, 0)),
    feasible,
    drainToBar,
  };
}

/**
 * 充填前校验。
 * block 级问题：检验过期、氧/氦含量与瓶体标识不符 —— 必须移出当前批次并写明原因。
 * warn 级问题：临期提醒等，不阻止充填。
 */
export function validateFill(
  tank: Tank,
  req: FillRequest,
  today = new Date()
): CheckItem[] {
  const items: CheckItem[] = [];

  // 1. 检验有效期
  const days = daysUntil(tank.inspectionDate, today);
  if (days < 0) {
    items.push({
      level: "block",
      message: `检验已过期（${tank.inspectionDate} 到期，已过 ${-days} 天），禁止充填`,
    });
  } else if (days <= 30) {
    items.push({
      level: "warn",
      message: `检验将于 ${days} 天后到期（${tank.inspectionDate}），请提醒客户尽快送检`,
    });
  }

  // 2. 目标气种 / 混合比例与瓶体标识是否相符
  const o2 = req.targetO2;
  const he = req.targetHe;

  if (tank.label === "AIR") {
    if (req.gasType !== "AIR" || o2 > 22 || he > 0.5) {
      items.push({
        level: "block",
        message: `瓶体为【空气瓶标识】，不具备富氧兼容性，不能充填 ${GAS_TYPE_NAME[req.gasType]}（O₂ ${o2}% / He ${he}%）`,
      });
    }
  } else if (tank.label === "NITROX") {
    if (req.gasType === "TRIMIX" || he > 0.5) {
      items.push({
        level: "block",
        message: `瓶体为【高氧瓶标识】，本次要求 He ${he}%（Trimix），标识不符`,
      });
    }
    if (o2 > 40) {
      items.push({
        level: "block",
        message: `目标氧含量 ${o2}% 超过富氧瓶安全上限 40%，存在燃爆风险`,
      });
    }
    if (o2 < 20) {
      items.push({
        level: "block",
        message: `目标氧含量 ${o2}% 低于空气含氧量，高氧瓶标识与本次充填不符`,
      });
    }
  } else if (tank.label === "TRIMIX") {
    if (o2 > 50) {
      items.push({
        level: "block",
        message: `目标氧含量 ${o2}% 超过富氧安全上限 50%，存在燃爆风险`,
      });
    }
    if (he < 1) {
      items.push({
        level: "block",
        message: `瓶体为【Trimix 瓶标识】，本次不含氦（He ${he}%），氧含量与气瓶标识不符`,
      });
    }
  }

  // 3. 残气成分与瓶体标识矛盾（例如空气瓶内残留富氧，有油污风险）
  if (tank.label === "AIR" && tank.residualO2 > 23) {
    items.push({
      level: "block",
      message: `残气实测氧含量 ${tank.residualO2}%，与空气瓶标识不符，疑似曾充富氧，需清洁/换瓶`,
    });
  }
  if (
    (tank.label === "AIR" || tank.label === "NITROX") &&
    tank.residualHe > 1
  ) {
    items.push({
      level: "block",
      message: `残气实测氦含量 ${tank.residualHe}%，与${
        tank.label === "AIR" ? "空气" : "高氧"
      }瓶标识不符`,
    });
  }

  // 4. 压力范围
  if (req.targetPressure > tank.ratedPressure) {
    items.push({
      level: "block",
      message: `目标压力 ${req.targetPressure}bar 超过气瓶额定压力 ${tank.ratedPressure}bar`,
    });
  }
  if (tank.residualPressure > req.targetPressure) {
    items.push({
      level: "block",
      message: `残压 ${tank.residualPressure}bar 已高于目标压力 ${req.targetPressure}bar，请先泄放`,
    });
  }

  // 5. 组分本身合法性
  if (Math.abs(o2 + he) > 100.5) {
    items.push({ level: "block", message: "O₂ + He 比例之和超过 100%" });
  }

  return items;
}

/** 生成移出批次的统一原因文案 */
export function blockReason(items: CheckItem[]): string {
  return items
    .filter((i) => i.level === "block")
    .map((i) => i.message)
    .join("；");
}
