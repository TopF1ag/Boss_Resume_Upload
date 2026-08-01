/**
 * 仿生学点击引擎 (Bionic Click Engine)
 * ====================================
 * 模拟真实用户鼠标操作的完整事件链。
 * 
 * 真实用户的鼠标操作会触发以下事件序列：
 *   pointerover → pointerenter → mouseover → mouseenter →
 *   pointermove → mousemove →
 *   pointerdown → mousedown → (focus) →
 *   pointerup → mouseup → click
 * 
 * 本引擎复现了这一完整链路，并在每一步之间注入
 * 符合人类反应时间分布的随机微延迟。
 */

/** 生成指定范围内的随机整数 */
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 生成指定范围内的随机浮点数 */
function randomFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

/** 异步等待（毫秒） */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 获取元素可视区域内的一个随机点击坐标
 * 人类不会精确点击元素的中心，而是略有偏移
 */
function getRandomPointInElement(el: Element): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  // 在元素内部留 20% 边距，避免点击到边缘
  const paddingX = rect.width * 0.2;
  const paddingY = rect.height * 0.2;

  return {
    x: rect.left + paddingX + randomFloat(0, rect.width - 2 * paddingX),
    y: rect.top + paddingY + randomFloat(0, rect.height - 2 * paddingY),
  };
}

/**
 * 构建一个标准的鼠标事件初始化参数
 */
function buildMouseEventInit(
  _el: Element,
  point: { x: number; y: number }
): MouseEventInit {
  return {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: point.x,
    clientY: point.y,
    screenX: point.x + window.screenX,
    screenY: point.y + window.screenY,
    button: 0,
    buttons: 1,
    relatedTarget: null,
  };
}

/**
 * 对指定元素执行完整的仿生点击操作
 * 
 * @param el - 要点击的 DOM 元素
 * @returns 是否成功触发了点击
 */
export async function bionicClick(el: Element): Promise<boolean> {
  if (!el || !el.getBoundingClientRect) return false;

  const rect = el.getBoundingClientRect();
  // 元素不可见（面积为 0 或在视口外）时跳过
  if (rect.width === 0 || rect.height === 0) return false;

  const point = getRandomPointInElement(el);
  const eventInit = buildMouseEventInit(el, point);

  try {
    // Step 1: Hover 进入区域
    el.dispatchEvent(new PointerEvent('pointerover', { ...eventInit, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('mouseover', eventInit));
    el.dispatchEvent(new PointerEvent('pointerenter', { ...eventInit, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('mouseenter', eventInit));
    await delay(randomInt(30, 80));

    // Step 2: 微小的鼠标移动（模拟手的微颤）
    const jitter = { x: point.x + randomFloat(-2, 2), y: point.y + randomFloat(-1, 1) };
    const moveInit = buildMouseEventInit(el, jitter);
    el.dispatchEvent(new PointerEvent('pointermove', { ...moveInit, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('mousemove', moveInit));
    await delay(randomInt(15, 50));

    // Step 3: 按下
    el.dispatchEvent(new PointerEvent('pointerdown', { ...eventInit, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', eventInit));
    await delay(randomInt(50, 120)); // 人类按下到松开的时间约 80-150ms

    // Step 4: 松开
    el.dispatchEvent(new PointerEvent('pointerup', { ...eventInit, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('mouseup', eventInit));
    await delay(randomInt(5, 15));

    // Step 5: 触发 click
    // ⚠️ 关键修复：如果目标是 <a> 标签（或其祖先是 <a>），
    // dispatchEvent(click) 会触发浏览器的默认 href 导航行为。
    // 我们需要在捕获阶段先拦截 click 事件，调用 preventDefault() 阻止导航，
    // 但事件仍会继续冒泡到 Vue/React 的事件处理器（它们只需要事件触发，不需要默认行为）。
    const anchorEl = el.closest('a') || (el.tagName === 'A' ? el : null);
    if (anchorEl) {
      anchorEl.addEventListener('click', (e: Event) => {
        e.preventDefault();
      }, { once: true, capture: true });
    }

    el.dispatchEvent(new MouseEvent('click', eventInit));

    return true;
  } catch (err) {
    console.warn('[BionicClick] 事件派发异常:', err);
    return false;
  }
}

/**
 * 将元素平滑滚动到可视区域
 * 模拟人类向下滚动查看下一个岗位的行为
 */
export async function scrollToElement(el: Element): Promise<void> {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // 等待滚动动画完成
  await delay(randomInt(400, 800));
}

/**
 * 高方差随机休眠
 * 模拟人类在浏览岗位时的阅读停留时间
 * 
 * @param minMs - 最小等待毫秒数
 * @param maxMs - 最大等待毫秒数
 */
export async function humanDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = randomInt(minMs, maxMs);
  await delay(ms);
}
