(function () {
  const SOURCE = 'boss-helper-page-bridge';
  const seen = new Set();
  const cached = [];
  const originalWindowOpen = window.open.bind(window);
  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);
  let probe = null;
  let jobReadEnabled = false;

  function captureProbeUrl(url) {
    if (!probe || Date.now() >= probe.expiresAt || !url) return false;
    let capturedUrl = '';
    try { capturedUrl = new URL(String(url), location.origin).href; } catch (_) { return false; }
    if (!/\/job_detail\/|jobdetail/i.test(capturedUrl)) return false;
    window.postMessage({ source: SOURCE, type: 'jobNavigationCaptured', key: probe.key, url: capturedUrl }, location.origin);
    probe = null;
    return true;
  }

  function fakePopup() {
    const locationObject = {};
    Object.defineProperty(locationObject, 'href', { set: captureProbeUrl, get: () => '' });
    const popup = { closed: false, close() {}, focus() {}, blur() {}, location: locationObject };
    return new Proxy(popup, {
      set(target, property, value) {
        if (property === 'location') captureProbeUrl(value);
        else target[property] = value;
        return true;
      }
    });
  }

  window.open = function (url, ...args) {
    if (probe && Date.now() < probe.expiresAt) {
      if (url) captureProbeUrl(url);
      return fakePopup();
    }
    return originalWindowOpen(url, ...args);
  };
  history.pushState = function (state, title, url) {
    if (captureProbeUrl(url)) return;
    return originalPushState(state, title, url);
  };
  history.replaceState = function (state, title, url) {
    if (captureProbeUrl(url)) return;
    return originalReplaceState(state, title, url);
  };

  function findBoundClickHandler(target) {
    let node = target;
    for (let level = 0; node && level < 7; level += 1, node = node.parentElement) {
      if (typeof node.onclick === 'function') return { handler: node.onclick, node };
      for (const key of Object.getOwnPropertyNames(node)) {
        const value = node[key];
        if (/^__reactProps/i.test(key)) {
          const handler = value?.onClick || value?.onPointerUp || value?.onMouseDown;
          if (typeof handler === 'function') return { handler, node };
        }
        if (/^__vueParentComponent/i.test(key)) {
          const handler = value?.vnode?.props?.onClick || value?.props?.onClick;
          if (typeof handler === 'function') return { handler, node };
        }
        if (key === '_vei') {
          const invoker = value?.onClick || value?.onclick || value?.['on:click'] || Object.values(value || {}).find(item => typeof item === 'function' || typeof item?.value === 'function');
          const handler = invoker?.value || invoker;
          if (typeof handler === 'function') return { handler, node };
        }
      }
    }
    return null;
  }

  function isActuallyVisible(node) {
    if (!node?.getClientRects?.().length) return false;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function first(object, keys) {
    for (const key of keys) {
      const value = object?.[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number') return String(value);
    }
    return '';
  }

  function findUrl(object) {
    const direct = first(object, ['jobUrl','jobDetailUrl','positionUrl','url','href']);
    if (/\/job_detail\//i.test(direct)) { try { return new URL(direct, location.origin).href; } catch (_) { /* ignore */ } }
    // Boss 的真实地址结构是 /job_detail/{职位加密ID}.html?securityId={访问令牌}。
    // securityId 不能作为路径 ID，否则会进入 Oops 错误页。
    const jobId = first(object, ['encryptJobId','jobEncryptId','encryptId','jobId','positionId']);
    const securityId = first(object, ['securityId']);
    if (jobId && /^[\w.-]{8,}$/.test(jobId)) {
      const url = new URL(`/job_detail/${jobId.replace(/\.html$/i, '')}.html`, location.origin);
      if (securityId) url.searchParams.set('securityId', securityId);
      return url.href;
    }
    return '';
  }

  function normalize(object) {
    const title = first(object, ['jobName','jobTitle','positionName','positionTitle','name']);
    const detail = first(object, ['jobDescription','jobDesc','postDescription','positionDescription','description','jobContent']);
    const salary = first(object, ['salaryDesc','salary','salaryName']);
    const city = first(object, ['cityName','city','locationName','workCity']);
    const company = first(object, ['brandName','companyName','companyShortName']);
    const url = findUrl(object);
    const id = first(object, ['encryptJobId','jobEncryptId','encryptId','jobId','positionId']);
    const useful = title && (url || id || detail.length > 30 || salary);
    return useful ? { title, detail: detail.slice(0, 18000), salary, city, company, url, id } : null;
  }

  function scan(root) {
    if (!root || typeof root !== 'object') return;
    const candidates = [];
    const visited = new WeakSet();
    const queue = [{ value: root, depth: 0 }];
    let count = 0;
    while (queue.length && count < 12000) {
      const { value, depth } = queue.shift(); count += 1;
      if (!value || typeof value !== 'object' || visited.has(value) || depth > 10) continue;
      visited.add(value);
      if (!Array.isArray(value)) {
        const candidate = normalize(value);
        if (candidate) candidates.push(candidate);
      }
      for (const child of Object.values(value)) {
        if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
      }
    }
    const unique = [];
    for (const item of candidates) {
      const key = `${item.id}|${item.url}|${item.title}|${item.salary}`;
      if (!seen.has(key)) { seen.add(key); unique.push(item); cached.push(item); }
    }
    if (unique.length) window.postMessage({ source: SOURCE, type: 'jobCandidates', candidates: unique.slice(0, 30) }, location.origin);
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'boss-helper-content') return;
    if (event.data.type === 'setJobReadEnabled') {
      jobReadEnabled = Boolean(event.data.enabled);
      if (!jobReadEnabled) probe = null;
      return;
    }
    if (event.data.type === 'requestJobCandidates') {
      // 请求时立即扫描当前“查看职位”组件，避免只依赖首次接口响应。
      scanViewJobState();
      if (cached.length) window.postMessage({ source: SOURCE, type: 'jobCandidates', candidates: cached.slice(-30) }, location.origin);
    }
    if (event.data.type === 'probeViewJob') {
      if (!jobReadEnabled) return;
      const markedTarget = document.querySelector(`[data-bh-active-job-target="${CSS.escape(String(event.data.key || ''))}"]`);
      const target = markedTarget || [...document.querySelectorAll('a,button,[role="button"],span,div')]
        .find(node => (node.textContent || '').trim() === '查看职位' && isActuallyVisible(node));
      if (!target) {
        window.postMessage({ source: SOURCE, type: 'jobProbeFailed', key: event.data.key, reason: '未找到查看职位按钮' }, location.origin);
        return;
      }
      probe = { key: event.data.key, expiresAt: Date.now() + 1500 };
      const binding = findBoundClickHandler(target);
      if (binding) {
        try {
          binding.handler.call(binding.node, {
            type: 'click', target, currentTarget: binding.node, button: 0, isTrusted: true,
            preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {},
            nativeEvent: { target, button: 0, isTrusted: true }
          });
        } catch (_) { /* 继续使用 DOM 点击作为回退 */ }
      }
      const preventDefaultNavigation = clickEvent => {
        if (probe?.key === event.data.key && (clickEvent.target === target || target.contains(clickEvent.target))) clickEvent.preventDefault();
      };
      document.addEventListener('click', preventDefaultNavigation, true);
      if (probe) { try { target.click(); } catch (_) { probe = null; } }
      document.removeEventListener('click', preventDefaultNavigation, true);
      setTimeout(() => {
        if (probe?.key === event.data.key) {
          probe = null;
          window.postMessage({ source: SOURCE, type: 'jobProbeFailed', key: event.data.key, reason: '未捕获到职位地址' }, location.origin);
        }
      }, 700);
    }
    if (event.data.type === 'openViewJobForRead') {
      if (!jobReadEnabled) return;
      probe = null;
      const markedTarget = document.querySelector(`[data-bh-active-job-target="${CSS.escape(String(event.data.key || ''))}"]`);
      const target = markedTarget || [...document.querySelectorAll('a,button,[role="button"],span,div')]
        .find(node => (node.textContent || '').trim() === '查看职位' && isActuallyVisible(node));
      if (!target) {
        window.postMessage({ source: SOURCE, type: 'jobAutoOpenFailed', key: event.data.key, reason: '未找到查看职位按钮' }, location.origin);
        return;
      }
      try {
        target.click();
      } catch (_) {
        window.postMessage({ source: SOURCE, type: 'jobAutoOpenFailed', key: event.data.key, reason: '无法打开职位页面' }, location.origin);
      }
    }
  });

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const requestUrl = String(args[0]?.url || args[0] || '');
      if (/zhipin\.com|\/wapi\/|\/api\//i.test(requestUrl)) response.clone().json().then(scan).catch(() => {});
    } catch (_) { /* 页面请求必须正常返回 */ }
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__bhUrl = String(url || '');
    return originalOpen.call(this, method, url, ...rest);
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      try {
        if (!/zhipin\.com|\/wapi\/|\/api\//i.test(this.__bhUrl || '')) return;
        if (this.responseType === 'json') scan(this.response);
        else if (!this.responseType || this.responseType === 'text') scan(JSON.parse(this.responseText));
      } catch (_) { /* 非 JSON 请求忽略 */ }
    }, { once: true });
    return originalSend.apply(this, args);
  };

  queueMicrotask(() => {
    try { scan(window.__INITIAL_STATE__); } catch (_) {}
    try { scan(window.__NEXT_DATA__); } catch (_) {}
  });

  function scanViewJobState() {
    try {
      const target = document.querySelector('[data-bh-active-job-target]') || [...document.querySelectorAll('a,button,[role="button"],span,div')]
        .find(node => (node.textContent || '').trim() === '查看职位' && isActuallyVisible(node));
      let node = target;
      for (let level = 0; node && level < 6; level += 1, node = node.parentElement) {
        for (const key of Object.getOwnPropertyNames(node)) {
          if (/^__react(?:Props|Fiber)|^__vue|^_vei$|^__vnode/i.test(key)) scan(node[key]);
        }
      }
    } catch (_) { /* 页面框架内部结构变化时忽略 */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scanViewJobState, { once: true });
  else scanViewJobState();
  setInterval(scanViewJobState, 1200);
})();
