'use strict';

// 跨片测距标注读数引擎。
//
// 测点以各自照片的像素坐标入库（annotations 表）；毫米读数**从不持久化**——
// 每次读取都按“当前比例尺 + 已采纳接缝推导的当前布局位姿”现算：
//   像素坐标 →（该片比例尺 ppm）→ 局部毫米 →（该片当前世界位姿）→ 世界毫米 → 欧氏距离。
// 因此接缝修订/撤销/批量采纳/比例尺变化后，下一次读取自然得到新读数；
// 两片断开（不再同一连通组）时标注保留但标为不可计算（distance_mm = null），
// 重连后自动恢复读数——任何时刻都不会给出旧布局的残留读数。

const geo = require('./geo');
const { sherdMetrics } = require('./layout');

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

// annotations：annotations 表行；sherds：sherds 表行；
// computed：layout.computeLayout 的结果（{ groups, unconnected, residuals }）。
// 返回与标注一一对应的读取契约（附带 computable / distance_mm）。
function computeAnnotations(annotations, sherds, computed) {
  const metricsById = new Map(sherds.map((s) => [s.id, sherdMetrics(s)]));
  const groupOf = new Map(); // sherdId -> root_sherd_id（仅连通组成员）
  const poseOf = new Map(); // sherdId -> 组内世界位姿
  for (const g of (computed && computed.groups) || []) {
    for (const id of g.member_ids) {
      groupOf.set(id, g.root_sherd_id);
      if (g.poses && g.poses[id]) poseOf.set(id, g.poses[id]);
    }
  }

  return (annotations || []).map((a) => {
    const base = {
      id: a.id,
      from_id: a.from_id,
      to_id: a.to_id,
      from_x: a.from_x,
      from_y: a.from_y,
      to_x: a.to_x,
      to_y: a.to_y,
      label: a.label,
      created_at: a.created_at,
    };
    const mFrom = metricsById.get(a.from_id);
    const mTo = metricsById.get(a.to_id);
    // 两片须均已标比例尺且当前处于同一连通组（各组坐标系各自独立，跨组距离无意义）。
    const sameGroup = groupOf.get(a.from_id) !== undefined
      && groupOf.get(a.from_id) === groupOf.get(a.to_id);
    const poseFrom = poseOf.get(a.from_id);
    const poseTo = poseOf.get(a.to_id);
    if (!mFrom || !mTo || !sameGroup || !poseFrom || !poseTo) {
      return { ...base, computable: false, distance_mm: null };
    }
    const wFrom = geo.applyPose(poseFrom, a.from_x / mFrom.ppm, a.from_y / mFrom.ppm);
    const wTo = geo.applyPose(poseTo, a.to_x / mTo.ppm, a.to_y / mTo.ppm);
    const distance = Math.hypot(wFrom.x - wTo.x, wFrom.y - wTo.y);
    return { ...base, computable: true, distance_mm: round3(distance) };
  });
}

module.exports = { computeAnnotations };
