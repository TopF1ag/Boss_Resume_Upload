<script setup lang="ts">
import { ref, onMounted } from 'vue';
import type { DeliveryConfig } from '../content/api/types';
import { DEFAULT_CONFIG } from '../content/api/types';

// ============================================================
// 状态管理
// ============================================================

const config = ref<DeliveryConfig>({ ...DEFAULT_CONFIG });
const isSaving = ref(false);
const isRunning = ref(false);
const statusText = ref('就绪 - 请先在 Boss 直聘网页上完成筛选');
const statusType = ref<'idle' | 'running' | 'error' | 'success'>('idle');

/** 统计数据 */
const stats = ref({
  delivered: 0,
  skipped: 0,
  scanned: 0,
  currentJob: '',
});

/** 黑名单输入（逗号分隔的文本） */
const blacklistText = ref('');
const whitelistText = ref('');

// ============================================================
// 生命周期
// ============================================================

onMounted(async () => {
  // 从 storage 加载配置
  const result = await chrome.storage.local.get(['bossDeliverConfig']);
  if (result.bossDeliverConfig) {
    config.value = { ...DEFAULT_CONFIG, ...result.bossDeliverConfig };
  }
  blacklistText.value = config.value.blacklistKeywords.join(', ');
  whitelistText.value = config.value.whitelistKeywords.join(', ');

  // 获取当前运行状态
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
    if (response && !response.error) {
      isRunning.value = response.isRunning || false;
      stats.value.delivered = response.deliveredCount || 0;
      stats.value.skipped = response.skippedCount || 0;
      stats.value.scanned = response.totalScanned || 0;
      stats.value.currentJob = response.currentJobName || '';
      if (response.isRunning) {
        statusText.value = `正在投递: ${response.currentJobName || '处理中...'}`;
        statusType.value = 'running';
      }
    }
  });
});

// ============================================================
// 配置保存
// ============================================================

function parseKeywords(text: string): string[] {
  return text
    .split(/[,，、\n]/)
    .map(s => s.trim())
    .filter(Boolean);
}

async function saveConfig(): Promise<void> {
  isSaving.value = true;
  config.value.blacklistKeywords = parseKeywords(blacklistText.value);
  config.value.whitelistKeywords = parseKeywords(whitelistText.value);
  await chrome.storage.local.set({
    bossDeliverConfig: JSON.parse(JSON.stringify(config.value)),
  });
  isSaving.value = false;
}

// ============================================================
// 控制指令
// ============================================================

async function startDelivery(): Promise<void> {
  await saveConfig();
  statusType.value = 'running';
  statusText.value = '正在启动引擎...';

  chrome.runtime.sendMessage({ type: 'START_DELIVERY' }, (response) => {
    if (response?.error) {
      statusType.value = 'error';
      statusText.value = response.error;
    } else if (response?.status === 'already_running') {
      statusText.value = '引擎已在运行中';
    } else {
      isRunning.value = true;
      statusText.value = '引擎已启动，正在处理岗位...';
    }
  });
}

function stopDelivery(): void {
  chrome.runtime.sendMessage({ type: 'STOP_DELIVERY' }, (_response) => {
    isRunning.value = false;
    statusType.value = 'idle';
    statusText.value = `已停止。本次投递 ${stats.value.delivered} 个`;
  });
}

// ============================================================
// 状态监听
// ============================================================

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'STATUS_UPDATE') {
    isRunning.value = message.isRunning;
    stats.value.delivered = message.deliveredCount;
    stats.value.skipped = message.skippedCount;
    stats.value.scanned = message.totalScanned;
    stats.value.currentJob = message.currentJobName;

    if (!message.isRunning) {
      statusType.value = 'success';
      statusText.value = `完成！投递 ${message.deliveredCount}，跳过 ${message.skippedCount}`;
    } else {
      statusType.value = 'running';
      statusText.value = `投递中: ${message.currentJobName}`;
    }
  }
});
</script>

