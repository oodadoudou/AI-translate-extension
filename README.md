# AI Translate Extension / AI 翻译扩展

[English](#english) | [中文](#中文)

---

<a name="中文"></a>
## 🇨🇳 中文说明

**AI Translate** 是一个基于 Chrome Manifest V3 的网页翻译扩展，旨在提供类似谷歌翻译的流畅体验，同时支持自定义任何 OpenAI 兼容的 AI 模型接口。

### 核心功能
- **谷歌风格弹窗**：选中网页文本后，弹窗自动出现。支持极简白主题、像素猫图标，弹窗支持拖拽选择时不消失（Sticky）且自适应内容大小。
- **流式翻译（Streaming）**：翻译结果像打字机一样即时显示，无需等待全部完成，极低延迟。
- **全文翻译**：点击扩展栏的“翻译整页”按钮，即可批量翻译当前页面的所有可见文本。
    - **双语切换**：页面右下角会出现悬浮球，点击即可瞬间在“原文”和“译文”之间切换。
- **格式保留**：严格保留段落、换行等原始排版格式。
- **即时开关**：在扩展菜单中关闭翻译功能后，立即生效，无需刷新页面。
- **自定义模型**：默认配置为火山引擎 ARK + DeepSeek 模型，但您可以随意更换为 OpenAI, Claude, 或其他兼容接口。

### 安装方法 (加载已解压的扩展程序)
1. 下载或克隆本项目文件夹。
2. 在 Chrome 浏览器地址栏输入 `chrome://extensions` 并回车。
3. 打开右上角的 **开发者模式 (Developer mode)** 开关。
4. 点击左上角的 **加载已解压的扩展程序 (Load unpacked)**。
5. 选择包含 `manifest.json` 的项目文件夹。

### 配置指南
1. 点击浏览器右上角的扩展图标 (像素猫) -> **Settings (设置)**。
2. 在设置页中，您可以修改 Base URL 和 Model，并填入您的 **API Key** (必填)。
    - 默认配置：Base URL 为 `https://ark.cn-beijing.volces.com/api/v3`，模型为 `deepseek-v3-2-251201`。
3. 您还可以设置源语言（Source Language）和目标语言（Target Language）。
4. 点击 **Test connection** 测试连通性，成功后点击 **Save** 保存。

### 使用说明
#### 划词翻译
- 确保扩展已开启。
- 在网页上选中一段文字，翻译弹窗会自动浮现。
- 如果内容过长，弹窗会自动扩展并出现滚动条。

#### 全文翻译
- 点击扩展栏图标，点击 **Translate Page (翻译整页)** 按钮。
- 右下角会出现 "Translating..." 提示。
- 翻译完成后，页面文本会被替换。点击右下角的浮窗可切换回原文。

---

<a name="english"></a>
## 🇺🇸 English

**AI Translate** is a Chrome Manifest V3 extension that translates selected text using a configurable OpenAI-compatible endpoint. It mimics the Google Translate inline popup experience with modern AI capabilities.

### Features
- **Google-Style Popup**: Minimalist white theme, centered positioning, sticky behavior (follows scroll), and adaptive sizing provided by a custom Shadow DOM overlay.
- **Streaming Translations**: Text appears instantly as it is generated (Server-Sent Events), providing a snappy experience.
- **Full Page Translation**: Translate valid text nodes across the entire page with a single click.
    - **Instant Toggle**: A floating widget allows you to switch between "Original" and "Translated" views instantly using cached results.
- **Smart Formatting**: Preserves original paragraph structure and line breaks via system prompt engineering.
- **Immediate Toggle**: Enable/disable the extension instantly without reloading the page.
- **Provider Agnostic**: Works with any OpenAI-compatible API (defaults to ARK/DeepSeek).

### Install (Load Unpacked)
1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** in the top right.
4. Click **Load unpacked** and select the project folder (the one containing `manifest.json`).

### Configuration
1. Click the extension icon (Pixel Cat) -> **Settings**.
2. Enter the Base URL, Model, and your **API Key**.
    - Defaults are set for ARK + DeepSeek (`deepseek-v3-2-251201`).
3. Click **Test connection** to verify, then **Save**.

### Usage
#### Inline Translation
- Enable translation in the popup.
- Select text on any page; a popover appears near the selection with the translated text.

#### Full Page Translation
- Open the extension popup and click **"Translate Page"**.
- A widget will appear at the bottom right indicating progress.
- Click the widget to toggle between the original and translated text.
