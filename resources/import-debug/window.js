const api = window.migrationDebug;
const form = document.querySelector('form');
const output = document.querySelector('output');
const progress = document.querySelector('progress');
const cancel = document.querySelector('#cancel');
const controls = [...form.querySelectorAll('input, button:not(#cancel)')];
let notices = null;
let busy = false;
const getMode = () => form.querySelector('[name=mode]:checked').value;
function updateMode() {
  const copy = getMode() === 'copy';
  for (const element of form.querySelectorAll('[data-copy-only]')) element.hidden = !copy;
  const destination = document.querySelector('#destination');
  destination.required = copy;
  destination.disabled = busy || !copy;
  document.querySelector('[type=submit]').textContent = copy ? '开始复制迁移' : '确认原地接管';
  if (notices) document.querySelector('#mode-notice').textContent = copy ? notices.copy : notices.takeover;
}
function setBusy(value) {
  busy = value;
  controls.forEach(control => { control.disabled = value; });
  cancel.disabled = !value;
  updateMode();
}
function showError(error) {
  output.textContent = error instanceof Error ? error.message : String(error);
}
api.defaults().then(({ destination, notices: suppliedNotices }) => {
  notices = suppliedNotices;
  const field = document.querySelector('#destination');
  if (!field.value) field.value = destination;
  for (const element of document.querySelectorAll('[data-notice]')) {
    element.textContent = notices[element.dataset.notice];
  }
  document.querySelector('[type=submit]').disabled = false;
  updateMode();
}).catch(showError);
form.querySelectorAll('[name=mode]').forEach(input => input.addEventListener('change', updateMode));
document.querySelectorAll('[data-pick]').forEach(button => {
  button.addEventListener('click', async () => {
    try {
      const field = button.dataset.pick;
      const selected = await api.choose(field);
      if (selected) {
        const targetId = field === 'zip' ? 'source' : field;
        document.getElementById(targetId).value = selected;
      }
    } catch (error) { showError(error); }
  });
});

const btnDiscover = document.querySelector('#btn-discover');
const discoverContainer = document.querySelector('#discover-container');
const discoverSelect = document.querySelector('#discover-select');

btnDiscover.addEventListener('click', async () => {
  btnDiscover.disabled = true;
  btnDiscover.textContent = '⏳ 扫描中…';
  output.textContent = '正在全盘常见路径快速扫描旧酒馆…';
  try {
    const list = await api.discover();
    if (!list || list.length === 0) {
      output.textContent = '未在常见路径探测到旧酒馆，请点击“选目录”或“选 ZIP”手动选择。';
      discoverContainer.hidden = true;
    } else {
      discoverContainer.hidden = false;
      discoverSelect.innerHTML = '<option value="">-- 请选择扫描到的旧酒馆 (' + list.length + ' 处) --</option>';
      for (const item of list) {
        const opt = document.createElement('option');
        opt.value = item.path;
        opt.textContent = `${item.name} (v${item.version}) · ${item.path}`;
        discoverSelect.appendChild(opt);
      }
      output.textContent = `成功探测到 ${list.length} 处旧酒馆安装！可直接在下拉菜单中选择。`;
    }
  } catch (err) {
    showError(err);
  } finally {
    btnDiscover.disabled = false;
    btnDiscover.textContent = '🔍 自动扫描发现';
  }
});

discoverSelect.addEventListener('change', () => {
  if (discoverSelect.value) {
    document.getElementById('source').value = discoverSelect.value;
  }
});

api.onStatus(status => {
  output.dataset.state = status.state;
  output.textContent = `${status.message}${status.percent === undefined ? '' : ` (${status.percent}%)`}`;
  if (status.percent !== undefined) progress.value = status.percent;
  else if (status.state === 'working') progress.removeAttribute('value');
  else progress.value = 0;
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  setBusy(true);
  try {
    await api.start({
      mode: getMode(),
      source: document.querySelector('#source').value,
      runtimeRoot: '',
      destination: getMode() === 'copy' ? document.querySelector('#destination').value : '',
    });
  } catch (error) { showError(error); }
  finally { setBusy(false); }
});
cancel.addEventListener('click', async () => {
  cancel.disabled = true;
  try { await api.cancel(); } catch (error) { showError(error); }
});
