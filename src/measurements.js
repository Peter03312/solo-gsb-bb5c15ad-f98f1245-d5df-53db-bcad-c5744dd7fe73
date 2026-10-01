'use strict';

// 跨片测距引擎。
//
// 测点只保存“所在陶片照片的像素坐标”（px, py）。毫米读数从不持久化：
// 每次读取都按各片当前比例尺把像素换算成该片局部毫米坐标，再按当前已采纳
// 接缝推导出的世界位姿（layout）变换到世界系后求平面距离。
// 因此接缝修订/撤销/批量采纳、比例尺变化后读数天然随当前布局重算；
// 两片断开时测点记录保留，但读数标为不可计算（computable=false），
// 重连后自动恢复——任何时候都不会返回旧读数。

const layoutMod = require('./layout');

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

// 照片像素坐标 → 陶片局部毫米坐标（局部原点为照片左上角，x/y 分别沿图像宽/高）。
function pixelToLocalMm(sh, px, py) {
  const ppm = sh.scale_px / sh.scale_mm;
  return { x: px / ppm, y: py / ppm };
}

// 从 layout 中找到某片所属连通组及其（三位小数）世界位姿。
function findGroupPose(layout, sherdId) {
  for (const g of layout.groups) {
    if (Object.prototype.hasOwnProperty.call(g.poses, sherdId)) {
      return { group: g, pose: g.poses[sherdId] };
    }
  }
  return null;
}

// 计算一条跨片测距的当前读数。
// 可计算的充要条件：两端都已标比例尺，且此刻在同一连通组（沿已采纳接缝连通）。
// 返回：
//   { computable: true, distance_mm, from_world, to_world, group_root_sherd_id }
//   { computable: false, reason: 'disconnected' | 'scale_missing' }
function computeMeasurement(m, sherdById, layout) {
  const from = sherdById.get(m.from_sherd_id);
  const to = sherdById.get(m.to_sherd_id);
  if (!from || !to) return { computable: false, reason: 'sherd_missing' };
  if (!from.scale_px || !from.scale_mm || !to.scale_px || !to.scale_mm) {
    return { computable: false, reason: 'scale_missing' };
  }
  const gf = findGroupPose(layout, m.from_sherd_id);
  const gt = findGroupPose(layout, m.to_sherd_id);
  if (!gf || !gt || gf.group.root_sherd_id !== gt.group.root_sherd_id) {
    return { computable: false, reason: 'disconnected' };
  }

  const localFrom = pixelToLocalMm(from, m.from_px, m.from_py);
  const localTo = pixelToLocalMm(to, m.to_px, m.to_py);
  // 世界位姿：世界 = R(theta)·局部 + (x,y)
  const wf = rotateTranslate(gf.pose, localFrom.x, localFrom.y);
  const wt = rotateTranslate(gt.pose, localTo.x, localTo.y);
  const distance = Math.hypot(wf.x - wt.x, wf.y - wt.y);
  return {
    computable: true,
    distance_mm: round3(distance),
    from_world: { x: round3(wf.x), y: round3(wf.y) },
    to_world: { x: round3(wt.x), y: round3(wt.y) },
    group_root_sherd_id: gf.group.root_sherd_id,
  };
}

function rotateTranslate(pose, lx, ly) {
  const rad = (pose.theta * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return {
    x: c * lx - s * ly + pose.x,
    y: s * lx + c * ly + pose.y,
  };
}

// 为方案全部测距记录现算读数。layout 是 layout.computeLayout/Detailed 的结果。
function computeMeasurements(measurements, sherds, layout) {
  const sherdById = new Map(sherds.map((s) => [s.id, s]));
  return measurements.map((m) => ({
    measurement: m,
    readout: computeMeasurement(m, sherdById, layout),
  }));
}

// 创建前的业务校验：两端陶片必须属于同一方案、均已标比例尺、
// 此刻处于同一连通组，且两个像素坐标都必须落在各自照片范围内。
// 返回 { errors: [string,...] }；errors 非空即拒绝创建（不写入）。
function validateMeasurementInput(input, { sherds, seams, toleranceMm }) {
  const errors = [];
  const sherdById = new Map(sherds.map((s) => [s.id, s]));
  const { from_sherd_id: fromId, to_sherd_id: toId } = input;

  const from = Number.isInteger(fromId) ? sherdById.get(fromId) : null;
  const to = Number.isInteger(toId) ? sherdById.get(toId) : null;
  if (!from) errors.push('起点陶片不存在或不属于该方案');
  if (!to) errors.push('终点陶片不存在或不属于该方案');
  if (fromId === toId) errors.push('跨片测距的两个测点必须位于两片不同的陶片上');

  const checkCoord = (name, sh, px, py) => {
    if (!sh) return;
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      errors.push(`${name}像素坐标必须是数字`);
      return;
    }
    if (px < 0 || py < 0 || px > sh.img_w || py > sh.img_h) {
      errors.push(`${name}测点坐标 (${px}, ${py}) 超出照片范围（${sh.img_w}×${sh.img_h} px）`);
    }
  };
  checkCoord('起点', from, input.from_px, input.from_py);
  checkCoord('终点', to, input.to_px, input.to_py);

  if (from && to && fromId !== toId) {
    if (!from.scale_px || !from.scale_mm || !to.scale_px || !to.scale_mm) {
      errors.push('两片陶片都必须先标记毫米比例尺，才能进行跨片测距');
    } else {
      // 同一连通组以当前已采纳接缝的布局为准。
      const comp = layoutMod.computeLayout(sherds, seams, toleranceMm);
      const gf = findGroupPose(comp, fromId);
      const gt = findGroupPose(comp, toId);
      if (!gf || !gt || gf.group.root_sherd_id !== gt.group.root_sherd_id) {
        errors.push('两片陶片当前不在同一连通组：请先以已采纳接缝把它们拼入同一组，再记录跨片测距');
      }
    }
  }

  return { errors };
}

module.exports = {
  pixelToLocalMm,
  computeMeasurement,
  computeMeasurements,
  validateMeasurementInput,
  findGroupPose,
};
