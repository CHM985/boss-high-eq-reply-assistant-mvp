(function () {
  const state = { purpose: '表达兴趣', tone: '自然亲切', length: '标准', panel: null, button: null, currentJob: null, jobReadArmed: false, jobReadAttempts: new Map(), jobReadFailed: new Set(), jobStatusMessages: new Map(), clickProbeKeys: new Set(), realOpenKeys: new Set(), capturedJobKey: '', candidateRequestKey: '', candidateRequestAt: 0, registeredJobKey: '', conversationSignature: '', syncTimer: 0, jobDetectionStartedAt: 0, switchPendingUntil: 0, switchPreviousJobKey: '', syncInFlight: false };

  function isJobReadAllowed() {
    return Boolean(state.panel && !state.panel.hidden && state.jobReadArmed);
  }

  function cancelActiveJobRead() {
    state.jobReadArmed = false;
    state.jobReadAttempts.clear();
    state.jobReadFailed.clear();
    state.clickProbeKeys.clear();
    state.realOpenKeys.clear();
    state.candidateRequestKey = '';
    document.querySelectorAll('[data-bh-active-job-target]').forEach(node => node.removeAttribute('data-bh-active-job-target'));
    window.postMessage({ source: 'boss-helper-content', type: 'setJobReadEnabled', enabled: false }, location.origin);
    chrome.runtime.sendMessage({ type: 'cancelJobReads' }, () => void chrome.runtime.lastError);
  }

  const qs = (selectors, root = document) => {
    for (const selector of selectors) {
      const el = root.querySelector(selector);
      if (el) return el;
    }
    return null;
  };

  function findComposer() {
    return qs(['textarea', '[contenteditable="true"]', 'input[placeholder*="请输入"]', 'input[placeholder*="消息"]']);
  }

  function isInActiveChatArea(node) {
    const composer = findComposer();
    if (!composer || !node?.getBoundingClientRect) return true;
    const inputRect = composer.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    return rect.top < inputRect.top && rect.right > inputRect.left - 40 && rect.left < inputRect.right + 40;
  }

  function getConversation() {
    // 只读取聊天气泡，排除职位卡片、导航、快捷按钮和助手面板。
    const roots = [
      '[class*="message-item"]', '[class*="message-content"]',
      '[class*="msg-item"]', '[class*="msg-content"]',
      '[data-message-id]', '[data-msg-id]', '[class*="chat-item"]',
      '[class*="dialogue-item"]'
    ];
    const nodes = [...document.querySelectorAll(roots.join(','))]
      .filter(n => !n.closest('#bh-root') && !n.closest('button, textarea, input'))
      .filter(isInActiveChatArea)
      .filter(n => {
        const text = (n.innerText || '').trim();
        if (!text || text.length > 300) return false;
        // 如果一个候选节点包含另一个候选节点，优先保留更具体的内层节点，
        // 避免把整个聊天页的文字当成一条消息。
        return ![...n.querySelectorAll(roots.join(','))].some(child => {
          return child !== n && (child.innerText || '').trim() === text;
        });
      });
    let texts = nodes.map(n => (n.innerText || '').trim()).filter(Boolean);

    // 兼容页面 class 名变化：从带 message/msg 的短文本节点中兜底提取。
    if (!texts.length) {
      texts = [...document.querySelectorAll('[class*="message"], [class*="msg"]')]
        .filter(n => !n.closest('#bh-root') && !n.closest('button, textarea, input'))
        .filter(isInActiveChatArea)
        .map(n => (n.innerText || '').trim())
        .filter(t => t && t.length <= 300);
    }
    const unique = [];
    for (const text of texts) {
      if (!unique.includes(text) && !unique.some(item => item.includes(text) && item.length > text.length)) {
        unique.push(text);
      }
    }
    return unique.slice(-10).join('\n');
  }

  function getActiveConversationMarker() {
    const nodes = [...document.querySelectorAll('[aria-selected="true"],[aria-current="true"],[class*="active"],[class*="selected"]')]
      .filter(node => !node.closest('#bh-root') && node.getClientRects().length)
      .filter(node => /chat|contact|friend|conversation|session|geek|user|list|item/i.test(String(node.className || '')))
      .map(node => (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(text => text.length >= 2 && text.length <= 140);
    return [...new Set(nodes)].slice(-4).join('|');
  }

  function scheduleConversationSyncBurst() {
    // Boss 切换联系人后，职位卡片通常会延迟数秒才挂载；持续重试可避免必须手动刷新页面。
    [0, 180, 600, 1400, 2800, 4200, 6000, 8000].forEach(delay => setTimeout(() => syncActiveConversation(), delay));
  }

  function isConversationSwitchTarget(target) {
    if (!target || target.closest('#bh-root')) return false;
    if (target.closest('textarea,input,[contenteditable="true"]')) return false;
    const text = (target.innerText || target.textContent || '').trim();
    if (text === '查看职位' || text === '生成回复' || text === '高情商回复') return false;
    const node = target.closest('[role="listitem"],[aria-selected],[aria-current],[class*="chat"],[class*="contact"],[class*="friend"],[class*="conversation"],[class*="session"]');
    if (node) return true;
    const composer = findComposer();
    const targetRect = target.getBoundingClientRect?.();
    const composerRect = composer?.getBoundingClientRect?.();
    return Boolean(targetRect && composerRect && targetRect.right < composerRect.left - 80 && targetRect.width > 0 && targetRect.height > 0);
  }

  function getJobDescription() {
    const selectors = ['[class*="job-name"]', '[class*="position-name"]', '[class*="job-title"]', '[class*="job-detail"]', '[class*="position-detail"]'];
    const values = [...document.querySelectorAll(selectors.join(','))]
      .filter(n => !n.closest('#bh-root'))
      .map(n => (n.innerText || '').trim())
      .filter(t => t && t.length <= 1200);
    return [...new Set(values)].slice(0, 3).join('\n');
  }

  function hashText(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(36);
  }

  function jobKeyFromUrl(url) {
    try {
      const parsed = new URL(url, location.origin);
      const id = parsed.pathname.match(/\/job_detail\/([^/?#]+)/i)?.[1];
      return id ? `job:${id}` : `url:${hashText(parsed.origin + parsed.pathname)}`;
    } catch (_) { return ''; }
  }

  function findViewJobElement() {
    const composer = findComposer();
    const candidates = [...document.querySelectorAll('a,button,[role="button"],span,div')]
      .filter(node => !node.closest('#bh-root'))
      .filter(node => (node.textContent || '').trim() === '查看职位' && isActuallyVisible(node));
    if (!composer || candidates.length < 2) return candidates[0] || null;
    function distanceToComposer(node) {
      const composerAncestors = new Map();
      let current = composer; let depth = 0;
      while (current) { composerAncestors.set(current, depth++); current = current.parentElement; }
      current = node; depth = 0;
      while (current) {
        if (composerAncestors.has(current)) return depth + composerAncestors.get(current);
        depth += 1; current = current.parentElement;
      }
      return Number.MAX_SAFE_INTEGER;
    }
    return candidates.sort((a, b) => distanceToComposer(a) - distanceToComposer(b))[0] || null;
  }

  function isActuallyVisible(node) {
    if (!node?.getClientRects?.().length) return false;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findJobUrl(viewElement) {
    if (!viewElement) return '';
    const nodes = [viewElement, viewElement.closest('a[href]'), ...[...viewElement.querySelectorAll('a[href]')]] .filter(Boolean);
    let parent = viewElement.parentElement;
    for (let i = 0; parent && i < 6; i += 1, parent = parent.parentElement) nodes.push(parent);
    for (const node of nodes) {
      const nestedLink = node.querySelector?.('a[href*="/job_detail/"]');
      if (nestedLink?.href) return nestedLink.href;
      const values = [node.href, ...[...node.attributes || []].map(attr => attr.value)];
      const direct = values.find(value => /\/job_detail\//i.test(value || ''));
      if (direct) { try { return new URL(direct, location.origin).href; } catch (_) { /* continue */ } }
      const datasetId = node.dataset?.encryptJobId || node.dataset?.jobEncryptId || node.dataset?.jobId;
      if (datasetId && /^[\w.-]{8,}$/.test(datasetId)) {
        const url = new URL(`/job_detail/${datasetId.replace(/\.html$/i, '')}.html`, location.origin);
        if (node.dataset?.securityId) url.searchParams.set('securityId', node.dataset.securityId);
        return url.href;
      }
    }
    return '';
  }

  function findEmbeddedActiveJob() {
    const composer = findComposer();
    const candidates = [...document.querySelectorAll('a[href*="/job_detail/"],[data-encrypt-job-id],[data-job-encrypt-id],[data-job-id],[data-position-id]')]
      .filter(node => !node.closest('#bh-root') && isActuallyVisible(node));
    if (!candidates.length) return null;
    function distanceToComposer(node) {
      if (!composer) return Number.MAX_SAFE_INTEGER;
      const ancestors = new Map();
      let current = composer; let depth = 0;
      while (current) { ancestors.set(current, depth++); current = current.parentElement; }
      current = node; depth = 0;
      while (current) {
        if (ancestors.has(current)) return depth + ancestors.get(current);
        depth += 1; current = current.parentElement;
      }
      return Number.MAX_SAFE_INTEGER;
    }
    const node = candidates.sort((a, b) => distanceToComposer(a) - distanceToComposer(b))[0];
    const url = findJobUrl(node);
    if (!url) return null;
    let region = node.parentElement;
    const texts = [];
    for (let i = 0; region && i < 7; i += 1, region = region.parentElement) {
      const text = (region.innerText || '').trim();
      if (text && text.length >= 2 && text.length <= 350) texts.push(text);
    }
    const summary = texts.sort((a, b) => a.length - b.length)[0] || getJobDescription() || url;
    const identity = summary.split('\n').map(line => line.trim()).find(line => line && !/薪资|经验|学历|查看职位/.test(line)) || '';
    return { key: jobKeyFromUrl(url), url, summary, identity };
  }

  function getActiveJob() {
    const view = findViewJobElement();
    if (!view) return findEmbeddedActiveJob();
    let region = view.parentElement;
    const regionTexts = [];
    for (let i = 0; region && i < 7; i += 1, region = region.parentElement) {
      const text = (region.innerText || '').trim();
      if (text.includes('查看职位') && text.length >= 8 && text.length <= 350) regionTexts.push(text);
    }
    const bestText = regionTexts
      .sort((a, b) => {
        const aScore = /\d+(?:\.\d+)?\s*[-~至]\s*\d+(?:\.\d+)?\s*[Kk]|薪资面议/.test(a) ? 0 : 1;
        const bScore = /\d+(?:\.\d+)?\s*[-~至]\s*\d+(?:\.\d+)?\s*[Kk]|薪资面议/.test(b) ? 0 : 1;
        return aScore - bScore || a.length - b.length;
      })[0] || '';
    const summary = bestText.replace(/查看职位\s*[>›》]?/g, '').replace(/\n{3,}/g, '\n').trim() || getJobDescription();
    const identityRegion = regionTexts.filter(text => text.length <= 350).sort((a, b) => b.length - a.length)[0] || '';
    const identity = identityRegion.split('\n').map(line => line.trim()).find(line => line && !line.includes('查看职位') && !line.includes(summary.split('\n')[0])) || '';
    const url = findJobUrl(view) || findEmbeddedActiveJob()?.url || '';
    const key = jobKeyFromUrl(url) || `summary:${hashText(`${identity}|${summary}`)}`;
    return { key, url, summary, identity };
  }

  function isJobDetailPage() {
    const text = document.body?.innerText || '';
    return /\/job_detail\//i.test(location.pathname) || (text.includes('职位描述') && /继续沟通|感兴趣/.test(text));
  }

  function extractJobDetail() {
    const selectors = ['main', '[class*="job-detail"]', '[class*="job-description"]', '[class*="job-sec"]', '[class*="job-box"]', '[class*="detail-content"]'];
    const candidates = [...new Set(selectors.flatMap(selector => [...document.querySelectorAll(selector)]))];
    const keywords = ['职位描述','职位技能','任职要求','工作职责','学历','经验'];
    const scored = candidates.map(node => {
      const text = node.innerText || '';
      return { node, score: keywords.filter(k => text.includes(k)).length * 10000 + Math.min(text.length, 9999) };
    }).filter(item => item.score >= 10000).sort((a, b) => b.score - a.score);
    const source = scored[0]?.node || document.body;
    const clone = source.cloneNode(true);
    clone.querySelectorAll('#bh-root,#bh-resume-sync,script,style,svg,img,button,input,textarea,nav,header,[role="navigation"],[class*="recommend"],[class*="similar"]').forEach(node => node.remove());
    let detail = (clone.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    const start = detail.indexOf('职位描述');
    if (start >= 0) detail = detail.slice(Math.max(0, start - 300));
    detail = detail.slice(0, 18000);
    const title = qs(['h1', '[class*="job-name"]', '[class*="job-title"]'])?.textContent?.trim() || document.title;
    const meta = [...document.querySelectorAll('[class*="salary"],[class*="job-banner"],[class*="job-primary"]')]
      .map(node => (node.innerText || '').trim()).filter(text => text && text.length < 500).slice(0, 3).join('\n');
    return { title, summary: meta, detail, sourceUrl: location.href.replace(/[?&]__bh_job_key=[^&#]*/g, ''), updatedAt: new Date().toISOString() };
  }

  function isValidJobProfile(profile) {
    const title = String(profile?.title || '').trim();
    const detail = String(profile?.detail || '').trim();
    if (detail.length < 80) return false;
    if (/oops|出错|页面不存在|访问异常|请求失败|稍后再试|404|403|安全验证/i.test(`${title}\n${detail}`)) return false;
    if (profile?.source === 'chat-api') return true;
    const signals = ['职位描述','职位技能','任职要求','工作职责','岗位职责','学历','经验要求','专业要求'];
    return signals.filter(word => detail.includes(word)).length >= 2 || detail.includes('职位描述');
  }

  function jobProfileMatches(profile, job) {
    if (!isValidJobProfile(profile) || !job) return false;
    const title = String(profile.title || '').replace(/[\s（）()！!，,·]/g, '').toLowerCase();
    const summary = String(job.summary || '').replace(/[\s（）()！!，,·]/g, '').toLowerCase();
    return title.length >= 2 && (summary.includes(title) || title.includes(summary.split(/\d+(?:\.\d+)?[-~至]/)[0]));
  }

  function findCachedJobProfile(profiles, job) {
    if (!job) return null;
    if (jobProfileMatches(profiles[job.key], job)) return profiles[job.key];
    const matches = [...new Map(Object.values(profiles)
      .filter(profile => jobProfileMatches(profile, job))
      .map(profile => [`${profile.sourceUrl || profile.title}|${String(profile.detail || '').slice(0, 240)}`, profile])).values()];
    return matches.length === 1 ? matches[0] : null;
  }

  function autoCaptureJobDetail() {
    if (!isJobDetailPage()) return;
    const params = new URLSearchParams(location.search);
    const requestedKey = params.get('__bh_job_key');
    const canonicalKey = jobKeyFromUrl(location.href);
    const key = requestedKey || canonicalKey;
    if (!key || state.capturedJobKey === key) return;
    const profile = extractJobDetail();
    if (!isValidJobProfile(profile)) return;
    state.capturedJobKey = key;
    chrome.runtime.sendMessage({ type: 'jobDetailExtracted', key, profile, temporary: Boolean(requestedKey) }, response => {
      if (chrome.runtime.lastError || !response?.ok) state.capturedJobKey = '';
    });
  }

  async function ensureActiveJobRead() {
    if (isResumePage() || isJobDetailPage()) return;
    // 岗位读取由用户打开助手面板触发，避免进入 Boss 消息页就自动消耗读取流程。
    if (!isJobReadAllowed()) return;
    const job = getActiveJob();
    if (!job) {
      state.currentJob = null;
      const pendingKey = `pending:${getActiveConversationMarker()}:${hashText(getConversation())}`;
      if (state.candidateRequestKey !== pendingKey || Date.now() - state.candidateRequestAt > 1200) {
        state.candidateRequestKey = pendingKey;
        state.candidateRequestAt = Date.now();
        window.postMessage({ source: 'boss-helper-content', type: 'requestJobCandidates' }, location.origin);
      }
      updateJobState();
      return;
    }
    state.currentJob = job;
    if (state.registeredJobKey !== job.key) {
      state.registeredJobKey = job.key;
      chrome.runtime.sendMessage({ type: 'activeChatJobChanged', job: { key: job.key, summary: job.summary, identity: job.identity } }, () => void chrome.runtime.lastError);
    }
    if (state.candidateRequestKey !== job.key) {
      state.candidateRequestKey = job.key;
      window.postMessage({ source: 'boss-helper-content', type: 'requestJobCandidates' }, location.origin);
    }
    const profiles = await new Promise(resolve => chrome.storage.local.get(['jobProfiles'], result => resolve(result.jobProfiles || {})));
    if (!isJobReadAllowed() || state.currentJob?.key !== job.key) return;
    if (jobProfileMatches(profiles[job.key], job)) { updateJobState(); return; }
    if (state.jobReadFailed.has(job.key)) { updateJobState('△ 岗位 JD 读取失败，请切换聊天后重试'); return; }
    const normalizedSummary = job.summary.replace(/\s/g, '').toLowerCase();
    const cachedMatchValues = Object.values(profiles).filter(profile => {
      if (!isValidJobProfile(profile)) return false;
      const title = String(profile?.title || '').replace(/\s/g, '').toLowerCase();
      return profile?.detail && title.length >= 2 && normalizedSummary.includes(title);
    });
    const cachedMatches = [...new Map(cachedMatchValues.map(profile => [`${profile.sourceUrl || profile.title}|${profile.detail.slice(0, 240)}`, profile])).values()];
    if (cachedMatches.length === 1) {
      chrome.runtime.sendMessage({ type: 'jobDetailExtracted', key: job.key, profile: { ...cachedMatches[0], matchedFromCache: true }, temporary: false }, () => updateJobState());
      return;
    }
    updateJobState();
    // 完整 JD 改为用户手动打开职位详情页后读取，避免自动开页触发重复标签和安全校验。
    updateJobState('请点击岗位名称打开详情页');
    return;
  }

  function updateJobState(message = '') {
    if (!state.panel) return;
    chrome.storage.local.get(['jobProfiles'], ({ jobProfiles = {} }) => {
      const node = state.panel?.querySelector('.bh-job-state');
      if (!node) return;
      const job = state.currentJob;
      const profile = job ? (jobProfiles[job.key] || findCachedJobProfile(jobProfiles, job)) : null;
      if (job && message) state.jobStatusMessages.set(job.key, message);
      const savedMessage = job ? state.jobStatusMessages.get(job.key) : '';
      if (!job) node.textContent = '○ 尚未识别当前会话岗位';
      else if (jobProfileMatches(profile, job)) { state.jobStatusMessages.delete(job.key); node.textContent = `✓ 已自动读取完整岗位：${profile.title || job.summary.split('\n')[0]}`; }
      else if (job.url) node.textContent = message || savedMessage || '请点击岗位名称打开详情页';
      else node.textContent = message || savedMessage || '△ 仅获取到岗位摘要';
      node.classList.toggle('ready', jobProfileMatches(profile, job));
    });
  }

  async function getCurrentJobContext() {
    const job = state.currentJob || getActiveJob();
    if (!job) return getJobDescription();
    const profiles = await new Promise(resolve => chrome.storage.local.get(['jobProfiles'], result => resolve(result.jobProfiles || {})));
    const profile = profiles[job.key] || findCachedJobProfile(profiles, job);
    return jobProfileMatches(profile, job) ? `岗位：${profile.title || ''}\n${profile.summary || ''}\n${profile.detail}` : job.summary;
  }

  function candidateScore(candidate, job) {
    const summary = `${job?.identity || ''} ${job?.summary || ''}`.replace(/\s/g, '').toLowerCase();
    if (!summary || !candidate?.title) return 0;
    let score = summary.includes(String(candidate.title).replace(/\s/g, '').toLowerCase()) ? 10 : 0;
    for (const value of [candidate.salary, candidate.city, candidate.company]) {
      if (value && summary.includes(String(value).replace(/\s/g, '').toLowerCase())) score += 2;
    }
    return score;
  }

  async function handlePageJobCandidates(candidates) {
    if (!isJobReadAllowed() || !Array.isArray(candidates)) return;
    let job = getActiveJob();
    if (!job && state.currentJob) job = state.currentJob;
    if (!job) {
      const pageText = `${getJobDescription()}\n${document.body?.innerText || ''}`.replace(/\s/g, '').toLowerCase();
      const inferred = candidates
        .filter(candidate => candidate?.title && pageText.includes(String(candidate.title).replace(/\s/g, '').toLowerCase()))
        .sort((a, b) => String(b.detail || '').length - String(a.detail || '').length)[0];
      if (inferred) {
        const summary = [inferred.title, inferred.salary, inferred.city, inferred.company].filter(Boolean).join(' · ');
        const key = jobKeyFromUrl(inferred.url) || `summary:${hashText(summary)}`;
        job = { key, url: inferred.url || '', summary, identity: inferred.company || inferred.title };
      }
    }
    if (!job) return;
    state.currentJob = job;
    const ranked = candidates.map(candidate => ({ candidate, score: candidateScore(candidate, job) }))
      .filter(item => item.score >= 10).sort((a, b) => b.score - a.score);
    const match = ranked[0]?.candidate;
    if (!isJobReadAllowed() || state.currentJob?.key !== job.key || !match) return;
    if (match.detail?.length > 80) {
      const profile = {
        title: match.title,
        summary: [match.salary, match.city, match.company].filter(Boolean).join(' · '),
        detail: match.detail,
        sourceUrl: match.url || location.href,
        source: 'chat-api'
      };
      if (isValidJobProfile(profile)) chrome.runtime.sendMessage({ type: 'jobDetailExtracted', key: job.key, profile, temporary: false }, () => updateJobState());
      return;
    }
    if (match.url) {
      state.currentJob = { ...job, url: match.url };
      updateJobState('请点击岗位名称打开详情页');
    }
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'boss-helper-page-bridge') return;
    if (event.data.type === 'jobCandidates') handlePageJobCandidates(event.data.candidates);
    if (event.data.type === 'jobNavigationCaptured') {
      // 兼容旧版本页面消息，但不再根据消息自动开详情页。
      return;
    }
    if (event.data.type === 'jobProbeFailed' && event.data.key === state.currentJob?.key) {
      // 旧版探测消息直接忽略；详情页仅由用户手动打开。
      return;
    }
    if (isJobReadAllowed() && event.data.type === 'jobAutoOpenFailed' && event.data.key === state.currentJob?.key) {
      // 旧版自动开页失败消息直接忽略。
      return;
    }
  });

  async function syncActiveConversation() {
    if (isResumePage() || isJobDetailPage()) return;
    if (state.syncInFlight) return;
    state.syncInFlight = true;
    try {
    let job = getActiveJob();
    const context = getConversation();
    const marker = getActiveConversationMarker();
    if (state.switchPendingUntil && Date.now() < state.switchPendingUntil && job?.key === state.switchPreviousJobKey) {
      job = null;
    } else if (state.switchPendingUntil && Date.now() >= state.switchPendingUntil) {
      state.switchPendingUntil = 0;
      state.switchPreviousJobKey = '';
    }
    const signature = `${marker}:${job?.key || 'none'}:${hashText(context)}`;
    const hasPendingDetection = Boolean(state.jobDetectionStartedAt || state.currentJob || state.conversationSignature);
    if (!job && !context && !hasPendingDetection) return;
    // 岗位组件可能比聊天消息晚挂载；在尚未识别到岗位时，即使签名不变也要继续重试。
    if (signature === state.conversationSignature && job?.key && state.currentJob?.key === job.key) return;
    const previousSignature = state.conversationSignature;
    const previousJobKey = state.currentJob?.key;
    state.conversationSignature = signature;
    state.currentJob = job;
    if (!job) {
      if (!state.jobDetectionStartedAt) state.jobDetectionStartedAt = Date.now();
      if (state.panel) state.panel.querySelector('.bh-status').textContent = '请选择聊天';
    } else {
      state.jobDetectionStartedAt = 0;
    }
    if (job?.key !== previousJobKey) {
      state.registeredJobKey = '';
      state.candidateRequestKey = '';
      state.candidateRequestAt = 0;
      state.clickProbeKeys.delete(previousJobKey);
      if (previousJobKey) {
        state.jobReadAttempts.delete(previousJobKey);
        state.realOpenKeys.delete(previousJobKey);
        state.jobReadFailed.delete(previousJobKey);
        state.jobStatusMessages.delete(previousJobKey);
      }
    }
    if (state.panel && previousSignature) {
      state.panel.querySelector('.bh-results').innerHTML = '';
      state.panel.querySelector('.bh-status').textContent = job?.key !== previousJobKey ? '已切换会话，已刷新上下文；点击“生成回复”才会调用大模型' : '聊天内容已更新；点击“生成回复”才会调用大模型';
    }
    if (state.panel) state.panel.querySelector('.bh-context').textContent = context || '暂未识别到聊天内容。';
    if (state.panel && !state.panel.hidden) {
      if (state.jobReadArmed) {
        updateJobState('请点击岗位名称打开详情页');
        await ensureActiveJobRead();
      } else {
        updateJobState('○ 请在左侧选择一个聊天后读取岗位 JD');
      }
    } else {
      updateJobState();
    }
    } finally {
      state.syncInFlight = false;
    }
  }

  function redactResumeText(text) {
    return text
      .replace(/1[3-9]\d{9}/g, '[手机号已脱敏]')
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[邮箱已脱敏]')
      .replace(/\b\d{15,18}[0-9Xx]\b/g, '[证件号已脱敏]')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function isResumePage() {
    const text = document.body?.innerText || '';
    return /resume/i.test(location.pathname) || (text.includes('我的在线简历') && text.includes('工作经历'));
  }

  function extractResume() {
    const selectors = ['main', '[class*="resume-content"]', '[class*="resume-main"]', '[class*="resume-container"]', '[class*="resume-wrap"]'];
    const candidates = [...new Set(selectors.flatMap(selector => [...document.querySelectorAll(selector)]))];
    const scored = candidates.map(node => {
      const text = node.innerText || '';
      const keywords = ['个人信息','个人优势','期望职位','工作经历','项目经历','教育经历','资格证书','专业技能'];
      const score = keywords.filter(k => text.includes(k)).length * 10000 + Math.min(text.length, 9999);
      return { node, score };
    }).filter(x => x.score >= 20000).sort((a, b) => b.score - a.score);
    const source = scored[0]?.node || document.body;
    const clone = source.cloneNode(true);
    clone.querySelectorAll('#bh-root,#bh-resume-sync,script,style,svg,img,button,input,textarea,nav,header,[role="navigation"],[class*="privacy"],[class*="attachment"]').forEach(n => n.remove());
    let text = redactResumeText(clone.innerText || '');
    // 只保留对求职沟通有用的内容，避免把网站导航等无关文本提交给模型。
    const startTokens = ['编辑个人信息', '个人信息', '个人优势'];
    const starts = startTokens.map(k => text.indexOf(k)).filter(i => i >= 0);
    if (starts.length) text = text.slice(Math.min(...starts));
    text = text.slice(0, 14000);

    const bodyText = document.body?.innerText || '';
    const attachments = [...new Set((bodyText.match(/[^\n]{1,80}\.(?:pdf|docx?|PDF|DOCX?)/g) || []).map(s => s.trim()))];
    const previewSelectors = ['[class*="attachment-preview"]', '[class*="file-preview"]', '[class*="pdf-preview"]', '[class*="document-preview"]', '[role="dialog"]'];
    const attachmentPreview = [...document.querySelectorAll(previewSelectors.join(','))]
      .map(n => (n.innerText || '').trim()).filter(t => t.length > 300).join('\n').slice(0, 10000);
    if (attachmentPreview) text += `\n\n【附件预览可见文本】\n${redactResumeText(attachmentPreview)}`;
    return { text, attachments, attachmentTextDetected: Boolean(attachmentPreview), sourceUrl: location.href, updatedAt: new Date().toISOString() };
  }

  function mountResumeSync() {
    if (!isResumePage()) { document.getElementById('bh-resume-sync')?.remove(); return; }
    const resumeProfile = extractResume();
    if (resumeProfile.text.length >= 80) {
      chrome.storage.local.get(['resumeProfile'], ({ resumeProfile: saved }) => {
        if (saved?.text !== resumeProfile.text || JSON.stringify(saved?.attachments || []) !== JSON.stringify(resumeProfile.attachments)) {
          chrome.storage.local.set({ resumeProfile });
        }
      });
    }
    if (document.getElementById('bh-resume-sync')) return;
    const button = document.createElement('button');
    button.id = 'bh-resume-sync'; button.className = 'bh-button bh-resume-sync';
    button.textContent = resumeProfile.text.length >= 80 ? '✓ 在线简历已自动读取' : '未识别到完整在线简历';
    button.onclick = () => {
      const resumeProfile = extractResume();
      if (resumeProfile.text.length < 80) { button.textContent = '未识别到完整简历，请展开后重试'; return; }
      chrome.storage.local.set({ resumeProfile }, () => {
        updateResumeState();
        button.textContent = `✓ 已同步简历${resumeProfile.attachments.length ? `及 ${resumeProfile.attachments.length} 个附件名称` : ''}`;
        setTimeout(() => button.textContent = '✓ 在线简历已自动读取', 2600);
      });
    };
    document.body.appendChild(button);
  }

  async function parseAttachmentFile(file) {
    const extension = (file.name.split('.').pop() || '').toLowerCase();
    if (file.size > 12 * 1024 * 1024) throw new Error(`${file.name} 超过 12MB 限制`);
    const buffer = await file.arrayBuffer();
    let text = '';
    if (extension === 'pdf') {
      if (!globalThis.pdfjsLib) throw new Error('PDF 解析组件未加载');
      globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.js');
      const pdf = await globalThis.pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
      const pages = [];
      for (let pageNumber = 1; pageNumber <= Math.min(pdf.numPages, 80); pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        pages.push(content.items.map(item => item.str || '').join(' '));
      }
      text = pages.join('\n');
    } else if (extension === 'docx') {
      if (!globalThis.mammoth) throw new Error('Word 解析组件未加载');
      const result = await globalThis.mammoth.extractRawText({ arrayBuffer: buffer });
      text = result.value || '';
    } else if (extension === 'doc') {
      throw new Error(`${file.name} 是旧版 DOC 格式，请另存为 DOCX 或 PDF 后上传`);
    } else {
      throw new Error(`${file.name} 不是受支持的 PDF、DOCX 或 DOC 文件`);
    }
    text = redactResumeText(text).slice(0, 30000);
    if (text.length < 30) throw new Error(`${file.name} 未解析出有效文字；扫描版 PDF 请转换为可搜索 PDF`);
    return { fileName: file.name, fileType: extension, text, updatedAt: new Date().toISOString() };
  }

  async function handleAttachmentFiles(files) {
    const status = state.panel?.querySelector('.bh-attachment-status');
    const selected = [...files].slice(0, 3);
    if (!selected.length) return;
    if (status) status.textContent = `正在本地解析 ${selected.length} 个文件…`;
    const parsed = [];
    const errors = [];
    for (const file of selected) {
      try { parsed.push(await parseAttachmentFile(file)); }
      catch (error) { errors.push(error.message); }
    }
    const existing = await new Promise(resolve => chrome.storage.local.get(['attachmentProfiles'], r => resolve(r.attachmentProfiles || [])));
    const merged = [...existing];
    parsed.forEach(item => {
      const index = merged.findIndex(old => old.fileName === item.fileName);
      if (index >= 0) merged[index] = item; else merged.push(item);
    });
    await new Promise(resolve => chrome.storage.local.set({ attachmentProfiles: merged.slice(-3) }, resolve));
    updateResumeState();
    if (status) status.textContent = errors.length ? errors.join('；') : `已解析 ${parsed.length} 个附件，将在点击生成时与在线简历对齐`;
  }

  function insertText(text) {
    const composer = findComposer();
    if (!composer) return false;
    composer.focus();
    if (composer.isContentEditable) {
      document.execCommand('insertText', false, text);
    } else {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(composer), 'value')?.set;
      setter ? setter.call(composer, text) : composer.value = text;
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  }

  function makeReplies(context, profile, purpose, tone, length) {
    const name = profile?.name ? `，${profile.name}` : '';
    const job = profile?.target ? `，我对${profile.target}方向比较感兴趣` : '，我对这个岗位比较感兴趣';
    const short = length === '简短';
    const detail = length === '详细';
    const suffix = detail ? '如果方便的话，也想进一步了解一下团队情况和岗位的具体工作内容。' : '';
    const map = {
      '表达兴趣': [
        `您好${name}，感谢您的沟通${job}。方便的话可以继续聊聊岗位的具体情况吗？${suffix}`,
        `您好，看到您的消息很开心。我看过岗位介绍，和我的经历匹配度不错，也愿意进一步沟通，期待了解后续安排。${suffix}`,
        `您好，谢谢您联系我！这个岗位的方向和我的经验比较契合，我很有兴趣。请问接下来方便约时间聊一下吗？`
      ],
      '争取面试机会': [
        `您好，我对这个岗位很感兴趣，相关经历也比较匹配。请问是否有机会安排一次面试，让我进一步介绍一下项目经验呢？`,
        `感谢沟通！结合岗位要求，我在${profile?.skills || '相关项目'}方面有实践经验，期待获得进一步面试交流的机会。`,
        `您好，我愿意参加面试。我的时间比较灵活，您看哪天方便？`
      ],
      '询问薪资': [
        `您好，想请教一下这个岗位目前的薪资范围和薪酬结构，方便了解一下吗？`,
        `感谢介绍。为了判断双方预期是否匹配，想先了解一下岗位的薪资区间、试用期和福利情况。`,
        `您好，我的期望会结合岗位职责和整体薪酬综合评估。请问贵司这个岗位的预算范围大概是多少呢？`
      ],
      '礼貌拒绝': [
        `您好，感谢您的邀请。综合考虑后，这个岗位与我目前的求职方向不太匹配，暂时先不考虑了，祝您招聘顺利。`,
        `谢谢您抽时间沟通！我目前更倾向于${profile?.target || '其他方向'}的机会，因此这次先不继续了，后续有合适岗位也欢迎联系。`,
        `感谢联系。经过考虑，我暂时无法接受这个机会，给您添麻烦了，也祝您早日找到合适的人选。`
      ],
      '继续追问岗位细节': [
        `您好，想进一步了解一下这个岗位的汇报对象、团队规模以及主要工作占比，方便介绍一下吗？`,
        `感谢介绍。请问这个岗位入职后的前三个月，最希望优先解决的事情是什么呢？`,
        `您好，除了职位描述中的内容外，想请问一下工作地点、办公模式和加班情况是怎样的？`
      ]
    };
    const replies = map[purpose] || map['表达兴趣'];
    return replies.map(t => tone === '正式专业' ? t.replace(/您好/g, '您好，').replace(/！/g, '。') : t);
  }

  function renderPanel() {
    if (state.panel) return;
    const panel = document.createElement('div');
    panel.id = 'bh-root'; panel.className = 'bh-panel'; panel.hidden = true;
    panel.innerHTML = `<div class="bh-head"><div class="bh-title">✨ 高情商回复助手</div><button class="bh-close">×</button></div>
      <div class="bh-resume-state"></div>
      <div class="bh-job-state"></div>
      <label class="bh-upload"><input class="bh-file-input" type="file" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple><span>＋ 拖入或选择简历附件（PDF / Word）</span></label>
      <div class="bh-attachment-status"></div><button class="bh-clear-files" type="button">清除附件</button>
      <div class="bh-status">调整选项后点击“生成回复”，此时才会调用大模型</div><div class="bh-context"></div>
      <div><div style="font-size:12px;color:#646a73">回复目的</div><div class="bh-row" data-group="purpose"></div></div>
      <div><div style="font-size:12px;color:#646a73">语气</div><div class="bh-row" data-group="tone"></div></div>
      <div><div style="font-size:12px;color:#646a73">长度</div><div class="bh-row" data-group="length"></div></div>
      <button class="bh-button bh-generate" style="width:100%;margin-top:4px">生成回复</button><div class="bh-results"></div>`;
    document.body.appendChild(panel); state.panel = panel;
    const groups = { purpose: ['表达兴趣','争取面试机会','询问薪资','礼貌拒绝','继续追问岗位细节'], tone: ['自然亲切','正式专业'], length: ['简短','标准','详细'] };
    Object.entries(groups).forEach(([group, items]) => {
      const box = panel.querySelector(`[data-group="${group}"]`);
      items.forEach(item => { const b = document.createElement('button'); b.className = 'bh-chip' + (state[group] === item ? ' active' : ''); b.textContent = item; b.onclick = () => { state[group] = item; box.querySelectorAll('.bh-chip').forEach(x => x.classList.remove('active')); b.classList.add('active'); }; box.appendChild(b); });
    });
    panel.querySelector('.bh-close').onclick = () => {
      panel.hidden = true;
      cancelActiveJobRead();
    };
    panel.querySelector('.bh-generate').onclick = generate;
    const upload = panel.querySelector('.bh-upload');
    const fileInput = panel.querySelector('.bh-file-input');
    fileInput.onchange = () => handleAttachmentFiles(fileInput.files);
    upload.ondragover = event => { event.preventDefault(); upload.classList.add('dragging'); };
    upload.ondragleave = () => upload.classList.remove('dragging');
    upload.ondrop = event => { event.preventDefault(); upload.classList.remove('dragging'); handleAttachmentFiles(event.dataTransfer.files); };
    panel.querySelector('.bh-clear-files').onclick = () => chrome.storage.local.remove(['attachmentProfiles'], () => { panel.querySelector('.bh-attachment-status').textContent = '已清除附件简历'; updateResumeState(); });
    updateResumeState();
    updateJobState();
  }

  function updateResumeState() {
    if (!state.panel) return;
    chrome.storage.local.get(['resumeProfile', 'attachmentProfiles'], ({ resumeProfile, attachmentProfiles = [] }) => {
      const node = state.panel?.querySelector('.bh-resume-state');
      if (!node) return;
      const online = resumeProfile?.text ? '✓ 已自动读取 Boss 在线简历' : '○ 尚未读取在线简历（访问“我的简历”页后自动读取）';
      const files = attachmentProfiles.length ? `✓ 已解析附件：${attachmentProfiles.map(item => item.fileName).join('、')}` : '○ 尚未添加简历附件';
      node.textContent = `${online}\n${files}`;
      node.classList.toggle('ready', Boolean(resumeProfile?.text));
    });
  }

  function preparePanel() {
    if (!state.panel) return;
    cancelActiveJobRead();
    state.panel.querySelector('.bh-context').textContent = getConversation() || '暂未识别到聊天内容。';
    state.panel.querySelector('.bh-status').textContent = '请在左侧选择一个聊天；点击“生成回复”时才会调用大模型';
    updateResumeState();
    updateJobState('○ 请在左侧选择一个聊天后读取岗位 JD');
  }

  async function generate() {
    const status = state.panel.querySelector('.bh-status');
    const generateButton = state.panel.querySelector('.bh-generate');
    if (generateButton.disabled) return;
    generateButton.disabled = true;
    generateButton.textContent = '正在生成…';
    try {
    const context = getConversation() || '暂未识别到聊天内容，请结合 HR 的最新消息进行回复。';
    state.panel.querySelector('.bh-context').textContent = context;
    status.textContent = '正在生成…';
    const sources = await new Promise(resolve => chrome.storage.local.get(['resumeProfile', 'attachmentProfiles'], resolve));
    const resumeProfile = sources.resumeProfile || null;
    const attachmentProfiles = sources.attachmentProfiles || [];
    const profile = {
      resumeText: resumeProfile?.text || '',
      attachments: resumeProfile?.attachments || [],
      updatedAt: resumeProfile?.updatedAt,
      attachmentResumeText: attachmentProfiles.map(item => `【${item.fileName}】\n${item.text}`).join('\n\n').slice(0, 30000),
      uploadedAttachments: attachmentProfiles.map(item => item.fileName)
    };
    let replies;
    let statusText = '已生成 3 条回复草稿';
    const apiSettings = await new Promise(resolve => chrome.storage.local.get(['apiSettings'], r => resolve(r.apiSettings || {})));
    const activeApi = apiSettings.providers?.[apiSettings.provider] || apiSettings;
    if (activeApi.apiKey) {
      const jobDescription = await getCurrentJobContext();
      const modelResult = await new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'generateWithModel', payload: {
          context, jobDescription, profile,
          purpose: state.purpose, tone: state.tone, length: state.length
        }}, response => resolve(chrome.runtime.lastError ? { ok: false, message: chrome.runtime.lastError.message } : response));
      });
      if (modelResult?.ok && Array.isArray(modelResult.replies) && modelResult.replies.length) {
        replies = modelResult.replies;
      } else {
        replies = makeReplies(context, profile, state.purpose, state.tone, state.length);
        statusText = `${modelResult?.message || '模型生成失败'}，已使用本地模板`;
      }
    } else {
      replies = makeReplies(context, profile, state.purpose, state.tone, state.length);
      statusText = '未配置魔搭 API Key，已使用本地模板';
    }
    const results = state.panel.querySelector('.bh-results'); results.innerHTML = '';
    replies.forEach((reply, i) => {
      const card = document.createElement('div'); card.className = 'bh-card';
      card.innerHTML = `<div class="bh-card-text"></div><div class="bh-card-actions"><button class="bh-small copy">复制</button><button class="bh-small insert">插入输入框</button></div>`;
      card.querySelector('.bh-card-text').textContent = reply;
      card.querySelector('.copy').onclick = async () => { await navigator.clipboard.writeText(reply); status.textContent = '已复制第 ' + (i + 1) + ' 条回复'; };
      card.querySelector('.insert').onclick = () => { status.textContent = insertText(reply) ? '已插入输入框，请确认后发送' : '未找到聊天输入框'; };
      results.appendChild(card);
    });
    status.textContent = statusText;
    } catch (error) {
      status.textContent = `生成失败：${error.message}`;
    } finally {
      generateButton.disabled = false;
      generateButton.textContent = '生成回复';
    }
  }

  function mountButton() {
    renderPanel();
    if (isResumePage() || isJobDetailPage()) return;
    if (state.button || !findComposer()) return;
    const b = document.createElement('button'); b.className = 'bh-button'; b.textContent = '✨ 高情商回复'; b.type = 'button';
    b.onclick = () => {
      state.panel.hidden = !state.panel.hidden;
      if (!state.panel.hidden) preparePanel();
      else cancelActiveJobRead();
    };
    const composer = findComposer(); composer.parentElement?.appendChild(b); state.button = b;
  }

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'open') {
      mountButton();
      if (state.panel) { state.panel.hidden = false; preparePanel(); }
    }
    if (message?.type === 'autoJobReadFailed' && message.key === state.currentJob?.key) {
      state.realOpenKeys.delete(message.key);
      state.jobReadFailed.add(message.key);
      updateJobState('△ 岗位 JD 读取失败，请切换聊天后重试');
    }
    if (message?.type === 'jobReadComplete' && message.key === state.currentJob?.key) {
      state.jobReadAttempts.delete(message.key);
      state.jobReadFailed.delete(message.key);
      state.realOpenKeys.delete(message.key);
      updateJobState();
    }
    if (message?.type === 'jobReadFailed' && message.key === state.currentJob?.key) {
      state.jobReadAttempts.delete(message.key);
      state.realOpenKeys.delete(message.key);
      state.jobReadFailed.add(message.key);
      updateJobState('△ 岗位 JD 读取失败，请切换聊天后重试');
    }
  });

  document.addEventListener('click', event => {
    if (!isConversationSwitchTarget(event.target)) return;
    const panelOpen = Boolean(state.panel && !state.panel.hidden);
    if (panelOpen) {
      chrome.runtime.sendMessage({ type: 'cancelJobReads' }, () => void chrome.runtime.lastError);
      state.jobReadArmed = true;
      window.postMessage({ source: 'boss-helper-content', type: 'setJobReadEnabled', enabled: true }, location.origin);
    } else {
      state.jobReadArmed = false;
    }
    state.switchPreviousJobKey = state.currentJob?.key || '';
    state.switchPendingUntil = Date.now() + 8000;
    document.querySelectorAll('[data-bh-active-job-target]').forEach(node => node.removeAttribute('data-bh-active-job-target'));
    state.conversationSignature = '';
    state.currentJob = null;
    state.registeredJobKey = '';
    state.candidateRequestKey = '';
    state.jobDetectionStartedAt = Date.now();
    if (panelOpen) {
      state.panel.querySelector('.bh-status').textContent = '请点击岗位名称打开详情页';
      scheduleConversationSyncBurst();
    }
  }, true);

  chrome.storage.onChanged.addListener(changes => {
    if (changes.resumeProfile || changes.attachmentProfiles) updateResumeState();
    if (changes.jobProfiles) updateJobState();
  });

  setInterval(() => { if (!state.button || !document.contains(state.button)) { state.button = null; mountButton(); } }, 1500);
  setInterval(mountResumeSync, 5000);
  const conversationObserver = new MutationObserver(mutations => {
    const onlyAssistantChanges = mutations.every(mutation => {
      const element = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
      return element?.closest?.('#bh-root');
    });
    if (onlyAssistantChanges) return;
    clearTimeout(state.syncTimer);
    state.syncTimer = setTimeout(syncActiveConversation, 180);
  });
  conversationObserver.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'aria-selected', 'aria-current', 'data-active', 'style'] });
  setInterval(() => { syncActiveConversation(); autoCaptureJobDetail(); }, 1200);
  mountButton();
  mountResumeSync();
  ensureActiveJobRead();
  autoCaptureJobDetail();
  syncActiveConversation();
})();
