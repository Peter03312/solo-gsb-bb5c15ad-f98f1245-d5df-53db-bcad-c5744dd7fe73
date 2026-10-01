// 跨片测距：两片陶片上各点选一个测点后，弹出本对话框填写两个测点的标注名称。
// 取消则不写入；确认返回 { from_name, to_name }。
import { esc, openModal } from './ui.js';

export function openMeasurementNamesDialog({ fromPick, toPick, sherdById }) {
  const fromSh = sherdById(fromPick.sherdId);
  const toSh = sherdById(toPick.sherdId);
  const { body, close } = openModal({
    title: '记录跨片测距',
  });
  body.innerHTML = `
    <p class="align-hint">
      两个测点分别位于陶片 <b>#${fromSh.id} ${esc(fromSh.label)}</b> 与
      <b>#${toSh.id} ${esc(toSh.label)}</b> 的照片上（像素坐标已随点击记录）。
      为两个测点各填写一个标注名称，确认后按当前比例尺与已采纳接缝计算毫米距离。
    </p>
    <div class="row">
      <label class="field" style="flex:1">起点测点名称（#${fromSh.id} ${esc(fromSh.label)}）
        <input type="text" id="m-from-name" maxlength="200" value="${esc(`${fromSh.label}-测点`)}" />
        <span class="kv">照片像素：(${Math.round(fromPick.px)}, ${Math.round(fromPick.py)})</span>
      </label>
      <label class="field" style="flex:1">终点测点名称（#${toSh.id} ${esc(toSh.label)}）
        <input type="text" id="m-to-name" maxlength="200" value="${esc(`${toSh.label}-测点`)}" />
        <span class="kv">照片像素：(${Math.round(toPick.px)}, ${Math.round(toPick.py)})</span>
      </label>
    </div>
    <div id="m-error" class="conflict-box" style="display:none"></div>
    <div class="actions">
      <button class="secondary" id="m-cancel">取消</button>
      <button id="m-ok">记录测距</button>
    </div>`;

  return new Promise((resolve) => {
    const fromInput = body.querySelector('#m-from-name');
    const toInput = body.querySelector('#m-to-name');
    const errBox = body.querySelector('#m-error');
    fromInput.focus();
    fromInput.select();

    function finish() {
      const fromName = fromInput.value.trim();
      const toName = toInput.value.trim();
      if (!fromName || !toName) {
        errBox.style.display = 'block';
        errBox.textContent = '两个测点名称都不能为空。';
        return;
      }
      close();
      resolve({ from_name: fromName, to_name: toName });
    }
    body.querySelector('#m-ok').onclick = finish;
    [fromInput, toInput].forEach((el) => {
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(); });
    });
    body.querySelector('#m-cancel').onclick = () => { close(); resolve(null); };
  });
}
