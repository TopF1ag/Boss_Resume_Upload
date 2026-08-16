/**
 * Network Interceptor - 数据拦截层
 * ====================================
 * 此脚本以 MAIN world 在 document_start 阶段注入，
 * 运行在页面的真实 JS 上下文中（而非扩展沙箱），
 * 因此可以重写 window.fetch 和 XMLHttpRequest 原型。
 *
 * 核心原理：
 * 1. 保存原始 fetch/XHR 引用
 * 2. 用 Proxy/Wrapper 替换，透明代理所有请求
 * 3. 当检测到目标 API URL 的响应时，克隆 JSON 数据
 * 4. 通过 window.postMessage 将数据传递给 ISOLATED world 的 content script
 * 5. 原始响应完整无损地返回给页面，确保网页正常运行
 */

// ============================================================
// 需要监听的 API 路径模式（命中则截获数据）
// ============================================================
const INTERCEPT_PATTERNS: ReadonlyArray<string> = [
  '/wapi/zpgeek/search/joblist.json',    // 搜索结果岗位列表
  '/wapi/zpgeek/recommend/joblist.json', // 推荐页岗位列表
  '/wapi/zpgeek/pc/recommend/job/list.json', // 另一种推荐列表
];

/** 判断 URL 是否命中拦截规则 */
function shouldIntercept(url: string): boolean {
  try {
    const pathname = new URL(url, location.origin).pathname.toLowerCase();
    return pathname.includes('/zpgeek/') && (pathname.includes('job') || pathname.includes('list') || pathname.includes('search') || pathname.includes('recommend'));
  } catch {
    return false;
  }
}

/** 用于缓存最后一次拦截的数据，防止由于 content_script 注入时间差导致漏接 */
let lastInterceptedData: { apiPath: string; data: unknown } | null = null;

/**
 * 将拦截到的数据通过 postMessage 发往 ISOLATED world
 * 使用自定义的消息类型标记，避免与页面自身消息冲突
 */
function dispatchInterceptedData(apiPath: string, data: unknown): void {
  lastInterceptedData = { apiPath, data };
  window.postMessage({
    type: '__BOSS_HELPER_INTERCEPTED__',
    source: 'network-interceptor',
    payload: {
      api: apiPath,
      data: data,
      timestamp: Date.now(),
    },
  }, '*');
}

// 监听来自 index.ts 的就绪信号，如果收到，则立即把最后一次缓存的数据补发过去
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type === '__BOSS_HELPER_READY__' && lastInterceptedData) {
    console.log('[Interceptor] 收到执行引擎就绪信号，推送缓存数据');
    dispatchInterceptedData(lastInterceptedData.apiPath, lastInterceptedData.data);
  }
});

// ============================================================
// 一、劫持 window.fetch
// ============================================================
const originalFetch = window.fetch.bind(window);

window.fetch = async function patchedFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const url = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : (input as Request).url;

  // 透明放行请求
  const response = await originalFetch(input, init);

  // 非目标 API 直接返回
  if (!shouldIntercept(url)) {
    return response;
  }

  // 命中拦截：克隆 Response（Response body 只能读一次）
  try {
    const cloned = response.clone();
    const json = await cloned.json();
    const pathname = new URL(url, location.origin).pathname;

    console.log(
      `%c[Interceptor] 捕获 fetch 数据 → ${pathname}`,
      'color: #00bebd; font-weight: bold;',
      json
    );
    dispatchInterceptedData(pathname, json);
  } catch (err) {
    console.warn('[Interceptor] fetch 响应解析失败:', err);
  }

  // 将原始 response 完整返回给页面
  return response;
};

// ============================================================
// 二、劫持 XMLHttpRequest（兜底：部分老接口或内部库可能用 XHR）
// ============================================================
const XHRProto = XMLHttpRequest.prototype;
const originalOpen = XHRProto.open;
const originalSend = XHRProto.send;

/** 在 XHR 实例上记录请求 URL */
XHRProto.open = function patchedOpen(
  this: XMLHttpRequest & { _interceptUrl?: string },
  method: string,
  url: string | URL,
  ...args: any[]
): void {
  this._interceptUrl = typeof url === 'string' ? url : url.href;
  // @ts-expect-error - rest args 透传
  return originalOpen.call(this, method, url, ...args);
};

