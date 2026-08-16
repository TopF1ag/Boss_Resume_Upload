/**
 * Content Script - 主执行引擎 (ISOLATED World)
 * ====================================
 * 
 * 职责：
 * 1. 通过 window.addEventListener('message') 接收 Interceptor 传来的岗位 JSON 数据
 * 2. 根据用户配置（黑白名单、薪资范围）进行二次过滤
 * 3. 通过仿生学点击引擎，对符合条件的岗位执行 DOM 物理点击
 * 4. 自动翻页并循环处理
 * 5. 通过 MutationObserver 监测安全弹窗，触发熔断机制
 */

import type {
  JobItem,
  InterceptedMessage,
  DeliveryConfig,
  StatusReport,
} from './api/types';
import { DEFAULT_CONFIG } from './api/types';
import { bionicClick, scrollToElement, humanDelay } from './api/engine';

// ============================================================
// 全局状态
// ============================================================

/** 从 Interceptor 截获的岗位数据池 */
let interceptedJobs: JobItem[] = [];

/** 用户配置 */
let userConfig: DeliveryConfig = { ...DEFAULT_CONFIG };

/** 运行状态 */
let isRunning = false;
let shouldStop = false;
let isCircuitBroken = false;

/** 统计计数器 */
let deliveredCount = 0;
let skippedCount = 0;
let totalScanned = 0;
let currentJobName = '';

function setCurrentJobName(name: string) {
  currentJobName = name;
}

console.log(
  '%c[Boss Helper] Content Script 引擎已加载 ⚡',
  'color: #00bebd; font-size: 13px; font-weight: bold;'
);

// ============================================================
// 一、接收 Interceptor 拦截的数据
// ============================================================

window.addEventListener('message', (event: MessageEvent) => {
  // 只处理来自同源页面的拦截器消息
  if (event.source !== window) return;

  const msg = event.data as InterceptedMessage;
  if (msg?.type !== '__BOSS_HELPER_INTERCEPTED__' || msg?.source !== 'network-interceptor') return;

  const payload = msg?.payload as any;
  const data = payload?.data;
  const zpData = data?.zpData;

  const list = zpData?.jobList || zpData?.list || zpData?.cardList || zpData?.jobCardList;
  if (data?.code === 0 && Array.isArray(list) && list.length > 0) {
    interceptedJobs = list;
    console.log(
      `%c[Engine] 接收到 ${interceptedJobs.length} 条岗位数据`,
      'color: #2ecc71; font-weight: bold;'
    );
  }
});

// ============================================================
// 二、安全熔断监测器 (MutationObserver)
// ============================================================

