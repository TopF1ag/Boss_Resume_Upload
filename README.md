# BOSS 直聘自动化精准投递助手 v2.0

> 一款基于 Manifest V3 架构、融合“网络层零感知拦截”与“仿生学物理点击”的自动化精准投递浏览器扩展。

![Chrome Extension](https://img.shields.io/badge/Chrome_Extension-MV3-4285F4?style=flat-square&logo=google-chrome&logoColor=white)
![Vue.js](https://img.shields.io/badge/Vue-3.x-4FC08D?style=flat-square&logo=vuedotjs&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-5.x-646CFF?style=flat-square&logo=vite&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)

---

## 一、 项目简介与技术栈

### 1.1 项目简介
针对海量岗位纯手工投递效率极其低下、且市面常规脚本极易触发平台风控（极验滑块/封号）的行业痛点，本项目打造了一套**高效率**与**高隐蔽性**兼备的自动化辅助系统。用户可在 BOSS 直聘网页端配合自定义黑白名单、薪资区间及每日投递上限，实现自动化精准沟通。

### 1.2 技术栈一览
- **扩展规范**：Chrome Extension Manifest V3 (MV3)
- **构建工具**：Vite 5 + `@crxjs/vite-plugin` + TypeScript 5
- **前端框架**：Vue 3 (Composition API) 打造极简 Popup 控制面板
- **底层架构**：MAIN World & ISOLATED World 双层上下文隔离与通信机制

## 二、 项目背景与设计初衷

在求职投递过程中，传统自动化方案往往面临两难境地：

1. **纯 API 模拟发包**：极易命中平台后台的风控签名（如 `zpData`、`zp_token` 及频次限流），导致账号被挂起或直接封号；
2. **纯 DOM 页面抓取**：受限于异步加载与动态渲染，DOM 节点常缺少加密的 `encryptJobId` 与完整薪资信息，且点击过于机械化，容易被原生 `isTrusted` 事件校验拦截。

> [!TIP]
> 本项目旨在实现 **“高效率”** 与 **“高隐蔽性”** 的完美平衡。

## 三、 底层架构与设计选型

### 3.1 为什么选择 Chrome MV3 扩展形态？
- **天然信任与免密登录**：直接运行于用户已登录的真实浏览器环境，天然继承 Session 与 Cookie 凭证，零额外配置成本。
- **静态安全契约**：严格遵循 MV3 的内容安全策略 (CSP)，代码 100% 静态打包本地化，防止远程注入风险。

### 3.2 为什么采用 MAIN World + ISOLATED World 混合双界架构？
为同时解决“数据获取不准”与“物理点击安全”两大矛盾，系统采用了分层解耦设计：

```text
MAIN World (页面真实上下文)           ISOLATED World (扩展沙箱)
┌────────────────────────┐          ┌────────────────────────┐
│  interceptor.ts        │          │  index.ts (执行引擎)   │
│  - 代理 fetch/XHR      │ postMsg  │  - 匹配过滤规则        │
│  - 抓取岗位 JSON 数据 ──┼─────────►│  - 查找定位 DOM        │
└────────────────────────┘          └───────────┬────────────┘
                                                │ 仿生物理事件
                                                ▼
                                    ┌────────────────────────┐
                                    │  engine.ts             │
                                    │  - 仿生点击/平滑滚动   │
                                    └────────────────────────┘
```

1. **MAIN World 拦截层 (`src/content/interceptor.ts`)**：
   在 `document_start` 阶段注入页面的原生 JS 上下文，透明重写 `window.fetch` 与 `XMLHttpRequest`。当页面加载岗位列表时，克隆并捕抓服务端返回的原始 JSON，获取精准的岗位维度数据（包括 `encryptJobId`），并通过 `window.postMessage` 安全转发。
2. **ISOLATED World 执行层 (`src/content/index.ts`)**：
   运行在隔离的扩展沙箱中，接收拦截数据并执行黑白名单、薪资条件筛选。匹配成功后通过 `encryptJobId` 精准定位页面 `<a href>` 元素，避免误触。

## 四、 核心亮点与抗风控机制

### 4.1 完整仿生事件链模拟
在 `src/content/api/engine.ts` 中，并非简单调用 `element.click()`，而是严格复现真实人类鼠标操作的完整物理事件链：

`pointerover → mouseover → pointerenter → mouseenter → pointermove → mousemove → pointerdown → mousedown → pointerup → mouseup → click`

并在点击坐标中加入 20% 内边距随机偏移与微抖动（Jitter），轻松绕过 `isTrusted` 检测。

### 4.2 高方差时序与平滑阻力滚动
- **阻力下拉**：借助 `scrollIntoView({ behavior: 'smooth' })` 结合随机帧延迟，模拟真实人类滚轮下拉。
- **高方差休眠**：在投递周期中注入 5~15 秒（带随机高斯分布）的休眠间歇，打乱操作的时序特征。

### 4.3 异常安全熔断网
挂载全局 `MutationObserver` 监听 DOM 树变动。一旦检测到极验滑块、验证弹窗或限流提示：
1. **立即挂起**：拦截并挂起所有异步任务队列；
2. **唤醒通知**：调用 `chrome.notifications` 弹框与响铃唤醒用户；
3. **无缝恢复**：用户手动通过验证后，系统侦测到弹窗消失，自动解除熔断并恢复投递进度。

## 五、 快速上手与使用步骤

### 5.1 构建打包
```bash
# 安装依赖
npm install

# 编译项目 (产出至 dist 目录)
npm run build
```

### 5.2 安装扩展
1. 打开 Chrome / Edge 浏览器，导航至扩展管理页面：`chrome://extensions/`；
2. 开启右上角 **“开发者模式”**；
3. 点击 **“加载已解压的扩展程序”**，选择项目根目录下的 `dist` 文件夹即可完成安装。

### 5.3 最佳实践操作流程
1. **第一步（原生筛选）**：打开 BOSS直聘网页，使用官方原生的筛选条件设定好城市、岗位名称、学历要求等；
2. **第二步（扩展配置）**：点击浏览器右上角扩展图标打开 Popup 面板，设置关键词黑名单（排除不喜欢的公司/职位）、薪资范围及单日投递上限；
3. **第三步（启动投递）**：点击面板中的“开始投递”，系统将接管当前页面并自动顺次执行；
4. **第四步（安全看护）**：如遇到拼图验证，系统会发出提示音并挂起，您只需手动完成滑动拼图，插件将继续为您工作。

## 六、 交流与反馈

本项目体量较小，纯粹是为了解决自己日常痛点而写的轻量级辅助工具，远不及市面上那些极其庞大复杂的整体自动化投递大项目。但在隐蔽性和抗风控方面（封号？不存在的！），本作还是花了不少心思的。

因为没有搞什么交流群，所以如果大家在使用过程中遇到问题（比如 DOM 结构变了导致失效），欢迎直接提交 Issue。

同时我也深知代码和架构还有很多进步的空间，如果您有更好的仿生学算法或者架构思路，也非常希望有大佬能不吝赐教、指点迷津！

## 七、 免责声明 (Disclaimer)

> [!WARNING]
> 本项目仅供技术交流与学习测试使用，旨在探讨前端网络拦截与自动化测试技术。
> **开发者不对任何人因使用本工具造成的任何直接或间接损失（包括但不限于账号被限制、封禁等）承担任何责任。**

在使用本项目时，请您严格遵守目标平台的用户协议。合理设置投递频率，避免对目标平台服务器造成恶意破坏或干扰。

## 八、 开源协议

本项目基于 [MIT License](LICENSE) 协议开源。
