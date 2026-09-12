const defaults = {
  modelscope: { endpoint: 'https://api-inference.modelscope.cn/v1/chat/completions', model: 'Qwen/Qwen3.8-27B', keyPlaceholder: '请输入魔搭 ModelScope Token' },
  bailian: { endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', keyPlaceholder: '请输入阿里云百炼 DashScope API Key' }
};
let currentSettings = {};
chrome.storage.local.get(['apiSettings', 'resumeProfile', 'jobProfiles'], ({apiSettings = {}, resumeProfile, jobProfiles = {}}) => {
  currentSettings = apiSettings;
  document.getElementById('provider').value = apiSettings.provider === 'bailian' ? 'bailian' : 'modelscope';
  loadProviderFields();
  renderResume(resumeProfile);
  renderJobs(jobProfiles);
});
function loadProviderFields() {
  const provider = document.getElementById('provider').value;
  const preset = defaults[provider];
  const saved = currentSettings.providers?.[provider] || {};
  const legacy = provider === 'modelscope' ? currentSettings : {};
  document.getElementById('apiKey').value = saved.apiKey ?? legacy.apiKey ?? '';
  document.getElementById('endpoint').value = saved.endpoint || (provider === 'modelscope' ? (legacy.endpoint || preset.endpoint) : preset.endpoint);
  document.getElementById('model').value = saved.model || (provider === 'modelscope' ? (legacy.model || preset.model) : preset.model);
  document.getElementById('apiKey').placeholder = preset.keyPlaceholder;
}
document.getElementById('provider').onchange = loadProviderFields;
function saveSettings(done) {
  const provider = document.getElementById('provider').value;
  const preset = defaults[provider];
  const providers = { ...(currentSettings.providers || {}) };
  providers[provider] = {
    apiKey: document.getElementById('apiKey').value.trim(),
    endpoint: document.getElementById('endpoint').value.trim() || preset.endpoint,
    model: document.getElementById('model').value.trim() || preset.model
  };
  const apiSettings = { ...currentSettings, provider, providers };
  // 保留旧字段，便于旧版本回退使用魔搭配置。
  if (provider === 'modelscope') Object.assign(apiSettings, providers.modelscope);
  currentSettings = apiSettings;
  chrome.storage.local.set({apiSettings}, done);
}
document.getElementById('save').onclick = () => saveSettings(() => { document.getElementById('status').textContent = '已保存'; setTimeout(() => document.getElementById('status').textContent = '', 1800); });
document.getElementById('test').onclick = () => saveSettings(() => { const status = document.getElementById('status'); status.textContent = '测试中…'; chrome.runtime.sendMessage({type: 'testModel'}, result => { if (chrome.runtime.lastError) status.textContent = '无法连接后台服务'; else status.textContent = result?.ok ? '连接成功' : (result?.message || '连接失败'); }); });
function renderResume(resume) {
  const box = document.getElementById('resumeInfo');
  if (!resume?.text) { box.innerHTML = '<strong>尚未自动读取</strong><span class="muted">访问 Boss 简历页后将自动读取。</span>'; return; }
  const time = resume.updatedAt ? new Date(resume.updatedAt).toLocaleString('zh-CN') : '未知';
  const files = resume.attachments?.length ? escapeHtml(resume.attachments.join('、')) : '未识别到附件';
  const preview = resume.text.slice(0, 1200).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  box.innerHTML = `<strong class="ok">已自动读取 Boss 在线简历</strong><div>更新时间：${time}</div><div>Boss 附件管理：${files}</div><div>附件正文：${resume.attachmentTextDetected ? '已读取页面中可见的预览文本' : '请在聊天助手内上传 PDF/Word 进行本地解析'}</div><pre>${preview}${resume.text.length > 1200 ? '\n…' : ''}</pre>`;
}
document.getElementById('openResume').onclick = () => chrome.tabs.create({url: 'https://www.zhipin.com/web/geek/resume'});
document.getElementById('clearResume').onclick = () => chrome.storage.local.remove(['resumeProfile'], () => renderResume(null));
function renderJobs(profiles = {}) {
  const box = document.getElementById('jobInfo');
  const validJobs = Object.values(profiles).filter(profile => {
    const text = `${profile?.title || ''}\n${profile?.detail || ''}`;
    return String(profile?.detail || '').length >= 80 && !/oops|出错|页面不存在|访问异常|请求失败|稍后再试|404|403|安全验证/i.test(text);
  });
  const jobs = [...new Map(validJobs.map(profile => [`${profile.sourceUrl || profile.title}|${String(profile.detail).slice(0, 240)}`, profile])).values()]
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  if (!jobs.length) { box.innerHTML = '<strong>尚未读取岗位</strong><span class="muted">打开助手后手动进入职位详情页，插件会自动读取。</span>'; return; }
  const latest = jobs[0];
  const time = latest.updatedAt ? new Date(latest.updatedAt).toLocaleString('zh-CN') : '未知';
  box.innerHTML = `<strong class="ok">已缓存 ${jobs.length} 个完整岗位（最多 5 个）</strong><div>最近岗位：${escapeHtml(latest.title || '未命名岗位')}</div><div>更新时间：${time}</div>`;
}
function escapeHtml(value) { return String(value).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
document.getElementById('clearJobs').onclick = () => chrome.storage.local.remove(['jobProfiles'], () => renderJobs({}));
chrome.storage.onChanged.addListener(changes => {
  if (changes.resumeProfile) renderResume(changes.resumeProfile.newValue);
  if (changes.jobProfiles) renderJobs(changes.jobProfiles.newValue || {});
});