function setupSecurityObserver(): void {
  const observer = new MutationObserver(() => {
    // 检测常见的验证码/滑块/安全弹窗元素
    const securitySelectors = [
      '.geetest_panel',
      '.verify-wrap',
      '.dialog-container',
      'iframe[src*="captcha"]',
      '.sbox-dialog',
    ];

    const securityElements = Array.from(document.querySelectorAll(securitySelectors.join(','))).filter(el => {
      // 检查元素是否可见 (offsetParent !== null 表示可见，但在固定定位等情况下可能有例外，综合判断)
      const htmlEl = el as HTMLElement;
      return htmlEl.offsetWidth > 0 || htmlEl.offsetHeight > 0 || htmlEl.getClientRects().length > 0;
    });

    if (securityElements.length > 0 && !isCircuitBroken) {
      console.error('🚨 [安全熔断] 检测到人机验证弹窗，投递已紧急暂停！');
      isCircuitBroken = true;
      setCurrentJobName('安全验证中，已暂停');
      notifyStatus('检测到安全验证，已暂停');
      // 通知 Background 弹出警告
      chrome.runtime.sendMessage({ type: 'TRIGGER_ALARM' });
    } else if (securityElements.length === 0 && isCircuitBroken) {
      console.log('✅ [熔断解除] 验证弹窗已消失，系统恢复就绪');
      isCircuitBroken = false;
      setCurrentJobName('验证弹窗已消失，恢复就绪');
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// ============================================================
// 三、岗位过滤引擎
// ============================================================

/**
 * 解析月薪描述字符串（全职岗位）
 * 匹配格式：
 *   "15-30K"       → { min: 15, max: 30 }
 *   "15-30K·16薪"  → { min: 15, max: 30 }
 *   "20-35k"       → { min: 20, max: 35 }
 */
function parseMonthlySalary(salaryDesc: string): { min: number; max: number } | null {
  const match = salaryDesc.match(/(\d+)-(\d+)[Kk]/);
  if (!match) return null;
  return { min: parseInt(match[1], 10), max: parseInt(match[2], 10) };
}

/**
 * 解析日薪描述字符串（实习岗位）
 * 匹配格式：
 *   "400-500元/天"  → { min: 400, max: 500 }
 *   "300-350元/天"  → { min: 300, max: 350 }
 *   "180-200元/天"  → { min: 180, max: 200 }
 */
function parseDailySalary(salaryDesc: string): { min: number; max: number } | null {
  const match = salaryDesc.match(/(\d+)-(\d+)\s*元\s*\/\s*天/);
  if (!match) return null;
  return { min: parseInt(match[1], 10), max: parseInt(match[2], 10) };
}

/**
 * 判断薪资描述是否为实习日薪格式
 */
function isDailySalaryFormat(salaryDesc: string): boolean {
  return /元\s*\/\s*天/.test(salaryDesc);
}

/**
 * 根据用户配置判断岗位是否应被投递
 */
function shouldDeliver(job: JobItem, config: DeliveryConfig): { pass: boolean; reason?: string } {
  const jobLabelsText = (job.jobLabels || []).join(' ');
  const welfareText = (job.welfareList || []).join(' ');
  const skillsText = (job.skills || []).join(' ');
  const jobText = `${job.jobName} ${job.brandName} ${job.brandIndustry} ${jobLabelsText} ${welfareText} ${skillsText}`.toLowerCase();

  // 黑名单关键词检查
  for (const keyword of config.blacklistKeywords) {
    if (!keyword) continue;

    // 字符串匹配
    if (jobText.includes(keyword.toLowerCase())) {
      return { pass: false, reason: `黑名单命中: "${keyword}"` };
    }

    // "代招/猎头" 特殊标识匹配 (BOSS直聘接口里的 goldHunter 字段表示代招/猎头)
    if ((keyword === '代招' || keyword === '猎头') && job.goldHunter === 1) {
      return { pass: false, reason: `黑名单命中: "${keyword}" (系统代招标识)` };
    }
  }

  // 白名单关键词检查（非空时必须命中至少一个）
  if (config.whitelistKeywords.length > 0) {
    const hasMatch = config.whitelistKeywords.some(kw =>
      kw && jobText.includes(kw.toLowerCase())
    );
    if (!hasMatch) {
      return { pass: false, reason: '未命中白名单' };
    }
  }

  // 薪资过滤：根据格式自动区分全职月薪（K）和实习日薪（元/天）
  if (isDailySalaryFormat(job.salaryDesc)) {
    // ---- 实习岗位：日薪过滤 ----
    if (config.dailySalaryMin > 0 || config.dailySalaryMax > 0) {
      const daily = parseDailySalary(job.salaryDesc);
      if (daily) {
        if (config.dailySalaryMin > 0 && daily.max < config.dailySalaryMin) {
          return { pass: false, reason: `日薪上限 ${daily.max}元/天 < 要求最低 ${config.dailySalaryMin}元/天` };
        }
        if (config.dailySalaryMax > 0 && daily.min > config.dailySalaryMax) {
          return { pass: false, reason: `日薪下限 ${daily.min}元/天 > 要求最高 ${config.dailySalaryMax}元/天` };
        }
      }
    }
  } else {
    // ---- 全职岗位：月薪过滤 ----
    if (config.salaryMin > 0 || config.salaryMax > 0) {
      const salary = parseMonthlySalary(job.salaryDesc);
      if (salary) {
        if (config.salaryMin > 0 && salary.max < config.salaryMin) {
          return { pass: false, reason: `月薪上限 ${salary.max}K < 要求最低 ${config.salaryMin}K` };
        }
        if (config.salaryMax > 0 && salary.min > config.salaryMax) {
          return { pass: false, reason: `月薪下限 ${salary.min}K > 要求最高 ${config.salaryMax}K` };
        }
      }
    }
  }

  // 已沟通过滤
  if (config.skipContacted && job.contact) {
    return { pass: false, reason: '已沟通过' };
  }

  // 公司规模黑名单
  if (config.companyScaleBlacklist.length > 0) {
    for (const scale of config.companyScaleBlacklist) {
      if (scale && job.brandScaleName && job.brandScaleName.includes(scale)) {
        return { pass: false, reason: `公司规模命中黑名单: "${scale}"` };
      }
    }
  }

  return { pass: true };
}

// ============================================================
// 四、DOM 定位与物理执行
// ============================================================

/**
 * 递归寻找包含目标文本的最内层「可见」叶子节点元素
 * 只有当子元素同样具有可见面积时才继续深入，避免返回宽高为 0 的 <span> 导致 bionicClick 提前退出
 */
function getDeepestVisibleChildWithText(el: Element, text: string): Element {
  for (const child of Array.from(el.children)) {
    const childText = (child.textContent || '').trim().replace(/\s+/g, ' ');
    if (!childText.includes(text)) continue;
    // 只有子元素自身也可见时才继续深入
    const childRect = child.getBoundingClientRect();
    if (childRect.width > 0 && childRect.height > 0) {
      return getDeepestVisibleChildWithText(child, text);
    }
  }
  return el;
}

/**
 * 在页面 DOM 中定位指定 jobId 对应的岗位卡片元素
 * 通过匹配卡片中的链接 href（包含 encryptJobId）来精确定位
 */
function findJobCardElement(encryptJobId: string): Element | null {
  // 策略 1：通过 href 链接匹配
  const link = document.querySelector(
    `a[href*="${encryptJobId}"], a[ka*="${encryptJobId}"]`
  );
  if (link) {
    // 向上查找最近的岗位卡片容器
    return link.closest('.job-card-wrapper, .job-card-body, .job-card-left, li[ka]') || link;
  }

  // 策略 2：遍历所有卡片寻找匹配
  const allCards = document.querySelectorAll('.job-card-wrapper, .search-job-result li');
  for (const card of allCards) {
    const cardLinks = card.querySelectorAll('a[href]');
    for (const cardLink of cardLinks) {
      if (cardLink.getAttribute('href')?.includes(encryptJobId)) {
        return card;
      }
    }
  }

  return null;
}

/**
 * 在右侧详情面板中查找"立即沟通"按钮
 * 
 * 关键设计：只在全局右侧详情面板（.job-detail-box 等）中查找，
 * 不在卡片元素内查找，避免面板未切换时误匹配上一个岗位的按钮。
 * 同时明确排除"继续沟通"（已投递过的岗位），防止跳转聊天页。
 */
function findChatButtonInDetailPanel(): Element | null {
  // BOSS直聘右侧详情面板的可能选择器
  const panelSelectors = [
    '.job-detail-box',
    '.job-detail-body',
    '.job-detail-wrapper',
    '.detail-box',
    '[class*="job-detail"]',
  ];

  for (const selector of panelSelectors) {
    const panel = document.querySelector(selector);
    if (!panel) continue;

    const panelRect = panel.getBoundingClientRect();
    if (panelRect.width === 0 || panelRect.height === 0) continue;

    const allBtns = panel.querySelectorAll('a, button, [class*="btn"]');
    for (const btn of allBtns) {
      const text = (btn.textContent || '').trim();
      // 只匹配"立即沟通"，明确排除"继续沟通"
      if (text === '立即沟通') {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          return getDeepestVisibleChildWithText(btn, '立即沟通');
        }
      }
    }
  }

  return null;
}


/**
 * 查找"下一页"按钮
 * 
 * 策略（按优先级）：
 * 1. 通过已知的分页容器 CSS 选择器查找（兼容旧版）
 * 2. 通用兜底：全局扫描所有可见的 <a> 和 <button>，按文本内容 "下一页" 定位
 * 
 * 诊断日志：输出查找过程，便于定位失败原因
 */
function findNextPageButton(): Element | null {
  // ---- 策略 1：通过已知分页容器选择器查找 ----
  const knownSelectors = [
    '.options-pages a',
    '.page-container a',
    '.ui-pager a',
    '[class*="pagination"] a',
    '[class*="pagination"] button',
    '[class*="pager"] a',
    '[class*="pager"] button',
    '.page-job a',
    '.page-job button',
  ];
  const selectorStr = knownSelectors.join(', ');
  const paginationBtns = document.querySelectorAll(selectorStr);

  console.log(`[Engine/翻页诊断] 策略1: 已知选择器匹配到 ${paginationBtns.length} 个元素`);

  for (const btn of paginationBtns) {
    const text = (btn.textContent || '').trim();
    const isNextIcon = !!btn.querySelector('.ui-icon-arrow-right') || btn.classList.contains('ui-icon-arrow-right');
    if (text === '下一页' || btn.classList.contains('next') || btn.classList.contains('ui-pager-next') || isNextIcon) {
      // 检查是否禁用
      if (btn.classList.contains('disabled') || btn.getAttribute('aria-disabled') === 'true') {
        console.log('[Engine/翻页诊断] 找到"下一页"按钮但已禁用（已是最后一页）');
        return null;
      }
      const rect = btn.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        console.log('[Engine/翻页诊断] ✅ 策略1命中! 元素:', btn.tagName, '类名:', btn.className);
        return btn;
      }
    }
  }

  // ---- 策略 2：通用兜底 - 全局文本搜索 ----
  // 扫描页面中所有 <a> 和 <button> 元素，只要文本内容 "下一页" 即可
  const allBtns = document.querySelectorAll('a, button');
  for (const btn of allBtns) {
    if ((btn.textContent || '').trim() === '下一页') {
      if (btn.classList.contains('disabled') || btn.getAttribute('aria-disabled') === 'true') {
        console.log('[Engine/翻页诊断] 策略2找到"下一页"按钮但已禁用');
        return null;
      }
      const rect = btn.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        console.log('[Engine/翻页诊断] ✅ 策略2命中! 元素:', btn.tagName, '类名:', btn.className);
        return btn;
      }
    }
  }

  return null;
}

// ============================================================
// 五、核心投递循环引擎
// ============================================================

async function executeDeliveryLoop(): Promise<void> {
  isRunning = true;
  shouldStop = false;
  deliveredCount = 0;
  skippedCount = 0;
  totalScanned = 0;
  isCircuitBroken = false;

  // 通知 Interceptor 开启导航拦截
  document.body.setAttribute('data-boss-delivery-active', 'true');
  window.postMessage({ type: '__BOSS_HELPER_DELIVERY_ACTIVE__' }, '*');

  console.log('[Engine] 🚀 开始执行投递循环引擎...');
  // Step 0: 先处理当前页面已有的岗位数据（页面加载时 Interceptor 已拦截到的首页数据）
  if (interceptedJobs.length > 0) {
    console.log(
      `%c[Engine] 📋 当前页已有 ${interceptedJobs.length} 条岗位数据，优先处理`,
      'color: #2ecc71; font-weight: bold;'
    );
    await processCurrentPage();
  }

  while (!shouldStop && deliveredCount < userConfig.maxDeliveryCount) {
    console.log(
      `%c[Engine] 📊 当前进度: 已投递 ${deliveredCount}/${userConfig.maxDeliveryCount}，` +
      `已跳过 ${skippedCount}，已扫描 ${totalScanned}`,
      'color: #3498db; font-weight: bold;'
    );

    // Step 1: 尝试找到"下一页"按钮
    const nextBtn = findNextPageButton();

    // Step 2: 清空旧数据，准备接收新数据
    interceptedJobs = [];

    if (nextBtn) {
      // ---- 分页翻页模式 ----
      console.log('[Engine] 📄 找到下一页按钮，准备翻页...');
      setCurrentJobName('翻页中...');
      notifyStatus('翻页中...');

      // 先滚动到按钮可见位置
      await scrollToElement(nextBtn);
      await humanDelay(1000, 2000);

      // 点击翻页
      const clicked = await bionicClick(nextBtn);
      console.log(`[Engine] 翻页按钮点击结果: ${clicked}`);

      if (!clicked) {
        // bionicClick 失败，尝试原生 click 兜底
        console.warn('[Engine] bionicClick 翻页失败，尝试原生 click 兜底');
        (nextBtn as HTMLElement).click();
      }

      // 翻页后额外等待页面渲染
      await humanDelay(2000, 4000);
    } else {
      // ---- 无限滚动兜底模式（搜索页通常不走这里） ----
      console.log('[Engine] 未找到下一页按钮，尝试滚动兜底...');
      setCurrentJobName('尝试滚动加载...');
      notifyStatus('尝试滚动加载...');

      const forceScrollToBottom = () => {
        // 1. 将最后一个卡片滚动到底部
        const cards = document.querySelectorAll('.job-card-wrapper, .search-job-result li, .job-list-box li, .job-card-box, li[ka]');
        if (cards.length > 0) {
          const lastCard = cards[cards.length - 1];
          lastCard.scrollIntoView({ behavior: 'smooth', block: 'end' });

          // 2. 暴力遍历所有父节点，将任何带有滚动条的容器滚到底部并触发事件
          let parent = lastCard.parentElement;
          while (parent && parent !== document.body && parent !== document.documentElement) {
            if (parent.scrollHeight > parent.clientHeight) {
              parent.scrollTop = parent.scrollHeight;
              parent.dispatchEvent(new Event('scroll', { bubbles: true }));
            }
            parent = parent.parentElement;
          }
        }

        // 3. 兜底全局滚动
        window.scrollTo(0, document.body.scrollHeight);
        window.dispatchEvent(new Event('scroll'));

        // 4. 特殊照顾已知的常见列表容器
        const wrappers = document.querySelectorAll('.job-list-wrapper, .job-list-container, .search-job-result, .recommend-job-list, .job-list-box, .search-job-list-wrap, .job-tab-box');
        wrappers.forEach(w => {
          if (w.scrollHeight > w.clientHeight) {
            w.scrollTop = w.scrollHeight;
            w.dispatchEvent(new Event('scroll', { bubbles: true }));
          }
        });

        // 5. 检查是否有“点击加载更多”按钮并点击（严格排除右侧详情面板，防止误触"查看更多信息"等跳转按钮）
        const moreBtns = document.querySelectorAll('button, a, div[class*="load-more"], div[class*="loadmore"]');
        for (const btn of moreBtns) {
          // 绝对排除右侧详情面板内部的所有元素
          if (btn.closest('.job-detail-box, .job-detail-body, .job-detail-wrapper, .detail-box, [class*="job-detail"], .job-detail-section')) {
            continue;
          }

          const text = (btn.textContent || '').trim().replace(/\s+/g, ' ');
          // 严格排除详情跳转文案
          if (text.includes('更多信息') || text.includes('查看更多信息') || text.includes('完整信息')) {
            continue;
          }

          // 仅匹配明确的列表加载更多文案
          if (text === '加载更多' || text === '点击加载更多' || text === '显示更多' || text === '加载更多职位' || (text.includes('加载更多') && !text.includes('信息'))) {
            const rect = btn.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              console.log('[Engine] 找到列表"加载更多"按钮，执行点击:', text);
              const anchor = btn.closest('a') || (btn.tagName === 'A' ? btn : null);
              if (anchor) {
                anchor.addEventListener('click', (e: Event) => e.preventDefault(), { once: true, capture: true });
              }
              (btn as HTMLElement).click();
              break;
            }
          }
        }
      };

      forceScrollToBottom();
      await humanDelay(2000, 4000);
    }

    // Step 3: 等待 Interceptor 推送新的岗位数据
    let pageWait = 0;
    const maxWaitIterations = 20; // 最多等待约 10-20 秒
    console.log('[Engine] ⏳ 等待新岗位数据到达...');

    while (interceptedJobs.length === 0 && pageWait < maxWaitIterations) {
      await humanDelay(500, 1000);
      pageWait++;

      // 如果是滚动加载，每隔几次重试触发滚动事件（全局与列表容器）
      if (!nextBtn && pageWait % 2 === 0) {
        window.scrollTo(0, document.body.scrollHeight);
        window.dispatchEvent(new Event('scroll'));
        document.dispatchEvent(new Event('scroll'));

        const wrappers = document.querySelectorAll('.job-list-wrapper, .job-list-container, .search-job-result, .recommend-job-list, .job-list-box, .search-job-list-wrap, .job-tab-box');
        wrappers.forEach(w => {
          if (w.scrollHeight > w.clientHeight) {
            w.scrollTop = w.scrollHeight;
            w.dispatchEvent(new Event('scroll', { bubbles: true }));
          }
        });
      }

      // 每 5 秒输出一次等待状态
      if (pageWait % 5 === 0) {
        console.log(`[Engine] 仍在等待数据... (${pageWait}/${maxWaitIterations})`);
      }
    }

    // 兜底方案：如果网络拦截未抓到新接口，直接从 DOM 中解析页面所有岗位卡片
    if (interceptedJobs.length === 0) {
      console.log('[Engine] ⚠️ 网络拦截未捕获到新数据，启动 DOM 兜底解析...');
      const domCards = document.querySelectorAll('.job-card-wrapper, .search-job-result li, .job-list-box li, li[ka]');
      const parsedJobs: any[] = [];
      domCards.forEach((card) => {
        const link = card.querySelector('a[href*="/job_detail/"]');
        if (link) {
          const href = link.getAttribute('href') || '';
          const match = href.match(/\/job_detail\/([^.]+)/);
          if (match) {
            const encryptJobId = match[1];
            const jobName = (card.querySelector('.job-name, .job-title, [class*="job-title"]')?.textContent || '').trim();
            const brandName = (card.querySelector('.company-name, .brand-name, [class*="brand-name"]')?.textContent || '').trim();
            const salaryDesc = (card.querySelector('.salary, .job-salary, [class*="salary"]')?.textContent || '').trim();
            parsedJobs.push({
              encryptJobId,
              jobName: jobName || '未知岗位',
              brandName: brandName || '未知公司',
              salaryDesc: salaryDesc || '面议',
              cityName: '',
              areaDistrict: '',
              businessDistrict: '',
              jobLabels: [],
              skills: [],
              bossName: '',
              bossTitle: '',
              goldHunter: 0
            });
          }
        }
      });

      if (parsedJobs.length > 0) {
        interceptedJobs = parsedJobs;
        console.log(`[Engine] ✅ 成功从 DOM 提取到 ${interceptedJobs.length} 条岗位卡片`);
      }
    }

    if (interceptedJobs.length === 0) {
      console.warn(
        '%c[Engine] ⚠️ 翻页后未收到新数据，停止任务。' +
        '可能原因: 已到最后一页，或翻页未成功触发新 API 请求。',
        'color: #e74c3c; font-weight: bold;'
      );
      break;
    }

    console.log(
      `%c[Engine] ✅ 收到 ${interceptedJobs.length} 条新岗位数据，继续处理`,
      'color: #2ecc71; font-weight: bold;'
    );
    await processCurrentPage();
  }

  // 任务完成
  isRunning = false;

  // 通知 Interceptor 关闭导航拦截
  document.body.removeAttribute('data-boss-delivery-active');
  window.postMessage({ type: '__BOSS_HELPER_DELIVERY_INACTIVE__' }, '*');

  const finalMsg = shouldStop
    ? `已手动停止。共投递 ${deliveredCount} 个，跳过 ${skippedCount} 个`
    : `任务完成！共投递 ${deliveredCount} 个，跳过 ${skippedCount} 个`;

  setCurrentJobName(shouldStop ? '已停止' : '任务完成');
  console.log(`[Engine] 🎉 ${finalMsg}`);
  notifyStatus(finalMsg);
}

