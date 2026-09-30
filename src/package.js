'use strict';

// 方案导入/导出包（自包含 ZIP）。
//
// 包结构：
//   manifest.json        方案清单（名称、毫米容差、来源版本、陶片/接缝数据、
//                        每张照片的 sha256 摘要、闭合环校验结果与布局指纹）
//   photos/<sha256 前16位>.<ext>   陶片照片（清单按此路径引用）
//
// 导出：在一次同步快照中读取方案、陶片、接缝与全部照片字节；导出期间即使
// 方案被其他请求编辑，包内数据也必然来自同一版本（version 同时写入清单）。
//
// 导入：创建**独立的新方案**，本地 id 全部重新分配并正确重关联接缝与照片。
// 在写库前完整校验：ZIP 结构、清单、参数、照片摘要、缺失/重复文件、越界
// 路径、图像魔数与**全部闭合环**是否超容差；任何一项不合法即整包拒绝，
// 由上层保证不留下方案或孤儿照片。

const path = require('path');
const crypto = require('crypto');
const { createZip, unzip, ZipError } = require('./zip');
const layout = require('./layout');

const PACKAGE_TYPE = 'sherd-project-package';
const PACKAGE_VERSION = 1;
const MANIFEST_PATH = 'manifest.json';
const PHOTOS_DIR = 'photos/';

const MAX_SHERDS = 100000;
const MAX_SEAMS = 100000;
const MAX_NOTE_LEN = 2000;

class PackageError extends Error {
  constructor(message, reason = 'invalid_package', extra) {
    super(message);
    this.name = 'PackageError';
    this.reason = reason;
    this.extra = extra;
  }
}

const EXT_BY_SIG = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

// 魔数嗅探：导出沿用既有扩展名，导入时不信任扩展名而以内容魔数为准。
function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  if (buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return { mime: 'image/png', ext: '.png' };
  }
  // RIFF .... WEBP
  if (buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return { mime: 'image/webp', ext: '.webp' };
  }
  return null;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function photoInternalName(ord, digest, ext) {
  // 每片陶片一个独立条目（不同陶片允许照片字节完全相同）；文件名以 ord 为主、
  // 随机串去冲突，完整性以 manifest 的 image_sha256 为准。
  return `${PHOTOS_DIR}sherd_${String(ord).padStart(5, '0')}_${digest.slice(0, 12)}_${Math.random().toString(16).slice(2, 10)}${ext}`;
}

// ---------- 布局指纹 ----------
//
// 布局从不持久化（既有约定），因此“导入后布局与源方案等价”只能靠比对：
// 以同一份布局引擎现算，输出与 id 无关的规范化结构后做指纹。
// idMap 用于把规范化时出现的 id 重命名（导出时恒等；导入时用 源id→新id）。
function normalizeLayout(comp, toleranceMm, maps) {
  // 陶片 id 与接缝 id 是两个独立 id 空间，分别重映射；无映射时恒等。
  const mapSh = (id) => (maps && maps.sherdMap ? maps.sherdMap.get(id) : id);
  const mapSm = (id) => (maps && maps.seamMap ? maps.seamMap.get(id) : id);
  // 全部按重映射后的 id 重新排序，使指纹与本地 id 取值无关、仅由布局决定。
  const numSort = (a, b) => a - b;
  const sortedMap = (obj, valFn) =>
    Object.fromEntries(
      Object.entries(obj)
        .map(([id, v]) => [mapSh(Number(id)), valFn ? valFn(v) : v])
        .sort((a, b) => a[0] - b[0])
    );
  return {
    tolerance_mm: round3(toleranceMm),
    groups: comp.groups.map((g) => ({
      root: mapSh(g.root_sherd_id),
      members: g.member_ids.map(mapSh).sort(numSort),
      // 位姿按陶片 id 排序；接缝链是“自根起的有序路径”，保持顺序不排序。
      poses: sortedMap(g.poses, (p) => ({
        x: round3(p.x), y: round3(p.y), theta: round3(roundAngle(p.theta)),
      })),
      chains: sortedMap(g.chains, (chain) => chain.map(mapSm)),
      tree_seam_ids: g.tree_seam_ids.map(mapSm).sort(numSort),
      bounds: g.bounds ? {
        minX: round3(g.bounds.minX), minY: round3(g.bounds.minY),
        maxX: round3(g.bounds.maxX), maxY: round3(g.bounds.maxY),
        widthMm: round3(g.bounds.widthMm), heightMm: round3(g.bounds.heightMm),
      } : null,
    })).sort((a, b) => a.root - b.root),
    unconnected: comp.unconnected.map(mapSh).sort(numSort),
    residuals: comp.residuals.map((r) => ({
      seam: mapSm(r.seam_id),
      from: mapSh(r.from_id),
      to: mapSh(r.to_id),
      distance_mm: round3(r.distance_mm),
      rotation_deg: round3(roundAngle(r.rotation_deg)),
      within_tolerance: !!r.within_tolerance,
    })).sort((a, b) => a.seam - b.seam),
  };
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

// 角度按布局引擎同样的 3 位精度处理；避免 -0 影响指纹。
function roundAngle(deg) {
  const r = Math.round(deg * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}

function layoutFingerprint(comp, toleranceMm, maps) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(normalizeLayout(comp, toleranceMm, maps)))
    .digest('hex');
}

