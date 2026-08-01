/**
 * Background Service Worker - 轻量化消息中枢
 * ====================================
 * 
 * 职责：
 * 1. 接收 Popup 的启动/停止指令，转发给目标标签页的 Content Script
 * 2. 接收 Content Script 的状态上报和熔断警报
 * 3. 管理浏览器通知和 Badge 更新
 */

console.log('[Background] Service Worker 已启动');

// ============================================================
// 消息路由
// ============================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // ---- 来自 Popup 的指令 ----
  if (message.type === 'START_DELIVERY' || message.type === 'STOP_DELIVERY') {
    // 查找当前活跃的 Boss 直聘标签页，转发指令
    forwardToActiveTab(message, sendResponse);
    return true; // 异步响应
  }

  if (message.type === 'GET_STATUS') {
    forwardToActiveTab(message, sendResponse);
    return true;
  }

  // ---- 来自 Content Script 的状态上报 ----
  if (message.type === 'STATUS_UPDATE') {
    // 可以在这里做持久化存储或额外处理
    // 暂时直接透传给 Popup（如果 Popup 在打开的话）
    sendResponse({ received: true });
  }

  if (message.type === 'UPDATE_BADGE') {
    const text = message.text || '';
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: '#00bebd' });
    sendResponse({ received: true });
  }

  // ---- 安全熔断警报 ----
  if (message.type === 'TRIGGER_ALARM') {
    chrome.notifications.create('security-alarm', {
      type: 'basic',
      iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      title: '⚠️ 投递助手安全警报',
      message: '检测到安全验证弹窗！投递已自动暂停，请手动完成验证后恢复。',
      priority: 2,
    });
    sendResponse({ status: 'alarm_received' });
  }
});

/**
 * 查找并转发消息到活跃的 Boss 直聘标签页
 */
async function forwardToActiveTab(
  message: any,
  sendResponse: (response?: any) => void
): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://www.zhipin.com/web/geek/job*'],
    });

    if (tabs.length === 0) {
      sendResponse({ error: '未找到 Boss 直聘页面，请先打开搜索页' });
      return;
    }

    // 优先使用活跃标签页
    const targetTab = tabs.find(t => t.active) || tabs[0];

    if (!targetTab.id) {
      sendResponse({ error: '标签页 ID 无效' });
      return;
    }

    chrome.tabs.sendMessage(targetTab.id, message, (response) => {
      if (chrome.runtime.lastError) {
        sendResponse({
          error: `通信失败: ${chrome.runtime.lastError.message}。请刷新页面后重试。`,
        });
      } else {
        sendResponse(response);
      }
    });
  } catch (err) {
    sendResponse({ error: `转发失败: ${err}` });
  }
}