/**
 * 处理当前页面的所有岗位
 */
async function processCurrentPage(): Promise<void> {
  const jobs = [...interceptedJobs]; // 快照

  for (const job of jobs) {
    if (shouldStop || deliveredCount >= userConfig.maxDeliveryCount) break;

    // 熔断等待
    while (isCircuitBroken && !shouldStop) {
      await humanDelay(1000, 2000);
    }
    if (shouldStop) break;

    totalScanned++;
    setCurrentJobName(`${job.jobName} - ${job.brandName}`);

    // 二次过滤
    const filterResult = shouldDeliver(job, userConfig);
    if (!filterResult.pass) {
      skippedCount++;
      console.log(
        `%c[Filter] ⏭ 跳过「${job.jobName}」@${job.brandName} → ${filterResult.reason}`,
        'color: #95a5a6;'
      );
      notifyStatus(`跳过: ${job.jobName} (${filterResult.reason})`);
      continue;
    }

    console.log(
      `%c[Engine]  目标锁定「${job.jobName}」@${job.brandName} ${job.salaryDesc}`,
      'color: #f39c12; font-weight: bold;'
    );

    // Step 1: 定位岗位卡片并滚动到可视区
    const cardEl = findJobCardElement(job.encryptJobId);
    if (!cardEl) {
      console.warn(`[Engine] 未在 DOM 中找到岗位卡片: ${job.encryptJobId}`);
      skippedCount++;
      continue;
    }

    await scrollToElement(cardEl);
    await humanDelay(600, 1000); // 模拟人类视觉扫描时间

    // Step 2: 必须先点击卡片，让右侧详情面板更新为当前岗位
    // 核心逻辑：BOSS直聘的"立即沟通"按钮在右侧面板，不在卡片元素内。
    // 每次必须点击卡片切换面板，否则面板还显示上一个岗位，会误点上一个岗位的按钮。
    console.log(`[Engine] 点击卡片切换详情面板: ${job.jobName}`);
    await bionicClick(cardEl);
    await humanDelay(1200, 2000); // 等待右侧详情面板加载完毕

    // Step 3: 在右侧详情面板中找"立即沟通"按钮
    // 明确只找右侧面板，避免匹配到卡片上的其他按钮
    const chatBtn = findChatButtonInDetailPanel();

    if (!chatBtn) {
      console.warn(`[Engine] 未在详情面板找到"立即沟通"按钮: ${job.jobName}（可能已沟通或不匹配）`);
      skippedCount++;
      continue;
    }

    notifyStatus(`正在投递: ${job.jobName}`);
    await scrollToElement(chatBtn);
    await humanDelay(500, 1000);

    // Step 3: 点击沟通按钮
    const clicked = await bionicClick(chatBtn);
    if (!clicked) {
      console.warn(`[Engine] 按钮点击失败: ${job.jobName}`);
      skippedCount++;
      continue;
    }

    // Step 4: 等待弹窗出现并处理（"留在此页" / 关闭弹窗）
    console.log(`[Engine] 等待投递弹窗出现...`);
    const dialogResult = await waitAndDismissDialog();

    if (dialogResult === 'limit') {
      // 沟通次数达上限，强制停止
      break;
    }

    if (dialogResult === 'success' || dialogResult === 'dismissed') {
      deliveredCount++;
      console.log(
        `%c[Engine] ✅ 成功投递 (${deliveredCount}/${userConfig.maxDeliveryCount})「${job.jobName}」@${job.brandName}`,
        'color: #2ecc71; font-weight: bold;'
      );
    } else {
      console.warn(`[Engine] 弹窗处理异常，跳过: ${job.jobName}`);
      skippedCount++;
    }

    // Step 5: 投递间冷却（使用用户设置的间隔时间）
    const minMs = userConfig.delayMinSeconds * 1000;
    const maxMs = userConfig.delayMaxSeconds * 1000;
    const cooldownMs = minMs + Math.random() * (maxMs - minMs);
    setCurrentJobName(`冷却中 (${Math.round(cooldownMs / 1000)}s)...`);
    notifyStatus(`冷却中 (${Math.round(cooldownMs / 1000)}s)...`);
    await humanDelay(cooldownMs, cooldownMs + 500);
  }
}