<template>
  <div class="popup-container">
    <!-- 头部 -->
    <div class="header">
      <div class="logo-row">
        <span class="logo-icon">🚀</span>
        <h1>BOSS 投递助手</h1>
        <span class="version">v2.0</span>
      </div>
      <p class="subtitle">请先在网页上筛选好岗位，再点击开始</p>
    </div>

    <!-- 状态面板 -->
    <div class="status-panel" :class="statusType">
      <div class="status-dot"></div>
      <span class="status-msg">{{ statusText }}</span>
    </div>

    <!-- 统计面板 -->
    <div class="stats-row" v-if="stats.scanned > 0">
      <div class="stat-item">
        <span class="stat-num delivered">{{ stats.delivered }}</span>
        <span class="stat-label">已投递</span>
      </div>
      <div class="stat-item">
        <span class="stat-num skipped">{{ stats.skipped }}</span>
        <span class="stat-label">已跳过</span>
      </div>
      <div class="stat-item">
        <span class="stat-num scanned">{{ stats.scanned }}</span>
        <span class="stat-label">已扫描</span>
      </div>
    </div>

    <!-- 配置区域 -->
    <div class="config-section">
      <div class="config-group">
        <label>
          <span class="label-icon">🚫</span>
          黑名单关键词
          <span class="hint">（包含则跳过，逗号分隔）</span>
        </label>
        <textarea
          v-model="blacklistText"
          placeholder="外包, 驻场, 培训, 代招"
          rows="2"
        ></textarea>
      </div>

      <div class="config-group">
        <label>
          <span class="label-icon">✅</span>
          白名单关键词
          <span class="hint">（不填则不限制）</span>
        </label>
        <textarea
          v-model="whitelistText"
          placeholder="留空表示不启用白名单过滤"
          rows="2"
        ></textarea>
      </div>

      <div class="config-row">
        <div class="config-group half">
          <label>月薪下限 (K)</label>
          <input type="number" v-model.number="config.salaryMin" min="0" placeholder="0 不限" />
        </div>
        <div class="config-group half">
          <label>月薪上限 (K)</label>
          <input type="number" v-model.number="config.salaryMax" min="0" placeholder="0 不限" />
        </div>
      </div>

      <div class="section-label">
        <span class="label-icon">🎓</span>
        实习岗位日薪过滤
        <span class="hint">（格式如 400-500元/天）</span>
      </div>
      <div class="config-row">
        <div class="config-group half">
          <label>日薪下限 (元/天)</label>
          <input type="number" v-model.number="config.dailySalaryMin" min="0" placeholder="0 不限" />
        </div>
        <div class="config-group half">
          <label>日薪上限 (元/天)</label>
          <input type="number" v-model.number="config.dailySalaryMax" min="0" placeholder="0 不限" />
        </div>
      </div>

      <div class="section-label">
        <span class="label-icon">⏱️</span>
        投递间隔
        <span class="hint">（每次沟通之间等待的秒数）</span>
      </div>
      <div class="config-row">
        <div class="config-group half">
          <label>最小间隔 (秒)</label>
          <input type="number" v-model.number="config.delayMinSeconds" min="1" max="60" placeholder="3" />
        </div>
        <div class="config-group half">
          <label>最大间隔 (秒)</label>
          <input type="number" v-model.number="config.delayMaxSeconds" min="1" max="120" placeholder="8" />
        </div>
      </div>
      <div class="delay-tip">
        💡 建议间隔不低于 3 秒。间隔越短效率越高，但风险也越大。
      </div>

      <div class="config-group">
        <label>单次最大投递数</label>
        <input type="number" v-model.number="config.maxDeliveryCount" min="1" max="100" />
      </div>

      <div class="config-group checkbox-group">
        <label>
          <input type="checkbox" v-model="config.skipContacted" />
          跳过已沟通过的岗位
        </label>
      </div>
    </div>

    <!-- 操作按钮 -->
    <div class="action-bar">
      <button
        v-if="!isRunning"
        class="btn btn-start"
        @click="startDelivery"
      >
        ▶ 开始投递
      </button>
      <button
        v-else
        class="btn btn-stop"
        @click="stopDelivery"
      >
        ⏹ 停止投递
      </button>
    </div>

    <div class="footer-hint">
      <span v-if="isSaving">💾 配置保存中...</span>
      <span v-else>💡 配置会自动保存</span>
    </div>
  </div>
</template>

<style scoped>
* {
  box-sizing: border-box;
}

