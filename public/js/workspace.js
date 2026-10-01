import { api } from './api.js';
import { esc, toast, openModal, confirmAsync } from './ui.js';
import { openScaleModal, openAlignModal } from './modals.js';
import { openReviseSeamModal } from './revise.js';
import { openBatchModal } from './batch.js';
import { openMeasurementNamesDialog } from './measure.js';
import {
  sherdPpm, sherdMm, computeCards, sherdWorldPose, hitSherd, applyPose, DEG,
} from './geo-client.js';

export async function mountWorkspace(projectId) {
  const view = document.getElementById('view');
  view.innerHTML = `
    <div class="workspace">
      <aside class="sidebar">
        <div class="sec-title">陶片 <span id="sherd-count"></span></div>
        <div class="upload-box" id="upload-box">
          ➕ 上传陶片照片（点击选择文件）
          <input type="file" id="photo-input" accept="image/png,image/jpeg,image/webp" hidden />
          <input type="text" id="new-label" placeholder="陶片名称（可选）" style="margin-top:8px;width:100%" />
        </div>
        <div class="sherd-list" id="sherd-list"></div>
        <div class="footer">
          <button id="btn-new-seam">新建接缝</button>
          <button id="btn-batch">批量试拼</button>
          <button id="btn-measure" class="secondary">📏 跨片测距</button>
        </div>
      </aside>

      <div class="canvas-wrap" id="canvas-wrap">
        <canvas id="work-canvas"></canvas>
        <div class="canvas-toolbar">
          <button class="secondary" id="zoom-in">＋</button>
          <button class="secondary" id="zoom-out">－</button>
          <button class="secondary" id="zoom-fit">适应</button>
          <span class="kv" id="zoom-label"></span>
        </div>
        <div class="canvas-hint" id="canvas-hint"></div>
      </div>

      <aside class="right-panel" id="right-panel"></aside>
    </div>`;

  let state = await api.getProject(projectId);
  let cards = computeCards(state.layout, state.sherds);
  const imageCache = new Map();
  const selected = { sherdId: null, seamId: null, measurementId: null };
  let highlightSeamIds = new Set();
  let alive = true;

  // 跨片测距点选模式：measureMode 为 true 时，点击陶片依次收集两个测点；
  // pendingMeasure 记录第一个测点 { sherdId, px, py, world }，等选第二个。
  let measureMode = false;
  let pendingMeasure = null;

  // 视图变换（画布世界单位 = 毫米）
  const viewT = { zoom: 1, ox: 0, oy: 0 };
  let seamLabelBoxes = []; // 每帧重算：{x,y,w,h,seamId}
  let stale = false; // 版本过期标记
  let staleSeenVersion = null; // 轮询发现的他人新版本（仅用于横幅提示）

  const cv = document.getElementById('work-canvas');
  const ctx = cv.getContext('2d');
  const wrapEl = document.getElementById('canvas-wrap');

  function getImage(sh) {
    if (imageCache.has(sh.id)) return imageCache.get(sh.id);
    const img = new Image();
    const entry = { img, loaded: false };
    img.onload = () => { entry.loaded = true; draw(); };
    img.src = sh.image_url;
    imageCache.set(sh.id, entry);
    return entry;
  }

  function sherdById(id) { return state.sherds.find((s) => s.id === id); }
  function seamById(id) { return state.seams.find((s) => s.id === id); }
  function cardOfSherd(id) {
    return cards.find((c) => (c.kind === 'group' ? c.group.member_ids.includes(id) : c.sherdId === id));
  }

  function resizeCanvas() {
    if (!alive) return;
    const dpr = window.devicePixelRatio || 1;
    const r = wrapEl.getBoundingClientRect();
    cv.width = Math.round(r.width * dpr);
    cv.height = Math.round(r.height * dpr);
    cv.style.width = `${r.width}px`;
    cv.style.height = `${r.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }
  window.addEventListener('resize', resizeCanvas);

  function fitView() {
    const r = wrapEl.getBoundingClientRect();
    const contentW = cards.contentW || 400;
    const contentH = cards.contentH || 300;
    viewT.zoom = Math.min(r.width / contentW, r.height / contentH) * 0.95;
    if (!Number.isFinite(viewT.zoom) || viewT.zoom <= 0) viewT.zoom = 1;
    viewT.ox = (r.width - contentW * viewT.zoom) / 2;
    viewT.oy = 12;
    draw();
  }

  const w2s = (x, y) => ({ x: x * viewT.zoom + viewT.ox, y: y * viewT.zoom + viewT.oy });
  const s2w = (x, y) => ({ x: (x - viewT.ox) / viewT.zoom, y: (y - viewT.oy) / viewT.zoom });

  function draw() {
    if (!alive) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const r = wrapEl.getBoundingClientRect();
    ctx.clearRect(0, 0, r.width, r.height);
    seamLabelBoxes = [];

    // 卡片底板
    for (const c of cards) {
      const p = w2s(c.x, c.y);
      ctx.fillStyle = '#fffdf8';
      ctx.strokeStyle = '#cfc5b0';
      ctx.lineWidth = 1;
      roundRect(ctx, p.x, p.y, c.w * viewT.zoom, c.h * viewT.zoom, 10);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = c.kind === 'group' ? '#8a5a2b' : '#7a7264';
      ctx.font = '600 13px sans-serif';
      ctx.fillText(c.kind === 'group'
        ? `▣ ${c.title}`
        : `◇ ${c.title}`, p.x + 12, p.y + 20);
    }

    // 接缝（先画线，陶片盖在上面）
    for (const c of cards) {
      if (c.kind !== 'group') continue;
      const g = c.group;
      const treeSet = new Set(g.tree_seam_ids);
      for (const seam of state.seams) {
        if (!g.member_ids.includes(seam.from_id)) continue;
        const isTree = treeSet.has(seam.id);
        const pFrom = sherdWorldPose(state.layout, c, seam.from_id);
        const pTo = sherdWorldPose(state.layout, c, seam.to_id);
        if (!pFrom || !pTo) continue;
        const mA = sherdMm(sherdById(seam.from_id));
        const mB = sherdMm(sherdById(seam.to_id));
        const aW = applyPose(pFrom, mA.wMm / 2, mA.hMm / 2);
        const bW = applyPose(pTo, mB.wMm / 2, mB.hMm / 2);
        const cA = w2s(aW.x, aW.y);
        const cB = w2s(bW.x, bW.y);
        const active = selected.seamId === seam.id || highlightSeamIds.has(seam.id);
        ctx.save();
        ctx.strokeStyle = active ? '#2b6cb0' : isTree ? '#8a5a2b' : '#b0551f';
        ctx.lineWidth = active ? 3.5 : 2;
        if (!isTree) ctx.setLineDash([7, 5]);
        ctx.beginPath();
        ctx.moveTo(cA.x, cA.y);
        ctx.lineTo(cB.x, cB.y);
        ctx.stroke();
        ctx.restore();

        // 编号标签
        const midX = (cA.x + cB.x) / 2, midY = (cA.y + cB.y) / 2;
        const label = `#${seam.id}`;
        ctx.font = '600 11px ui-monospace, Menlo, monospace';
        const tw = ctx.measureText(label).width;
        const bx = midX - tw / 2 - 5, by = midY - 9, bw = tw + 10, bh = 17;
        ctx.fillStyle = active ? '#2b6cb0' : (isTree ? '#8a5a2b' : '#b0551f');
        roundRect(ctx, bx, by, bw, bh, 4);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(label, bx + 5, by + 12.5);
        seamLabelBoxes.push({ x: bx, y: by, w: bw, h: bh, seamId: seam.id });
      }
    }

    // 陶片
    for (const c of cards) {
      const ids = c.kind === 'group' ? c.group.member_ids : [c.sherdId];
      for (const id of ids) {
        const sh = sherdById(id);
        const pose = sherdWorldPose(state.layout, c, id);
        if (!pose) continue;
        const m = sherdMm(sh);
        const entry = getImage(sh);
        const p = w2s(pose.x, pose.y);
        const scale = viewT.zoom / m.ppm;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(pose.theta * DEG);
        ctx.scale(scale, scale);
        if (entry.loaded) {
          ctx.drawImage(entry.img, 0, 0);
        } else {
          ctx.fillStyle = '#ddd4c0';
          ctx.fillRect(0, 0, sh.img_w, sh.img_h);
        }
        // 选中/未设比例尺描边
        ctx.lineWidth = (selected.sherdId === id ? 4 : 1.5) / scale;
        ctx.strokeStyle = selected.sherdId === id ? '#2b6cb0' : (sh.scale_px ? 'rgba(60,50,35,.55)' : '#c07c1e');
        ctx.strokeRect(0, 0, sh.img_w, sh.img_h);
        ctx.restore();

        // 名称
        ctx.save();
        ctx.fillStyle = '#3a2f22';
        ctx.font = '600 12px sans-serif';
        const labelPos = w2s(pose.x, pose.y);
        ctx.fillText(`#${sh.id} ${sh.label}`, labelPos.x + 3, labelPos.y - 4);
        ctx.restore();
      }
    }

    drawMeasurements();
    drawScaleBar();
    document.getElementById('zoom-label').textContent = `缩放 ${(viewT.zoom * 100).toFixed(0)}%（毫米显示）`;
  }

  // 跨片测点像素坐标 → 当前画布世界(mm)坐标。
  // 已连通组内按组内世界位姿定位；断开后各片（单独成卡或分属不同组）也能落在其卡片上，
  // 只是不会画出距离读数（调用方按 computable 决定）。缺比例尺的片无法定位。
  function measurementWorldPoint(shId, px, py) {
    const sh = sherdById(shId);
    const card = cardOfSherd(shId);
    if (!sh || !card || !sh.scale_px) return null;
    const pose = sherdWorldPose(state.layout, card, shId);
    if (!pose) return null;
    const local = { x: px / sherdPpm(sh), y: py / sherdPpm(sh) };
    return applyPose(pose, local.x, local.y);
  }

  function drawMeasurements() {
    // 已保存的跨片测距：可算时画连线与毫米读数；不可算时两个测点灰色描边。
    for (const m of state.measurements || []) {
      const p1 = measurementWorldPoint(m.from_sherd_id, m.from_point.x, m.from_point.y);
      const p2 = measurementWorldPoint(m.to_sherd_id, m.to_point.x, m.to_point.y);
      const active = selected.measurementId === m.id;
      if (p1 && p2 && m.computable) {
        const a = w2s(p1.x, p1.y);
        const b = w2s(p2.x, p2.y);
        ctx.save();
        ctx.strokeStyle = active ? '#b3392f' : '#7a3eb1';
        ctx.lineWidth = active ? 3 : 2;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
        drawMeasureDot(a.x, a.y, active ? '#b3392f' : '#7a3eb1');
        drawMeasureDot(b.x, b.y, active ? '#b3392f' : '#7a3eb1');
        const label = `${m.distance_mm} mm`;
        ctx.font = '700 12px ui-monospace, Menlo, monospace';
        const tw = ctx.measureText(label).width;
        const lx = (a.x + b.x) / 2 - tw / 2 - 6, ly = (a.y + b.y) / 2 - 22;
        ctx.fillStyle = active ? '#b3392f' : '#7a3eb1';
        roundRect(ctx, lx, ly, tw + 12, 18, 5);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(label, lx + 6, ly + 13);
        ctx.restore();
      } else {
        for (const [shId, pt, name] of [
          [m.from_sherd_id, m.from_point, m.from_name],
          [m.to_sherd_id, m.to_point, m.to_name],
        ]) {
          const p = measurementWorldPoint(shId, pt.x, pt.y);
          if (!p) continue;
          const s = w2s(p.x, p.y);
          ctx.save();
          ctx.strokeStyle = '#9a9284';
          ctx.fillStyle = '#fffdf8';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#9a9284';
          ctx.font = '11px sans-serif';
          ctx.fillText('不可计算', s.x + 7, s.y - 6);
          ctx.restore();
        }
      }
    }

    // 点选模式中已选中的第一个测点（黄色高亮）。
    if (measureMode && pendingMeasure) {
      const s = w2s(pendingMeasure.world.x, pendingMeasure.world.y);
      drawMeasureDot(s.x, s.y, '#d18c12');
    }
  }

  function drawMeasureDot(x, y, color) {
    ctx.save();
    ctx.fillStyle = '#fffdf8';
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawScaleBar() {
    // 右下角比例尺：选一个使屏幕长度在 60~140px 的整数毫米数
    const r = wrapEl.getBoundingClientRect();
    const candidates = [1, 2, 5, 10, 20, 50, 100, 200, 500];
    const target = candidates.find((mm) => mm * viewT.zoom >= 70) || 1000;
    const len = target * viewT.zoom;
    const x0 = r.width - len - 24, y0 = r.height - 24;
    ctx.save();
    ctx.strokeStyle = '#2e2a24';
    ctx.fillStyle = '#2e2a24';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + len, y0);
    ctx.moveTo(x0, y0 - 5); ctx.lineTo(x0, y0 + 5);
    ctx.moveTo(x0 + len, y0 - 5); ctx.lineTo(x0 + len, y0 + 5);
    ctx.stroke();
    ctx.font = '12px sans-serif';
    ctx.fillText(`${target} mm`, x0, y0 - 8);
    ctx.restore();
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // ---------- 画布交互 ----------
  let panning = false, panStart = null;
  cv.addEventListener('mousedown', (e) => {
    panning = true;
    panStart = { x: e.clientX, y: e.clientY, ox: viewT.ox, oy: viewT.oy };
    cv.classList.add('panning');
  });
  window.addEventListener('mousemove', (e) => {
    if (!panning) return;
    viewT.ox = panStart.ox + e.clientX - panStart.x;
    viewT.oy = panStart.oy + e.clientY - panStart.y;
    draw();
  });
  window.addEventListener('mouseup', () => { panning = false; cv.classList.remove('panning'); });

  cv.addEventListener('click', (e) => {
    if (panStart && (Math.abs(e.clientX - panStart.x) > 3 || Math.abs(e.clientY - panStart.y) > 3)) return;
    const r = cv.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const w = s2w(sx, sy);
    const hit = hitSherd(w.x, w.y, state.sherds, state.layout, cards);

    // 跨片测距点选模式：依次在两片上取点，不改变常规选中态。
    if (measureMode) {
      if (hit && hit.sherd) {
        handleMeasurePick(hit, w);
      } else {
        toast('请在陶片照片范围内点击测点', 'warn');
      }
      return;
    }

    // 接缝标签优先
    const lab = seamLabelBoxes.find((b) => sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h);
    if (lab) { selected.seamId = lab.seamId; selected.sherdId = null; selected.measurementId = null; highlightSeamIds = new Set([lab.seamId]); renderAll(); return; }
    if (hit && hit.sherd) {
      selected.sherdId = hit.sherd.id;
      selected.seamId = null;
      selected.measurementId = null;
      const card = hit.card;
      const chain = card.kind === 'group' ? (card.group.chains[hit.sherd.id] || []) : [];
      highlightSeamIds = new Set(chain);
    } else {
      selected.sherdId = null; selected.seamId = null; selected.measurementId = null; highlightSeamIds = new Set();
    }
    renderAll();
  });

  // 在某片照片上点到一个测点（local 为该片局部毫米坐标），换算为照片像素后暂存。
  function handleMeasurePick(hit, world) {
    const sh = hit.sherd;
    if (!sh.scale_px) {
      toast(`陶片 #${sh.id} 尚未标记毫米比例尺，不能作为测距测点`, 'warn');
      return;
    }
    const ppm = sherdPpm(sh);
    const px = hit.local.x * ppm;
    const py = hit.local.y * ppm;
    const pick = { sherdId: sh.id, px, py, world: { x: world.x, y: world.y } };
    if (!pendingMeasure) {
      pendingMeasure = pick;
      draw();
      toast(`已选起点（#${sh.id}），再到另一片陶片上点击终点；点“退出测距”放弃`, 'success');
      return;
    }
    if (pendingMeasure.sherdId === sh.id) {
      // 允许改主意：在同一片上再次点击即把它当作新的起点。
      pendingMeasure = pick;
      draw();
      toast('两个测点需位于两片不同陶片；已将本次点击记为新的起点，请换一片点终点', 'warn');
      return;
    }
    const first = pendingMeasure;
    pendingMeasure = null;
    submitMeasurement(first, pick).finally(() => draw());
  }

  async function submitMeasurement(fromPick, toPick) {
    const names = await openMeasurementNamesDialog({
      fromPick, toPick, sherdById: (id) => sherdById(id),
    });
    if (!names) return; // 用户取消：不写入
    const payload = {
      from_sherd_id: fromPick.sherdId,
      to_sherd_id: toPick.sherdId,
      from_name: names.from_name,
      to_name: names.to_name,
      from_point: { x: Math.round(fromPick.px * 100) / 100, y: Math.round(fromPick.py * 100) / 100 },
      to_point: { x: Math.round(toPick.px * 100) / 100, y: Math.round(toPick.py * 100) / 100 },
    };
    try {
      const next = await api.createMeasurement(state.project.id, state.project.version, payload);
      applyServerState(next);
      const m = next.measurements[next.measurements.length - 1];
      selected.measurementId = m.id;
      renderAll();
      if (m.computable) toast(`跨片测距已记录：${m.distance_mm} mm。测距模式仍开启，可继续选两片`, 'success');
      else toast('跨片测点已保存，但当前两片不可计算（未连通）', 'warn');
    } catch (e) {
      handleWriteError(e);
    }
  }

  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const before = s2w(sx, sy);
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    viewT.zoom = Math.min(40, Math.max(0.02, viewT.zoom * factor));
    viewT.ox = sx - before.x * viewT.zoom;
    viewT.oy = sy - before.y * viewT.zoom;
    draw();
  }, { passive: false });

  document.getElementById('zoom-in').onclick = () => { viewT.zoom *= 1.2; draw(); };
  document.getElementById('zoom-out').onclick = () => { viewT.zoom /= 1.2; draw(); };
  document.getElementById('zoom-fit').onclick = fitView;

  // ---------- 侧栏 ----------
  function renderSidebar() {
    document.getElementById('sherd-count').textContent = `${state.sherds.length} 片`;
    const list = document.getElementById('sherd-list');
    list.innerHTML = state.sherds.map((sh) => `
      <div class="sherd-item ${selected.sherdId === sh.id ? 'active' : ''}" data-id="${sh.id}">
        <img class="thumb" src="${sh.image_url}" alt="" />
        <div class="meta">
          <div class="name">#${sh.id} ${esc(sh.label)}</div>
          <div class="sub">
            ${sh.scale_px
              ? `<span class="badge ok">${sh.img_w}×${sh.img_h} · ${(sh.scale_px / sh.scale_mm).toFixed(2)}px/mm</span>`
              : `<span class="badge warn">未设比例尺</span>`}
          </div>
        </div>
      </div>`).join('');
    list.querySelectorAll('.sherd-item').forEach((el) => {
      el.onclick = () => {
        selected.sherdId = parseInt(el.dataset.id, 10);
        selected.seamId = null;
        const card = cardOfSherd(selected.sherdId);
        const chain = card && card.kind === 'group' ? (card.group.chains[selected.sherdId] || []) : [];
        highlightSeamIds = new Set(chain);
        renderAll();
      };
    });
  }

  // ---------- 右栏 ----------
  function renderRightPanel() {
    const panel = document.getElementById('right-panel');
    const p = state.project;
    const residualsById = new Map(state.layout.residuals.map((r) => [r.seam_id, r]));

    panel.innerHTML = `
      <div class="pane">
        <h3>方案设置</h3>
        <div class="kv">
          <input type="text" id="p-name" value="${esc(p.name)}" style="width:100%;margin-bottom:8px" />
          <label class="field">毫米容差（成环闭合误差超过即拒绝）
            <div style="display:flex;gap:8px;align-items:center">
              <input type="number" id="p-tol" min="0.01" step="0.1" value="${p.tolerance_mm}" />
              <span>mm</span>
              <button id="p-save" style="margin-left:auto">保存</button>
            </div>
          </label>
          <div style="margin-top:6px">版本号 v${p.version} · 更新于 ${esc(p.updated_at || '')}</div>
          <div id="stale-banner"></div>
        </div>
      </div>

      <div class="pane" id="pane-sherd"></div>
      <div class="pane" id="pane-measurements"></div>
      <div class="pane flex" id="pane-seams"></div>`;

    document.getElementById('p-save').onclick = saveProjectSettings;
    if (stale) {
      const b = document.getElementById('stale-banner');
      b.innerHTML = `<div class="conflict-box">⚠ 检测到其他人已更新方案（服务器最新 v${staleSeenVersion}，你停留在 v${state.project.version}）。
        <button id="stale-reload" style="margin-top:8px">立即刷新到最新版本</button></div>`;
      document.getElementById('stale-reload').onclick = () => location.reload();
    }

    renderSherdPane();
    renderMeasurementsPane();
    renderSeamsPane(residualsById);
  }

  // 该片涉及的测点标注（删除陶片时服务器会一并清除这些测距）。
  function relatedMeasurementsHtml(shId) {
    const related = (state.measurements || []).filter(
      (m) => m.from_sherd_id === shId || m.to_sherd_id === shId
    );
    if (!related.length) return '';
    const items = related.map((m) => {
      const isFrom = m.from_sherd_id === shId;
      const name = isFrom ? m.from_name : m.to_name;
      const otherId = isFrom ? m.to_sherd_id : m.from_sherd_id;
      const val = m.computable
        ? `<b>${m.distance_mm} mm</b>`
        : '<span class="residual bad">不可计算</span>';
      return `<div class="kv">📏 #${m.id} ${esc(name)} ↔ 陶片 #${otherId}：${val}</div>`;
    }).join('');
    return `<div style="margin-top:8px"><div class="kv" style="font-weight:600;color:var(--ink)">涉及测点标注（${related.length}）</div>${items}</div>`;
  }

  function renderSherdPane() {
    const pane = document.getElementById('pane-sherd');
    const sh = selected.sherdId ? sherdById(selected.sherdId) : null;
    if (!sh) {
      pane.innerHTML = '<h3>陶片详情</h3><div class="kv">点击画布或左侧列表中的陶片查看其位置依据。</div>';
      return;
    }
    const card = cardOfSherd(sh.id);
    const chain = card && card.kind === 'group' ? (card.group.chains[sh.id] || []) : [];
    const pose = card && card.kind === 'group' ? card.group.poses[sh.id] : null;
    const m = sherdMm(sh);

    const chainHtml = chain.length
      ? `<div class="chain-card" id="chain-card">
          <div>位置依据 — 自根片 <b>#${card.group.root_sherd_id}</b> 起的接缝链：</div>
          <div class="chain-seams">${chain.map((id) => `#${id}`).join(' → ')}</div>
          <div class="kv" style="margin-top:4px">共 ${chain.length} 条接缝；点击可在画布高亮此链</div>
        </div>`
      : (card && card.kind === 'group'
          ? '<div class="kv">该片是该连通组的<b>根片</b>，位姿为 (0, 0, 0°)。</div>'
          : '<div class="kv">该片<b>未与任何陶片连通</b>，单独显示。</div>');

    pane.innerHTML = `
      <h3>陶片 #${sh.id} ${esc(sh.label)}</h3>
      <div class="kv">
        图像：${sh.img_w} × ${sh.img_h} px<br/>
        ${sh.scale_px
          ? `比例尺：${sh.scale_px} px = ${sh.scale_mm} mm（1 mm ≈ ${m.ppm.toFixed(3)} px）<br/>片尺寸：${m.wMm.toFixed(1)} × ${m.hMm.toFixed(1)} mm`
          : '<span class="badge warn">尚未标记毫米比例尺</span>'}
        ${pose ? `<br/>世界位姿：x=${pose.x} mm, y=${pose.y} mm, θ=${pose.theta}°` : ''}
      </div>
      ${chainHtml}
      ${relatedMeasurementsHtml(sh.id)}
      <div style="display:flex;gap:8px;margin-top:10px">
        <button id="btn-scale">${sh.scale_px ? '修改比例尺' : '标记比例尺'}</button>
        <button class="danger" id="btn-del-sherd">删除陶片</button>
      </div>`;

    document.getElementById('btn-scale').onclick = () =>
      openScaleModal(sh, state.project.version, applyServerState);
    document.getElementById('btn-del-sherd').onclick = async () => {
      if (await confirmAsync(`确认删除陶片 #${sh.id}「${sh.label}」？相关接缝会一并删除。`)) {
        try {
          await api.deleteSherd(sh.id, state.project.version);
          selected.sherdId = null;
          await reloadState();
          toast('陶片已删除', 'success');
        } catch (e) { handleWriteError(e); }
      }
    };
    const cc = document.getElementById('chain-card');
    if (cc) cc.onclick = () => { highlightSeamIds = new Set(chain); draw(); renderSeamsPane(new Map(state.layout.residuals.map((r) => [r.seam_id, r]))); };
  }

  function renderMeasurementsPane() {
    const pane = document.getElementById('pane-measurements');
    const list = state.measurements || [];
    if (!list.length) {
      pane.innerHTML = '<h3>跨片测距</h3><div class="kv">尚无测距。点左侧 <b>📏 跨片测距</b>，依次在两片陶片照片上点击测点。</div>';
      return;
    }
    const rows = list.map((m) => {
      const a = sherdById(m.from_sherd_id);
      const b = sherdById(m.to_sherd_id);
      const active = selected.measurementId === m.id ? ' active' : '';
      const body = m.computable
        ? `<div class="measure-val">${m.distance_mm} <span class="kv">mm</span></div>
           <div class="kv">${esc(m.from_name)} → ${esc(m.to_name)}</div>`
        : `<div class="measure-val bad">不可计算</div>
           <div class="kv">${esc(m.from_name)} → ${esc(m.to_name)}<br/>原因：${
             m.reason === 'disconnected' ? '两片当前未连通（测点保留，重连后自动恢复读数）' : '存在未标比例尺的陶片'}</div>`;
      return `<div class="measure-row${active}" data-id="${m.id}">
        <div class="top">
          <span class="kv"><b>#${m.id}</b>
            #${m.from_sherd_id} ${esc(a ? a.label : '?')} → #${m.to_sherd_id} ${esc(b ? b.label : '?')}
          </span>
          <button class="danger" data-del="${m.id}">删除</button>
        </div>
        ${body}
      </div>`;
    }).join('');
    pane.innerHTML = `<h3>跨片测距（${list.length}）</h3>
      <div class="kv" style="margin-bottom:6px">读数按当前比例尺与已采纳接缝现算；两片断开时测点保留、读数不可计算，重连后恢复。</div>
      ${rows}`;

    pane.querySelectorAll('.measure-row').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.dataset.del) return;
        selected.measurementId = parseInt(el.dataset.id, 10);
        selected.sherdId = null;
        selected.seamId = null;
        renderAll();
      });
    });
    pane.querySelectorAll('[data-del]').forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.del, 10);
        const m = (state.measurements || []).find((x) => x.id === id);
        if (!m) return;
        if (await confirmAsync(`删除跨片测距 #${id}（${m.from_name} → ${m.to_name}）？`)) {
          try {
            const next = await api.deleteMeasurement(id, state.project.version);
            if (selected.measurementId === id) selected.measurementId = null;
            applyServerState(next);
            toast('跨片测距已删除', 'success');
          } catch (err) { handleWriteError(err); }
        }
      };
    });
  }

  function renderSeamsPane(residualsById) {
    const pane = document.getElementById('pane-seams');
    const treeSet = new Set();
    state.layout.groups.forEach((g) => g.tree_seam_ids.forEach((id) => treeSet.add(id)));

    const rows = state.seams.map((s) => {
      const res = residualsById.get(s.id);
      const a = sherdById(s.from_id), b = sherdById(s.to_id);
      return `<div class="seam-row ${selected.seamId === s.id ? 'active' : ''}" data-id="${s.id}">
        <div class="top">
          <span>
            <b>#${s.id}</b>
            <span class="${treeSet.has(s.id) ? 'tag-tree' : 'tag-cycle'}">
              ${treeSet.has(s.id) ? '生成树接缝' : '成环接缝'}
            </span><br/>
            <span class="kv">#${s.from_id} ${esc(a ? a.label : '')} → #${s.to_id} ${esc(b ? b.label : '')}</span>
          </span>
          <span class="seam-actions">
            <button class="secondary" data-revise="${s.id}">修订</button>
            <button class="danger" data-undo="${s.id}">撤销</button>
          </span>
        </div>
        <div class="kv">θ=${s.theta_deg}°, tx=${s.tx} mm, ty=${s.ty} mm</div>
        ${s.join_note ? `<div class="note">📝 ${esc(s.join_note)}</div>` : ''}
        ${res ? `<div class="residual ${res.within_tolerance ? 'ok' : 'bad'}">
          闭合残差：${res.distance_mm} mm / ${res.rotation_deg}°
          ${res.within_tolerance ? '✔ 容差内' : `✘ 超容差 ${state.project.tolerance_mm} mm`}
        </div>` : ''}
      </div>`;
    }).join('');

    pane.innerHTML = `<h3>接缝（${state.seams.length}）</h3>
      <div class="legend">
        <span><i style="border-color:#8a5a2b"></i>生成树（决定布局）</span>
        <span><i style="border-color:#b0551f"></i>成环（仅校验残差）</span>
      </div>
      <div style="margin-top:8px">${rows || '<div class="kv">尚无接缝。选中两片后点“新建接缝”。</div>'}</div>`;

    pane.querySelectorAll('.seam-row').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.dataset.undo || e.target.dataset.revise) return;
        selected.seamId = parseInt(el.dataset.id, 10);
        selected.sherdId = null;
        highlightSeamIds = new Set([selected.seamId]);
        renderAll();
      });
    });
    pane.querySelectorAll('[data-revise]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.revise, 10);
        const seam = seamById(id);
        if (!seam) return;
        openReviseSeamModal(seam, {
          getVersion: () => state.project.version,
          onApplied: async (next) => {
            applyServerState(next);
            toast(`接缝 #${id} 已修订，版本推进到 v${next.project.version}，布局与预览一致`, 'success');
          },
          onError: handleWriteError,
        });
      };
    });
    pane.querySelectorAll('[data-undo]').forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.undo, 10);
        const seam = seamById(id);
        if (await confirmAsync(`撤销接缝 #${id}（#${seam.from_id} → #${seam.to_id}）？连通组与位置将立即重新计算。`)) {
          try {
            await api.deleteSeam(id, state.project.version);
            selected.seamId = null;
            highlightSeamIds = new Set();
            await reloadState();
            toast('接缝已撤销，布局已重新推导', 'success');
          } catch (err) { handleWriteError(err); }
        }
      };
    });
  }

  async function saveProjectSettings() {
    try {
      const name = document.getElementById('p-name').value.trim() || state.project.name;
      const tol = parseFloat(document.getElementById('p-tol').value);
      const next = await api.patchProject(state.project.id, state.project.version, { name, tolerance_mm: tol });
      applyServerState(next);
      toast('方案设置已保存', 'success');
    } catch (e) { handleWriteError(e); }
  }

  // ---------- 上传 ----------
  const photoInput = document.getElementById('photo-input');
  document.getElementById('upload-box').addEventListener('click', (e) => {
    if (e.target.tagName !== 'INPUT') photoInput.click();
  });
  photoInput.addEventListener('change', async () => {
    const file = photoInput.files[0];
    if (!file) return;
    try {
      const label = document.getElementById('new-label').value.trim() || file.name.replace(/\.[^.]+$/, '').slice(0, 40);
      const { blob, w, h } = await downscalePhoto(file);
      const baseName = file.name.replace(/\.[^.]+$/, '').replace(/[^\w一-龥.-]+/g, '_').slice(0, 60) || 'sherd';
      const fd = new FormData();
      fd.append('photo', blob, baseName + '.jpg');
      fd.append('label', label);
      fd.append('img_w', String(w));
      fd.append('img_h', String(h));
      const next = await api.uploadSherd(state.project.id, state.project.version, fd);
      document.getElementById('new-label').value = '';
      photoInput.value = '';
      applyServerState(next);
      toast('陶片照片已上传，请为其标记毫米比例尺', 'success');
    } catch (err) { handleWriteError(err); }
  });

  function downscalePhoto(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const MAX = 2000;
        const k = Math.min(1, MAX / Math.max(img.width, img.height));
        const w = Math.round(img.width * k), h = Math.round(img.height * k);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        c.toBlob((blob) => resolve({ blob, w, h }), 'image/jpeg', 0.92);
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  // ---------- 新建接缝 ----------
  document.getElementById('btn-new-seam').onclick = chooseSeamEnds;

  // ---------- 批量试拼（候选接缝一批试算 → 单事务确认）----------
  document.getElementById('btn-batch').onclick = () => {
    const scaled = state.sherds.filter((s) => s.scale_px);
    if (scaled.length < 2) return toast('至少要有两片已标记比例尺的陶片', 'warn');
    openBatchModal(state, {
      onApplied: async (next) => {
        applyServerState(next);
        toast(`整批候选接缝已依序采纳，版本推进到 v${next.project.version}（只增加一次）`, 'success');
      },
      onError: handleWriteError,
    });
  };

  // ---------- 跨片测距点选模式 ----------
  document.getElementById('btn-measure').onclick = () => {
    const scaled = state.sherds.filter((s) => s.scale_px);
    if (scaled.length < 1) return toast('请先上传陶片并标记毫米比例尺', 'warn');
    measureMode = !measureMode;
    pendingMeasure = null;
    document.getElementById('btn-measure').classList.toggle('measure-active', measureMode);
    document.getElementById('btn-measure').textContent = measureMode ? '✕ 退出测距' : '📏 跨片测距';
    cv.style.cursor = measureMode ? 'crosshair' : '';
    updateCanvasHint();
    draw();
    if (measureMode) {
      toast('测距模式：在第一片陶片上点起点，再在另一片上点终点', 'success');
    }
  };

  function updateCanvasHint() {
    const el = document.getElementById('canvas-hint');
    if (!el) return;
    if (measureMode) {
      el.innerHTML = '<b style="color:#b3392f">📏 测距模式</b>：在一片陶片上点起点，再到另一片点终点 · 点侧栏“退出测距”取消';
    } else {
      el.textContent = '拖动画布平移 · 滚轮缩放 · 点击陶片选中 · 点击接缝编号查看/撤销';
    }
  }

  function chooseSeamEnds() {
    const scaled = state.sherds.filter((s) => s.scale_px);
    if (scaled.length < 2) return toast('至少要有两片已标记比例尺的陶片', 'warn');
    const { body, close } = openModal({ title: '选择接缝两端' });
    body.innerHTML = `
      <div class="row">
        <label class="field">A 片（参考，固定）
          <select id="sel-a">${scaled.map((s) => `<option value="${s.id}">#${s.id} ${esc(s.label)}</option>`).join('')}</select>
        </label>
        <label class="field">B 片（移动对齐）
          <select id="sel-b">${scaled.map((s) => `<option value="${s.id}">#${s.id} ${esc(s.label)}</option>`).join('')}</select>
        </label>
      </div>
      <p class="align-hint">接缝方向为 A → B：记录“把 A 的局部坐标映射到 B”的旋转与平移。</p>
      <div class="actions">
        <button class="secondary" id="sel-cancel">取消</button>
        <button id="sel-next">下一步：对齐断口</button>
      </div>`;
    const selA = body.querySelector('#sel-a');
    const selB = body.querySelector('#sel-b');
    if (selected.sherdId && scaled.some((s) => s.id === selected.sherdId)) selA.value = String(selected.sherdId);
    if (scaled[1]) selB.value = String(scaled[scaled[0].id === selected.sherdId ? 1 : 0].id);
    body.querySelector('#sel-cancel').onclick = close;
    body.querySelector('#sel-next').onclick = () => {
      const a = parseInt(selA.value, 10), b = parseInt(selB.value, 10);
      if (a === b) return toast('A、B 不能是同一片', 'error');
      close();
      openAlignModal(sherdById(a), sherdById(b), state.project.version, submitSeam);
    };
  }

  async function submitSeam(payload, closeAlign) {
    try {
      const { data, status } = await api.addSeam(state.project.id, state.project.version, payload);
      closeAlign();
      applyServerState(data);
      if (data.closed_cycle) {
        toast(`接缝采纳：成环闭合残差 ${data.cycle_residual.distance_mm} mm，在容差内`, 'success');
      } else {
        toast('接缝已采纳，连通组与布局已更新', 'success');
      }
    } catch (err) {
      if (err.status === 422) {
        // 超差成环：拒绝，不更新本地布局，弹窗指出冲突链
        showCycleConflict(err.data.error);
      } else {
        handleWriteError(err);
      }
    }
  }

  function showCycleConflict(error) {
    const c = error.conflict_chain;
    const { body, close } = openModal({ title: '🚫 接缝被拒绝：成环偏差超容差' });
    body.innerHTML = `
      <div class="conflict-box">
        <div>${esc(error.message)}</div>
        <div style="margin-top:8px">
          <b>冲突接缝链：</b>
          <div class="chain-seams" style="font-family:ui-monospace,Menlo,monospace;margin:6px 0">
            ${c.sherds.map((s) => `#${s.id}`).join(' → ')}
            <br/>沿接缝 ${c.seams.map((s) => `#${s.id}`).join(' → ')}
            再由新接缝 #new(#${c.new_seam.from_id}→#${c.new_seam.to_id}) 闭合
          </div>
          <pre>${c.seams.map((s, i) => `接缝 #${s.id}  (#${s.from_id}→#${s.to_id})${s.join_note ? `  ${s.join_note}` : ''}`).join('\n') || '（链上无接缝）'}</pre>
        </div>
        <div class="kv">布局保持原样，未做任何修改。可检查比例尺、对齐位置或容差设置后重试。</div>
      </div>
      <div class="actions"><button id="cycle-ok">知道了</button></div>`;
    body.querySelector('#cycle-ok').onclick = close;
  }

  function handleWriteError(err) {
    if (err.status === 409) {
      const info = err.data && err.data.error;
      const { body } = openModal({ title: '⚠ 版本冲突' });
      body.innerHTML = `
        <div class="conflict-box">
          <div>${esc(info ? info.message : err.message)}</div>
          <div class="kv" style="margin-top:6px">
            你的修改基于版本 <b>v${info ? info.your_version : '?'}</b>，
            服务器当前为 <b>v${info ? info.current_version : '?'}</b>。<br/>
            为避免静默覆盖他人工作，本次写入已被拒绝。
          </div>
        </div>
        <div class="actions">
          <button class="secondary" id="vc-close">关闭</button>
          <button id="vc-reload">刷新到最新版本</button>
        </div>`;
      body.querySelector('#vc-reload').onclick = () => location.reload();
      body.querySelector('#vc-close').onclick = () => body.closest('.modal-mask').remove();
      return;
    }
    toast(err.message, 'error');
  }

  // ---------- 状态应用 / 轮询 ----------
  function applyServerState(next) {
    state = next;
    cards = computeCards(state.layout, state.sherds);
    stale = false;
    staleSeenVersion = null;
    if (selected.sherdId && !sherdById(selected.sherdId)) selected.sherdId = null;
    if (selected.seamId && !seamById(selected.seamId)) selected.seamId = null;
    const stillHasMeasure = (state.measurements || []).some((m) => m.id === selected.measurementId);
    if (selected.measurementId && !stillHasMeasure) selected.measurementId = null;
    renderAll();
  }

  async function reloadState() {
    const next = await api.getProject(state.project.id);
    applyServerState(next);
  }

  const pollTimer = setInterval(async () => {
    if (!alive) return;
    try {
      const fresh = await api.getProject(state.project.id);
      if (!alive) return;
      if (fresh.project.version !== state.project.version) {
        stale = true;
        staleSeenVersion = fresh.project.version;
        // 不静默替换画布内容，只在右栏提示，由用户决定何时刷新
        renderRightPanel();
        toast('检测到他人更新了方案，请确认后刷新', 'warn');
      }
    } catch { /* 轮询失败忽略 */ }
  }, 10000);

  // 离开工作台（hash 路由切换）时停止轮询，避免旧实例继续刷新 DOM
  const dispose = () => {
    if (!alive) return;
    alive = false;
    clearInterval(pollTimer);
    window.removeEventListener('resize', resizeCanvas);
    window.removeEventListener('hashchange', dispose);
  };
  window.addEventListener('hashchange', dispose);

  function renderAll() {
    renderTopbar();
    renderSidebar();
    renderRightPanel();
    updateCanvasHint();
    draw();
  }

  function renderTopbar() {
    document.getElementById('topbar-right').innerHTML = `
      <span class="ver">方案 v${state.project.version} · 容差 ${state.project.tolerance_mm} mm</span>
      <button class="secondary" id="btn-export-pkg" style="font-size:13px">⬇ 下载方案包</button>
      <a href="#/" style="color:#f6efe2;font-size:13px">← 方案列表</a>`;
    document.getElementById('btn-export-pkg').onclick = () => {
      // 浏览器直接下载；服务器在同一版本快照内打包，下载期间方案被编辑也不影响包内容。
      window.location.href = api.exportProjectUrl(state.project.id);
    };
  }

  renderAll();
  resizeCanvas();
  fitView();
}
