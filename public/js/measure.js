// 跨片测距标注弹窗：两个测点已在画布上取好（各自照片的像素坐标），
// 此处填写标注名称并提交。提交前给出按当前布局推算的客户端预读数；
// 服务器为权威——创建时会重新校验（同方案/已标比例尺/同一连通组/坐标在照片内），
// 读数以服务器按当前布局现算并随方案负载返回的为准。
import { api } from './api.js';
import { esc, openModal, toast } from './ui.js';
import { sherdMm, applyPose } from './geo-client.js';

export function openMeasureModal(state, first, second, { getVersion, onApplied, onError }) {
  const shA = state.sherds.find((s) => s.id === first.sherdId);
  const shB = state.sherds.find((s) => s.id === second.sherdId);

  // 客户端预读数：同一连通组内用组内位姿把两个像素测点换算到世界毫米坐标。
  let previewMm = null;
  const g = state.layout.groups.find((gg) => gg.member_ids.includes(first.sherdId));
  if (g && g.member_ids.includes(second.sherdId)) {
    const mA = sherdMm(shA);
    const mB = sherdMm(shB);
    const wA = applyPose(g.poses[first.sherdId], first.x / mA.ppm, first.y / mA.ppm);
    const wB = applyPose(g.poses[second.sherdId], second.x / mB.ppm, second.y / mB.ppm);
    previewMm = Math.hypot(wA.x - wB.x, wA.y - wB.y);
  }

  const { body, close } = openModal({ title: '📏 新建跨片测距标注' });
  body.innerHTML = `
    <div class="kv">
      测点 1：<b>#${shA.id} ${esc(shA.label)}</b>（照片像素 ${first.x.toFixed(1)}, ${first.y.toFixed(1)}）<br/>
      测点 2：<b>#${shB.id} ${esc(shB.label)}</b>（照片像素 ${second.x.toFixed(1)}, ${second.y.toFixed(1)}）<br/>
      ${previewMm !== null
        ? `按当前布局推算的读数：<b>${previewMm.toFixed(3)} mm</b>（保存后随布局变化自动重算）`
        : '两片当前不在同一连通组，服务器将拒绝保存。'}
    </div>
    <div class="row" style="margin-top:12px">
      <label class="field" style="flex:1">标注名称
        <input type="text" id="ms-label" maxlength="200" placeholder="例如：口沿缺口宽度、纹饰间距" />
      </label>
    </div>
    <div class="actions">
      <button class="secondary" id="ms-cancel">取消</button>
      <button id="ms-save">保存测距标注</button>
    </div>`;

  const labelInput = body.querySelector('#ms-label');
  labelInput.focus();
  body.querySelector('#ms-cancel').onclick = close;
  body.querySelector('#ms-save').onclick = async () => {
    const label = labelInput.value.trim();
    if (!label) return toast('请填写标注名称', 'error');
    try {
      const next = await api.addAnnotation(state.project.id, getVersion(), {
        from_id: first.sherdId,
        to_id: second.sherdId,
        from_x: first.x,
        from_y: first.y,
        to_x: second.x,
        to_y: second.y,
        label,
      });
      close();
      onApplied(next);
    } catch (e) {
      close();
      // 400：创建前置校验未通过（原因在 message 中）；409/428 走统一写错误处理。
      if (e.status === 400) toast(`无法保存测距标注：${e.message}`, 'error');
      else onError(e);
    }
  };
}