XHRProto.send = function patchedSend(
  this: XMLHttpRequest & { _interceptUrl?: string },
  body?: Document | XMLHttpRequestBodyInit | null
): void {
  const targetUrl = this._interceptUrl;

  if (targetUrl && shouldIntercept(targetUrl)) {
    this.addEventListener('load', function onLoad() {
      try {
        const json = JSON.parse(this.responseText);
        const pathname = new URL(targetUrl, location.origin).pathname;

        console.log(
          `%c[Interceptor] 捕获 XHR 数据 → ${pathname}`,
          'color: #e67e22; font-weight: bold;',
          json
        );
        dispatchInterceptedData(pathname, json);
      } catch (err) {
        console.warn('[Interceptor] XHR 响应解析失败:', err);
      }
    });
  }

  return originalSend.call(this, body);
};

// ============================================================
// 三、导航拦截（投递期间阻止跳转到聊天页）
// ============================================================

/** 投递是否正在进行中 */
let isDeliveryActiveState = false;
function isDeliveryActive(): boolean {
  return isDeliveryActiveState || (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-boss-delivery-active') === 'true');
}

/** 需要拦截的导航路径模式（聊天页 + 详情页 SPA 跳转均拦截） */
const BLOCKED_NAV_PATTERNS = ['/web/geek/chat', '/chat/', '/job_detail/'];

/** 仅用于程序化导航拦截（pushState / replaceState / location 等） */
function isBlockedNavigation(url: string): boolean {
  try {
    const target = new URL(url, location.origin);
    return BLOCKED_NAV_PATTERNS.some(p => target.pathname.includes(p));
  } catch {
    return url.includes('/chat') || url.includes('/job_detail/');
  }
}

/** 仅用于 <a> 标签点击拦截（只拦聊天页，不拦 /job_detail/ 因为卡片本身就是 <a href='/job_detail/...'>） */
function isChatNavigation(url: string): boolean {
  try {
    const target = new URL(url, location.origin);
    return target.pathname.includes('/web/geek/chat') || target.pathname.includes('/chat/');
  } catch {
    return url.includes('/chat');
  }
}

// 劫持 history.pushState
const originalPushState = history.pushState.bind(history);
history.pushState = function(state: any, title: string, url?: string | URL | null) {
  if (isDeliveryActive() && url && isBlockedNavigation(String(url))) {
    console.log(
      '%c[Interceptor] 🚫 拦截 pushState 跳转: ' + url,
      'color: #e74c3c; font-weight: bold;'
    );
    return; // 直接吞掉，不执行跳转
  }
  return originalPushState(state, title, url);
};

// 劫持 history.replaceState
const originalReplaceState = history.replaceState.bind(history);
history.replaceState = function(state: any, title: string, url?: string | URL | null) {
  if (isDeliveryActive() && url && isBlockedNavigation(String(url))) {
    console.log(
      '%c[Interceptor] 🚫 拦截 replaceState 跳转: ' + url,
      'color: #e74c3c; font-weight: bold;'
    );
    return;
  }
  return originalReplaceState(state, title, url);
};

// 1. 劫持 Location.prototype.href
try {
  const originalHrefDescriptor = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
  if (originalHrefDescriptor && originalHrefDescriptor.set) {
    Object.defineProperty(Location.prototype, 'href', {
      get() {
        return originalHrefDescriptor.get!.call(this);
      },
      set(val) {
        if (isDeliveryActive() && isBlockedNavigation(String(val))) {
          console.log(
            '%c[Interceptor] 🚫 拦截 Location.href 赋值跳转: ' + val,
            'color: #e74c3c; font-weight: bold;'
          );
          return;
        }
        originalHrefDescriptor.set!.call(this, val);
      }
    });
  }
} catch (e) {
  console.warn('[Interceptor] 无法劫持 Location.prototype.href:', e);
}

// 2. 劫持 window.location.assign 和 replace
try {
  const originalAssign = window.location.assign;
  window.location.assign = function(url: string) {
    if (isDeliveryActive() && isBlockedNavigation(String(url))) {
      console.log(
        '%c[Interceptor] 🚫 拦截 location.assign 跳转: ' + url,
        'color: #e74c3c; font-weight: bold;'
      );
      return;
    }
    return originalAssign.call(window.location, url);
  };

  const originalReplace = window.location.replace;
  window.location.replace = function(url: string) {
    if (isDeliveryActive() && isBlockedNavigation(String(url))) {
      console.log(
        '%c[Interceptor] 🚫 拦截 location.replace 跳转: ' + url,
        'color: #e74c3c; font-weight: bold;'
      );
      return;
    }
    return originalReplace.call(window.location, url);
  };
} catch (e) {
  console.warn('[Interceptor] 无法劫持 location 函数:', e);
}

// 3. 劫持 window.open
try {
  const originalOpen = window.open;
  window.open = function(url?: string | URL, target?: string, features?: string): Window | null {
    if (isDeliveryActive() && url && isBlockedNavigation(String(url))) {
      console.log(
        '%c[Interceptor] 🚫 拦截 window.open 跳转: ' + url,
        'color: #e74c3c; font-weight: bold;'
      );
      return null;
    }
    return originalOpen.call(window, url, target, features);
  } as any;
} catch (e) {
  console.warn('[Interceptor] 无法劫持 window.open:', e);
}

// 4. beforeunload 兜底提示与日志
window.addEventListener('beforeunload', (_event) => {
  if (isDeliveryActive()) {
    console.log(
      '%c[Interceptor] ⚠️ 检测到 beforeunload，投递进行中',
      'color: #e74c3c;'
    );
  }
});

// 拦截 <a> 标签的点击跳转
document.addEventListener('click', (event) => {
  if (!isDeliveryActive()) return;
  
  const target = event.target as HTMLElement;
  const anchor = target.closest('a');
  if (anchor && anchor.href && isChatNavigation(anchor.href)) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    console.log(
      '%c[Interceptor] 🚫 拦截 <a> 标签跳转到聊天页: ' + anchor.href,
      'color: #e74c3c; font-weight: bold;'
    );
  }
}, true); // 捕获阶段拦截，确保在页面自身 handler 之前