// ---------- 导出：快照 → ZIP ----------
//
// snapshot 由上层在同步区间内准备（保证同一版本）：
//   { project, sherds(ORDER BY id), seams(ORDER BY id), files: Map<image_file, Buffer> }
function buildPackageZip(snapshot) {
  const { project, sherds, seams, files } = snapshot;
  const comp = layout.computeLayoutDetailed(sherds, seams, project.tolerance_mm);
  const allWithin = comp.cycleDetails.every((c) => c.within_tolerance);

  const entries = [];
  const manifestSherds = sherds.map((sh, i) => {
    const ord = i + 1;
    const buf = files.get(sh.image_file);
    if (!buf) throw new PackageError(`照片文件缺失：${sh.image_file}`, 'source_file_missing');
    const digest = sha256(buf);
    // 以内容魔数决定包内扩展名，不信任存量文件的扩展名（导入端会再次魔数校验）。
    const sniffed = sniffImage(buf);
    if (!sniffed) throw new PackageError(`陶片照片内容不是受支持的图片：${sh.image_file}`, 'source_photo_invalid');
    const internal = photoInternalName(ord, digest, sniffed.ext);
    entries.push({ name: internal, data: buf });
    return {
      ord,
      label: sh.label,
      image_path: internal,
      image_sha256: digest,
      image_bytes: buf.length,
      img_w: sh.img_w,
      img_h: sh.img_h,
      scale_px: sh.scale_px,
      scale_mm: sh.scale_mm,
      note: sh.note || '',
    };
  });

  // 接缝两端改用“陶片在包内的序号（1 起）”，避免导入端依赖源库自增 id。
  const sherdRowByDbId = new Map(sherds.map((sh, i) => [sh.id, i + 1]));
  const seamRowByDbId = new Map(seams.map((sm, i) => [sm.id, i + 1]));
  const manifestSeams = seams.map((sm) => ({
    ord: 0, // 下面按采纳序（接缝 id 升序）赋值
    from_ord: sherdRowByDbId.get(sm.from_id),
    to_ord: sherdRowByDbId.get(sm.to_id),
    theta_deg: sm.theta_deg,
    tx: sm.tx,
    ty: sm.ty,
    join_note: sm.join_note || '',
  }));
  manifestSeams.forEach((m, i) => { m.ord = i + 1; });

  // 导出指纹：把源库本地 id 统一规范化为包内 ord（陶片、接缝各自映射），
  // 这样导入端用新 id 重算后可得到完全相同的指纹。
  const exportMaps = { sherdMap: sherdRowByDbId, seamMap: seamRowByDbId };

  const manifest = {
    package_type: PACKAGE_TYPE,
    package_version: PACKAGE_VERSION,
    exported_at: new Date().toISOString(),
    source: { project_id: project.id, version: project.version },
    project: {
      name: project.name,
      tolerance_mm: project.tolerance_mm,
      version: project.version,
    },
    sherds: manifestSherds,
    seams: manifestSeams,
    checks: {
      all_cycles_within_tolerance: allWithin,
      cycle_residuals: comp.residuals.map((r) => ({
        seam_ord: seamRowByDbId.get(r.seam_id),
        from_ord: sherdRowByDbId.get(r.from_id),
        to_ord: sherdRowByDbId.get(r.to_id),
        distance_mm: round3(r.distance_mm),
        rotation_deg: round3(r.rotation_deg),
        within_tolerance: !!r.within_tolerance,
      })),
      layout_fingerprint: layoutFingerprint(comp, project.tolerance_mm, exportMaps),
    },
  };

  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  entries.push({ name: MANIFEST_PATH, data: manifestBuf });
  return createZip(entries);
}