/**
 * 等待投递弹窗出现并处理
 * 
 * 弹窗出现后，点击"留在此页"关闭弹窗，继续下一个投递。
 * 绝对不点击"继续沟通"。
 * 
 * @returns 'success' | 'limit' | 'dismissed' | 'timeout'
 */
async function waitAndDismissDialog(): Promise<'success' | 'limit' | 'dismissed' | 'timeout'> {
  // 等待弹窗出现，最多轮询 12 秒
  for (let i = 0; i < 24; i++) {
    await humanDelay(500, 500);

    // ---- 检查是否达到沟通上限 ----
    const allVisibleDialogs = Array.from(document.querySelectorAll(
      '.dialog-con, .sbox-dialog, .dialog-container, [class*="dialog"], [class*="modal"]'
    )).filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });

    for (const dialog of allVisibleDialogs) {
      const text = dialog.textContent || '';
      if (text.includes('上限') || text.includes('限制') || text.includes('次数已') || text.includes('频繁')) {
        console.error('🚨 [Engine] 沟通次数达上限！');
        shouldStop = true;
        setCurrentJobName('今日沟通次数已达上限，自动停止');
        notifyStatus('今日沟通次数已达上限，自动停止');
        const closeBtn = dialog.querySelector('.close, [class*="close"], .icon-close') as HTMLElement;
        if (closeBtn) closeBtn.click();
        return 'limit';
      }
    }

    // ---- 优先检查"已向BOSS发送消息"弹窗，找"留在此页"按钮 ----
    const stayBtn = findStayButton();
    if (stayBtn) {
      console.log('[Engine] ✅ 找到"留在此页"按钮，元素类型:', stayBtn.tagName, '文本:', stayBtn.textContent?.trim());
      await humanDelay(200, 400);

      // 无论是 button 还是 a 标签，先对整个祖先链上的所有 <a> 标签绑定 preventDefault
      // 防止任何可能的默认导航行为
      const allAncestorAnchors = [];
      let parent: Element | null = stayBtn;
      while (parent) {
        if (parent.tagName === 'A') allAncestorAnchors.push(parent as HTMLAnchorElement);
        parent = parent.parentElement;
      }
      for (const anchor of allAncestorAnchors) {
        anchor.addEventListener('click', (e: Event) => e.preventDefault(), { once: true, capture: true });
      }

      // 直接调用原生 .click()，这是最可靠的触发方式
      (stayBtn as HTMLElement).click();

      console.log('[Engine] 已触发"留在此页"原生 click');
      await humanDelay(800, 1000);

      // 检查弹窗是否消失
      const stillThere = findStayButton();
      if (stillThere) {
        console.warn('[Engine] ⚠️ 原生 click 未关闭弹窗，尝试 bionicClick 兜底');
        await bionicClick(stillThere);
        await humanDelay(600, 800);
      }

      return 'success';
    }
  }

  console.log('[Engine] ⏱ 等待弹窗超时(12s)，假定已处理');
  return 'timeout';
}