// 监听来自 content script 的投递状态消息
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  
  if (event.data?.type === '__BOSS_HELPER_DELIVERY_ACTIVE__') {
    isDeliveryActiveState = true;
    console.log(
      '%c[Interceptor] 🔒 导航拦截已启用',
      'color: #00bebd; font-weight: bold;'
    );
  }
  
  if (event.data?.type === '__BOSS_HELPER_DELIVERY_INACTIVE__') {
    isDeliveryActiveState = false;
    console.log(
      '%c[Interceptor] 🔓 导航拦截已关闭',
      'color: #95a5a6;'
    );
  }
});

// Hook Vue Router 阻止 SPA 内存中路由跳转
function hookVueRouter() {
  let attempts = 0;
  const interval = setInterval(() => {
    attempts++;
    try {
      const wrap = document.querySelector('#wrap') as any;
      if (wrap && wrap.__vue__) {
        const rootVue = wrap.__vue__;
        const router = rootVue.$router || (rootVue.$root && rootVue.$root.$router);
        if (router && typeof router.beforeEach === 'function') {
          console.log('[Interceptor] 🎯 成功获取 Vue Router，已注入全局导航守卫');
          router.beforeEach((to: any, _from: any, next: any) => {
            if (isDeliveryActive() && isBlockedNavigation(to.path)) {
              console.log('%c[Interceptor] 🚫 Vue Router 拦截跳转: ' + to.fullPath, 'color: #e74c3c; font-weight: bold;');
              next(false); // 阻止跳转
            } else {
              next(); // 放行
            }
          });
          clearInterval(interval);
          return;
        }
      }
    } catch (e) {
      console.warn('[Interceptor] 尝试获取 Vue Router 时异常:', e);
    }
    if (attempts > 200) { // 最多尝试 20 秒
      clearInterval(interval);
    }
  }, 100);
}

// 启动 Hook 监听
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hookVueRouter);
  } else {
    hookVueRouter();
  }
}

console.log(
  '%c[Boss Helper] Network Interceptor 已就绪 🎯 (含导航拦截)',
  'color: #00bebd; font-size: 14px; font-weight: bold;'
);