// ---------- 导入：校验 ZIP → 导入计划（全程不写库、不落盘）----------

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function validatePhotoPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 500) return '照片路径必须是非空字符串';
  if (p.includes('\\')) return '照片路径不能包含反斜杠';
  if (path.isAbsolute(p) || /^[a-zA-Z]:/.test(p)) return '照片路径必须是包内相对路径';
  const parts = p.split('/');
  if (parts[0] !== 'photos' || parts.length !== 2 || !parts[1]) return '照片必须位于 photos/ 目录下';
  if (parts[1].includes('..')) return '照片路径非法';
  const ext = path.extname(parts[1]).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return '照片仅支持 .jpg/.jpeg/.png/.webp';
  return null;
}

// 返回导入计划：{ manifest, planSherds: [{ manifest 字段 + image: {buf,digest,mime,ext} }],
//                 planSeams, comp（用临时 id 重算的布局）, violations }
function readAndValidatePackage(zipBuffer, { maxPhotoBytes } = {}) {
  let files;
  try {
    files = unzip(zipBuffer);
  } catch (e) {
    throw new PackageError(`方案包不是合法 ZIP：${e.message}`, 'invalid_zip');
  }

  // 1) 清单存在且唯一、JSON 合法
  if (!files.has(MANIFEST_PATH)) {
    throw new PackageError('方案包缺少 manifest.json 清单', 'package_manifest_missing');
  }
  let manifest;
  try {
    manifest = JSON.parse(files.get(MANIFEST_PATH).data.toString('utf8'));
  } catch (e) {
    throw new PackageError(`清单 manifest.json 不是合法 JSON：${e.message}`, 'package_manifest_invalid');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new PackageError('清单必须是 JSON 对象', 'package_manifest_invalid');
  }
  if (manifest.package_type !== PACKAGE_TYPE) {
    throw new PackageError('清单 package_type 不是本工作台的方案包', 'package_manifest_invalid');
  }
  if (manifest.package_version !== 1) {
    throw new PackageError(`不支持的方案包版本（${manifest.package_version}）`, 'package_version_unsupported');
  }

  // 2) 参数（名称 / 毫米容差）
  const proj = manifest.project;
  if (!proj || typeof proj !== 'object') {
    throw new PackageError('清单缺少 project 参数段', 'invalid_parameters');
  }
  if (typeof proj.name !== 'string' || !proj.name.trim()) {
    throw new PackageError('方案名称缺失或为空', 'invalid_parameters');
  }
  if (proj.name.length > 2000) throw new PackageError('方案名称过长', 'invalid_parameters');
  const tolerance = Number(proj.tolerance_mm);
  if (!Number.isFinite(tolerance) || tolerance < 0.01 || tolerance > 10000) {
    throw new PackageError('毫米容差必须在 0.01 ~ 10000 mm 之间', 'invalid_parameters');
  }

  // 3) 陶片清单
  if (!Array.isArray(manifest.sherds)) throw new PackageError('清单 sherds 必须是数组', 'invalid_manifest');
  if (manifest.sherds.length === 0) throw new PackageError('方案包不包含任何陶片', 'invalid_manifest');
  if (manifest.sherds.length > MAX_SHERDS) throw new PackageError(`陶片数量超过上限 ${MAX_SHERDS}`, 'invalid_manifest');
  if (!Array.isArray(manifest.seams)) throw new PackageError('清单 seams 必须是数组', 'invalid_manifest');
  if (manifest.seams.length > MAX_SEAMS) throw new PackageError(`接缝数量超过上限 ${MAX_SEAMS}`, 'invalid_manifest');

  const seenOrds = new Set();
  const planSherds = manifest.sherds.map((sh, i) => {
    const ord = i + 1;
    const where = `陶片 #${ord}`;
    if (!sh || typeof sh !== 'object' || Array.isArray(sh)) {
      throw new PackageError(`${where} 不是对象`, 'invalid_manifest');
    }
    // ord 字段若给出则必须与位置一致（采纳/排列顺序是包契约的一部分）
    if (sh.ord !== undefined && sh.ord !== ord) {
      throw new PackageError(`${where} 的序号 ord=${sh.ord} 与其排列位置不一致`, 'invalid_manifest');
    }
    if (seenOrds.has(ord)) throw new PackageError(`${where} 序号重复`, 'invalid_manifest');
    seenOrds.add(ord);
    if (typeof sh.label !== 'string' || !sh.label.trim()) {
      throw new PackageError(`${where} 缺少名称`, 'invalid_parameters');
    }
    if (sh.label.length > MAX_NOTE_LEN) throw new PackageError(`${where} 名称过长`, 'invalid_parameters');
    const imgW = Number(sh.img_w);
    const imgH = Number(sh.img_h);
    if (!Number.isInteger(imgW) || imgW < 1 || imgW > 20000 ||
        !Number.isInteger(imgH) || imgH < 1 || imgH > 20000) {
      throw new PackageError(`${where} 图像宽高必须是 1~20000 的整数`, 'invalid_parameters');
    }
    let scalePx = null;
    let scaleMm = null;
    if (sh.scale_px !== null && sh.scale_px !== undefined) {
      scalePx = Number(sh.scale_px);
      if (!Number.isFinite(scalePx) || scalePx < 0.001 || scalePx > 100000) {
        throw new PackageError(`${where} 比例尺像素值非法`, 'invalid_parameters');
      }
    }
    if (sh.scale_mm !== null && sh.scale_mm !== undefined) {
      scaleMm = Number(sh.scale_mm);
      if (!Number.isFinite(scaleMm) || scaleMm < 0.001 || scaleMm > 100000) {
        throw new PackageError(`${where} 比例尺毫米值非法`, 'invalid_parameters');
      }
    }
    if ((scalePx === null) !== (scaleMm === null)) {
      throw new PackageError(`${where} 比例尺必须同时给出像素与毫米值，或同时为空`, 'invalid_parameters');
    }
    const note = typeof sh.note === 'string' ? sh.note : '';
    if (note.length > MAX_NOTE_LEN) throw new PackageError(`${where} 备注过长`, 'invalid_parameters');

    const pathErr = validatePhotoPath(sh.image_path);
    if (pathErr) throw new PackageError(`${where} ${pathErr}`, 'invalid_photo_path');
    if (typeof sh.image_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sh.image_sha256)) {
      throw new PackageError(`${where} 照片摘要 image_sha256 必须是 64 位十六进制`, 'invalid_checksum');
    }
    if (!Number.isInteger(sh.image_bytes) || sh.image_bytes < 1) {
      throw new PackageError(`${where} 照片字节数非法`, 'invalid_manifest');
    }
    return {
      ord, label: sh.label, image_path: sh.image_path, image_sha256: sh.image_sha256,
      image_bytes: sh.image_bytes, img_w: imgW, img_h: imgH,
      scale_px: scalePx, scale_mm: scaleMm, note,
    };
  });

  // 4) 文件集合核对：缺失 / 重复引用 / 包内多余文件 / 越界路径已在 unzip 拦截
  const refCount = new Map();
  for (const sh of planSherds) refCount.set(sh.image_path, (refCount.get(sh.image_path) || 0) + 1);
  for (const [p, n] of refCount) {
    if (n > 1) throw new PackageError(`照片文件被多片陶片重复引用：${p}`, 'duplicate_photo');
    if (!files.has(p)) throw new PackageError(`清单引用的照片在包内缺失：${p}`, 'missing_photo');
  }
  for (const name of files.keys()) {
    if (name === MANIFEST_PATH) continue;
    if (!name.startsWith(PHOTOS_DIR)) {
      throw new PackageError(`包内存在 photos/ 与清单之外的非法路径：${name}`, 'invalid_photo_path');
    }
    if (!refCount.has(name)) {
      throw new PackageError(`包内存在清单未引用的多余照片：${name}`, 'unexpected_photo');
    }
  }

  // 5) 照片字节：大小 / 摘要 / 魔数
  for (const sh of planSherds) {
    const entry = files.get(sh.image_path);
    const buf = entry.data;
    if (maxPhotoBytes && buf.length > maxPhotoBytes) {
      throw new PackageError(`陶片 #${sh.ord} 照片超过单张大小上限`, 'photo_too_large');
    }
    if (buf.length !== sh.image_bytes) {
      throw new PackageError(`陶片 #${sh.ord} 照片字节数与清单不符`, 'checksum_mismatch');
    }
    const digest = sha256(buf);
    if (digest !== sh.image_sha256) {
      throw new PackageError(
        `陶片 #${sh.ord} 照片 sha256 校验失败：包内照片与清单摘要不一致`,
        'checksum_mismatch',
        { sherd_ord: sh.ord, expected: sh.image_sha256, actual: digest });
    }
    const sniffed = sniffImage(buf);
    if (!sniffed) throw new PackageError(`陶片 #${sh.ord} 照片内容不是受支持的图片（JPG/PNG/WebP）`, 'invalid_photo_content');
    const ext = path.extname(sh.image_path).toLowerCase();
    const extNorm = ext === '.jpeg' ? '.jpg' : ext;
    if (extNorm !== sniffed.ext) {
      throw new PackageError(
        `陶片 #${sh.ord} 照片扩展名（${ext}）与实际内容（${sniffed.mime}）不符`,
        'invalid_photo_content');
    }
    sh.image = { buf, digest, mime: sniffed.mime, ext: sniffed.ext };
  }

  // 6) 接缝：序号连续、两端陶片存在且不同且已标比例尺、参数合法
  const planSeams = manifest.seams.map((sm, i) => {
    const ord = i + 1;
    const where = `接缝 #${ord}`;
    if (!sm || typeof sm !== 'object' || Array.isArray(sm)) {
      throw new PackageError(`${where} 不是对象`, 'invalid_manifest');
    }
    if (sm.ord !== undefined && sm.ord !== ord) {
      throw new PackageError(`${where} 的序号 ord 与其排列位置不一致（接缝必须按采纳顺序排列）`, 'invalid_manifest');
    }
    const fromOrd = Number(sm.from_ord);
    const toOrd = Number(sm.to_ord);
    if (!Number.isInteger(fromOrd) || !Number.isInteger(toOrd) ||
        fromOrd < 1 || fromOrd > planSherds.length || toOrd < 1 || toOrd > planSherds.length) {
      throw new PackageError(`${where} 两端陶片序号越界`, 'invalid_seam');
    }
    if (fromOrd === toOrd) throw new PackageError(`${where} 连接了同一片陶片`, 'invalid_seam');
    const theta = Number(sm.theta_deg);
    const tx = Number(sm.tx);
    const ty = Number(sm.ty);
    if (!Number.isFinite(theta) || theta < -360 || theta > 360) {
      throw new PackageError(`${where} 旋转角必须在 -360~360°`, 'invalid_seam');
    }
    if (!Number.isFinite(tx) || !Number.isFinite(ty) || tx < -100000 || tx > 100000 || ty < -100000 || ty > 100000) {
      throw new PackageError(`${where} 平移毫米值必须在 -100000~100000`, 'invalid_seam');
    }
    const note = typeof sm.join_note === 'string' ? sm.join_note : '';
    if (note.length > MAX_NOTE_LEN) throw new PackageError(`${where} 说明过长`, 'invalid_seam');
    const fromSh = planSherds[fromOrd - 1];
    const toSh = planSherds[toOrd - 1];
    if (!fromSh.scale_px || !toSh.scale_px) {
      throw new PackageError(`${where} 两端陶片尚未标记毫米比例尺，不能存在接缝`, 'invalid_seam');
    }
    return { ord, from_ord: fromOrd, to_ord: toOrd, theta_deg: theta, tx, ty, join_note: note };
  });

  // 7) 以临时本地 id（= ord）重算布局：闭合环全部必须在容差内
  const tempSherds = planSherds.map((sh) => ({
    id: sh.ord,
    label: sh.label,
    img_w: sh.img_w,
    img_h: sh.img_h,
    scale_px: sh.scale_px,
    scale_mm: sh.scale_mm,
  }));
  const tempSeams = planSeams.map((sm) => ({
    id: sm.ord,
    from_id: sm.from_ord,
    to_id: sm.to_ord,
    theta_deg: sm.theta_deg,
    tx: sm.tx,
    ty: sm.ty,
  }));
  const comp = layout.computeLayoutDetailed(tempSherds, tempSeams, tolerance);
  const violations = comp.cycleDetails.filter((c) => !c.within_tolerance);

  return { manifest, planSherds, planSeams, comp, tolerance, violations, tempSherds, tempSeams };
}