/**
 * 专门用于在"已向BOSS发送消息"弹窗中查找"留在此页"按钮
 * 
 * 策略：
 * 1. 先找包含"已向BOSS发送消息"的弹窗容器（精确定位，避免误触页面其他按钮）
 * 2. 在弹窗内找文本包含"留在此页"但不包含"继续"的可见按钮
 */
function findStayButton(): Element | null {
  // 所有可能的弹窗容器选择器
  const dialogSelectors = [
    '.dialog-con',
    '.sbox-dialog',
    '.dialog-container',
    '[class*="dialog"]',
    '[class*="modal"]',
    '[class*="popup"]',
  ];

  for (const selector of dialogSelectors) {
    const dialogs = document.querySelectorAll(selector);
    for (const dialog of dialogs) {
      const dialogRect = dialog.getBoundingClientRect();
      if (dialogRect.width === 0 || dialogRect.height === 0) continue;

      // 确认这是投递成功弹窗（包含"已向BOSS发送消息"或"发送消息"文本）
      const dialogText = dialog.textContent || '';
      if (!dialogText.includes('发送消息') && !dialogText.includes('已向BOSS')) continue;

      // 在弹窗内查找"留在此页"按钮
      const allBtns = dialog.querySelectorAll('button, a, [class*="btn"], [class*="action"]');
      for (const btn of allBtns) {
        const btnText = (btn.textContent || '').trim().replace(/\s+/g, ' ');
        // 文本包含"留在此页"，且不包含"继续"（排除误匹配）
        if (btnText.includes('留在此页') && !btnText.includes('继续')) {
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return btn;
          }
        }
      }
    }
  }

  // 兜底：在全局范围内找，但必须确保文本精确包含"留在此页"且不包含其他危险文字
  const globalBtns = document.querySelectorAll('button, a[href]');
  for (const btn of globalBtns) {
    const btnText = (btn.textContent || '').trim().replace(/\s+/g, ' ');
    if (btnText === '留在此页') {
      const rect = btn.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return btn;
      }
    }
  }

  return null;
}



