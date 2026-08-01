/**
 * 共享类型定义
 * ====================================
 * 定义跨模块使用的接口和类型
 */

// ============================================================
// 岗位数据模型（来自 API 响应）
// ============================================================

/** 单个岗位条目（从服务器 JSON 截获） */
export interface JobItem {
  encryptJobId: string;
  encryptBossId: string;
  encryptBrandId: string;
  expectId: number;
  securityId: string;
  lid: string;
  sessionId: string;

  jobName: string;
  jobDegree: string;
  jobExperience: string;
  jobLabels: string[];
  salaryDesc: string;

  cityName: string;
  areaDistrict: string;
  businessDistrict: string;

  brandName: string;
  brandIndustry: string;
  brandScaleName: string;
  brandStageName: string;
  brandLogo: string;

  bossName: string;
  bossTitle: string;
  bossAvatar: string;

  welfareList: string[];
  skills: string[];

  jobType: number;
  atsDirectPost: boolean;
  contact: boolean;
  gps?: { longitude: number; latitude: number };
  lastModifyTime?: number;
  bossOnline?: boolean;
  bossCert?: number;
  goldHunter?: number;
}

/** API 分页数据 */
export interface JobResponseData {
  jobList: JobItem[];
  pageSize: number;
  sessionId: string;
  totalCount: number;
  jobRecTips?: string;
}

/** API 顶层响应结构 */
export interface JobResponse {
  code: number;
  message: string;
  zpData: JobResponseData;
}

// ============================================================
// Interceptor -> Content Script 通信协议
// ============================================================

/** 由 interceptor.ts 通过 postMessage 发出的数据包 */
export interface InterceptedMessage {
  type: '__BOSS_HELPER_INTERCEPTED__';
  source: 'network-interceptor';
  payload: {
    api: string;
    data: JobResponse;
    timestamp: number;
  };
}

// ============================================================
// 用户配置模型（存储在 chrome.storage.local）
// ============================================================

/** 用户在 Popup 中设定的投递策略 */
export interface DeliveryConfig {
  /** 黑名单关键词（岗位名/公司名包含则跳过） */
  blacklistKeywords: string[];
  /** 白名单关键词（若非空，岗位名必须包含其一才投递） */
  whitelistKeywords: string[];
  /** 月薪下限过滤（单位 K，0 表示不过滤，适用于全职岗位） */
  salaryMin: number;
  /** 月薪上限过滤（单位 K，0 表示不过滤，适用于全职岗位） */
  salaryMax: number;
  /** 日薪下限过滤（单位 元/天，0 表示不过滤，适用于实习岗位） */
  dailySalaryMin: number;
  /** 日薪上限过滤（单位 元/天，0 表示不过滤，适用于实习岗位） */
  dailySalaryMax: number;
  /** 单次启动最大投递数量 */
  maxDeliveryCount: number;
  /** 排除已沟通过的岗位 */
  skipContacted: boolean;
  /** 公司规模偏好黑名单（如 "0-20人"） */
  companyScaleBlacklist: string[];
  /** 每次投递之间的最小间隔（秒） */
  delayMinSeconds: number;
  /** 每次投递之间的最大间隔（秒） */
  delayMaxSeconds: number;
}

/** chrome.storage.local 的默认配置 */
export const DEFAULT_CONFIG: DeliveryConfig = {
  blacklistKeywords: ['外包', '驻场', '培训', '代招'],
  whitelistKeywords: [],
  salaryMin: 0,
  salaryMax: 0,
  dailySalaryMin: 0,
  dailySalaryMax: 0,
  maxDeliveryCount: 30,
  skipContacted: true,
  companyScaleBlacklist: [],
  delayMinSeconds: 3,
  delayMaxSeconds: 8,
};

// ============================================================
// Background <-> Content Script 消息协议
// ============================================================

/** Popup/Background -> Content Script 的指令 */
export type CommandMessage =
  | { type: 'START_DELIVERY' }
  | { type: 'STOP_DELIVERY' }
  | { type: 'GET_STATUS' };

/** Content Script -> Popup/Background 的状态上报 */
export interface StatusReport {
  type: 'STATUS_UPDATE';
  isRunning: boolean;
  deliveredCount: number;
  skippedCount: number;
  currentJobName: string;
  totalScanned: number;
  errorMessage?: string;
}