// 几何校验（闭合环）单独成步：上层可先解析再据此返回 422。
// 同时复核导出端写入的 checks 段（防止清单声称“全部在容差内”却名不副实）。
function assertCyclesAndChecksum(plan) {
  if (plan.violations.length) {
    const sherdById = new Map(plan.tempSherds.map((s) => [s.id, s]));
    const seamById = new Map(plan.tempSeams.map((s) => [s.id, s]));
    const details = plan.violations.map((v) => ({
      seam_ord: v.seam_id,
      from_ord: v.from_id,
      to_ord: v.to_id,
      deviation_mm: round3(v.distance_mm),
      rotation_deg: round3(v.rotation_deg),
      tolerance_mm: plan.tolerance,
      conflict_chain: {
        sherds: v.conflict_chain.sherd_path.map((id) => ({ ord: id, label: sherdById.get(id).label })),
        seams: v.conflict_chain.seam_path.map((sid) => {
          const se = seamById.get(sid);
          return { ord: sid, from_ord: se.from_id, to_ord: se.to_id };
        }),
        closing_seam: { ord: v.seam_id, from_ord: v.from_id, to_ord: v.to_id },
      },
    }));
    throw new PackageError(
      `方案包有 ${details.length} 个闭合环残差超过 ${plan.tolerance} mm 容差，整包拒绝导入`,
      'package_cycle_tolerance_exceeded',
      { tolerance_mm: plan.tolerance, violations: details });
  }

  const checks = plan.manifest.checks;
  if (!checks || typeof checks !== 'object') {
    throw new PackageError('清单缺少 checks 校验段', 'invalid_manifest');
  }
  if (checks.all_cycles_within_tolerance !== true) {
    throw new PackageError('清单未声明全部闭合环在容差内，拒绝导入', 'invalid_manifest');
  }

  // 8) 布局指纹：导入端以同一引擎现算的布局必须与导出端一致
  if (typeof checks.layout_fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(checks.layout_fingerprint)) {
    throw new PackageError('清单缺少合法的布局指纹 layout_fingerprint', 'invalid_manifest');
  }
  const actual = layoutFingerprint(plan.comp, plan.tolerance, null);
  if (actual !== checks.layout_fingerprint) {
    throw new PackageError(
      '导入重算布局与清单布局指纹不一致：包内接缝/比例尺数据与源方案布局不等价，整包拒绝',
      'layout_mismatch',
      { expected: checks.layout_fingerprint, actual });
  }
}

module.exports = {
  PACKAGE_TYPE,
  PACKAGE_VERSION,
  PackageError,
  sniffImage,
  buildPackageZip,
  readAndValidatePackage,
  assertCyclesAndChecksum,
  layoutFingerprint,
  normalizeLayout,
  photoInternalName,
  sha256,
  ALLOWED_EXT: [...ALLOWED_EXT],
};