// ============================================================
// 六、状态通信
// ============================================================

function notifyStatus(message: string): void {
  const report: StatusReport = {
    type: 'STATUS_UPDATE',
    isRunning,
    deliveredCount,
    skippedCount,
    currentJobName: message,
    totalScanned,
    errorMessage: isCircuitBroken ? '安全验证中，已暂停' : undefined,
  };

  try {
    chrome.runtime.sendMessage(report);
  } catch {
    // 消息通道可能未建立，忽略
  }

  // 同时更新 badge
  try {
    chrome.runtime.sendMessage({
      type: 'UPDATE_BADGE',
      text: deliveredCount > 0 ? String(deliveredCount) : '',
    });
  } catch {
    // 忽略
  }
}

// ============================================================
// 七、消息监听（来自 Popup/Background）
// ============================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'START_DELIVERY') {
    if (isRunning) {
      sendResponse({ status: 'already_running' });
      return;
    }
    // 加载最新配置后启动
    chrome.storage.local.get(['bossDeliverConfig'], (result) => {
      if (result.bossDeliverConfig) {
        userConfig = { ...DEFAULT_CONFIG, ...result.bossDeliverConfig };
      }
      executeDeliveryLoop();
    });
    sendResponse({ status: 'started' });
  }

  if (message.type === 'STOP_DELIVERY') {
    shouldStop = true;
    console.log('[Engine] 收到停止指令');
    sendResponse({ status: 'stopping' });
  }

  if (message.type === 'GET_STATUS') {
    sendResponse({
      isRunning,
      deliveredCount,
      skippedCount,
      totalScanned,
      currentJobName,
      isCircuitBroken,
    });
  }

  return true; // 保持消息通道开放
});

// ============================================================
// 八、初始化
// ============================================================

setupSecurityObserver();