.popup-container {
  width: 360px;
  padding: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #2c3e50;
  background: linear-gradient(135deg, #f8fffe 0%, #f0faf9 100%);
}

/* ---- 头部 ---- */
.header {
  padding: 16px 18px 12px;
  background: linear-gradient(135deg, #00bebd 0%, #00a89e 100%);
  color: white;
}

.logo-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.logo-icon {
  font-size: 22px;
}

.header h1 {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 0.5px;
}

.version {
  margin-left: auto;
  font-size: 11px;
  background: rgba(255, 255, 255, 0.25);
  padding: 2px 8px;
  border-radius: 10px;
}

.subtitle {
  margin: 6px 0 0;
  font-size: 12px;
  opacity: 0.85;
}

/* ---- 状态面板 ---- */
.status-panel {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 14px;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 12px;
  background: #f0f4f8;
  border: 1px solid #e2e8f0;
  transition: all 0.3s ease;
}

.status-panel.running {
  background: #e8f8f5;
  border-color: #00bebd;
}

.status-panel.error {
  background: #fef2f2;
  border-color: #f87171;
}

.status-panel.success {
  background: #ecfdf5;
  border-color: #34d399;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #94a3b8;
  flex-shrink: 0;
}

.status-panel.running .status-dot {
  background: #00bebd;
  animation: pulse 1.5s ease-in-out infinite;
}

.status-panel.error .status-dot {
  background: #f87171;
}

.status-panel.success .status-dot {
  background: #34d399;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(1.3); }
}

.status-msg {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 统计面板 ---- */
.stats-row {
  display: flex;
  justify-content: space-around;
  margin: 0 14px 12px;
  padding: 10px 0;
  background: white;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.stat-num {
  font-size: 20px;
  font-weight: 700;
}

.stat-num.delivered { color: #00bebd; }
.stat-num.skipped { color: #f59e0b; }
.stat-num.scanned { color: #64748b; }

.stat-label {
  font-size: 11px;
  color: #94a3b8;
}

/* ---- 配置区域 ---- */
.config-section {
  padding: 0 14px;
}

.config-group {
  margin-bottom: 10px;
}

.config-group label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 4px;
  color: #475569;
}

.label-icon {
  margin-right: 4px;
}

.hint {
  font-weight: 400;
  color: #94a3b8;
  font-size: 11px;
}

textarea,
input[type="number"],
input[type="text"] {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  font-size: 12px;
  background: white;
  color: #334155;
  transition: border-color 0.2s;
  resize: vertical;
}

textarea:focus,
input:focus {
  outline: none;
  border-color: #00bebd;
  box-shadow: 0 0 0 3px rgba(0, 190, 189, 0.1);
}

.config-row {
  display: flex;
  gap: 10px;
}

.config-group.half {
  flex: 1;
}

.checkbox-group {
  margin-top: 4px;
}

.checkbox-group label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
  cursor: pointer;
}

.checkbox-group input[type="checkbox"] {
  width: 15px;
  height: 15px;
  accent-color: #00bebd;
}

/* ---- 操作按钮 ---- */
.action-bar {
  padding: 12px 14px 8px;
}

.btn {
  width: 100%;
  padding: 12px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.2s ease;
  letter-spacing: 0.5px;
}

.btn-start {
  background: linear-gradient(135deg, #00bebd 0%, #00a89e 100%);
  color: white;
  box-shadow: 0 4px 12px rgba(0, 190, 189, 0.3);
}

.btn-start:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 16px rgba(0, 190, 189, 0.4);
}

.btn-start:active {
  transform: translateY(0);
}

.btn-stop {
  background: linear-gradient(135deg, #f87171 0%, #ef4444 100%);
  color: white;
  box-shadow: 0 4px 12px rgba(248, 113, 113, 0.3);
}

.btn-stop:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 16px rgba(248, 113, 113, 0.4);
}

/* ---- 底部提示 ---- */
.footer-hint {
  padding: 6px 14px 14px;
  text-align: center;
  font-size: 11px;
  color: #94a3b8;
}

/* ---- 分区标题 ---- */
.section-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 600;
  color: #475569;
  margin: 8px 0 6px;
  padding-top: 6px;
  border-top: 1px dashed #e2e8f0;
}

/* ---- 间隔提示 ---- */
.delay-tip {
  font-size: 11px;
  color: #f59e0b;
  background: #fffbeb;
  border: 1px solid #fef3c7;
  border-radius: 6px;
  padding: 6px 10px;
  margin-bottom: 10px;
  line-height: 1.4;
}
</style>
