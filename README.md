<div align="center">

<img src="src-tauri/icons/icon.png" width="120" alt="GripRead" />

**简体中文** · [English](README.en.md)

# 手不释卷 · GripRead

**在手机、电脑和浏览器上读小说，随时从上次读到的地方接着读。**

基于 Tauri 2 的轻量阅读器，本地优先，可选自建服务器实时同步。

[![Build](https://github.com/Gabrlie/GripRead/actions/workflows/build.yml/badge.svg)](https://github.com/Gabrlie/GripRead/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/Gabrlie/GripRead?include_prereleases&label=release&color=4c8bf5)](https://github.com/Gabrlie/GripRead/releases)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)
[![Image](https://img.shields.io/badge/image-ghcr.io%2Fgabrlie%2Fgripread-2496ed?logo=docker&logoColor=white)](https://github.com/Gabrlie/GripRead/pkgs/container/gripread)
<br />
![Android](https://img.shields.io/badge/Android-3ddc84?logo=android&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white)
![Web](https://img.shields.io/badge/Web-ff7139?logo=firefoxbrowser&logoColor=white)
![Tauri](https://img.shields.io/badge/Tauri_2-24c8db?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-b7410e?logo=rust&logoColor=white)
![React](https://img.shields.io/badge/React-087ea4?logo=react&logoColor=white)

[功能](#功能) · [服务器](#服务器) · [下载](#下载) · [从源码构建](#从源码构建) · [开发](#开发)

</div>

> [!NOTE]
> 手不释卷目前处于早期开发阶段（0.x），版本之间的数据格式仍可能变化。升级前请先在 设置 › 备份与恢复 中做一次备份。

## 功能

<table>
<tr>
<td width="50%" valign="top">

### 📖 阅读

- **本地书籍**：导入 TXT 文件或整个文件夹，自动识别编码（UTF-8、GBK），按阅读（Legado）风格的规则识别章节
- **翻页动画**：仿真、滑动、覆盖、渐隐或无动画，另有滚动模式，宽屏下双页显示
- **排版**：字体、字号、间距、边距、主题和背景图
- **工具**：目录、全文搜索、书签、替换规则、简繁转换、自动翻页和朗读

</td>
<td width="50%" valign="top">

### 🌐 在线书籍

- **书源**：兼容阅读（Legado）的文本书源，支持搜索、发现、详情和章节
- **自备书源**：应用不内置任何书源，可从网址、文件或剪贴板导入
- **追更与缓存**：在线书籍加入书架，缓存章节离线阅读，下拉或自动更新书架

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 📚 书库

- **书架**：分组、阅读状态、排序和回收站
- **阅读记录**：每本书的阅读时长，以及按天的阅读日历
- **备份**：可移植的备份文件，逐项恢复，可跳过不需要的类别

</td>
<td width="50%" valign="top">

### 🔄 同步

- **WebDAV**：云端书籍文件夹、备份和阅读进度同步，无需注册账号
- **自建服务器**：书架、进度、书签、规则、书源和设置在设备间秒级同步
- **自主选择**：排除的类别既不上传，也不会被覆盖

</td>
</tr>
</table>

## 服务器

服务器是一个单独的容器：提供网页版书库，同时作为各设备的同步中心。为单用户设计。

```sh
docker run -d --name gripread \
  -p 8080:8080 \
  -v gripread-data:/data \
  --restart unless-stopped \
  ghcr.io/gabrlie/gripread:latest
```

打开 `http://<主机>:8080`，第一次访问时设置密码。需要在外网使用时，请在前面加一层带 HTTPS 的反向代理（Caddy、nginx 等）。Compose 部署可以参考 [`docker-compose.example.yml`](docker-compose.example.yml)。

| 环境变量            | 默认值  | 说明                             |
| ------------------- | ------- | -------------------------------- |
| `GRIPREAD_DATA`     | `/data` | 数据目录：书库、账号和备份       |
| `GRIPREAD_PORT`     | `8080`  | 监听端口                         |
| `GRIPREAD_PASSWORD` | 未设置  | 仅在第一次启动时用来设置访问密码 |

<details>
<summary><b>连接你的设备</b></summary>

1. 在应用中打开 设置 › 备份与云端 › 服务器。
2. 填写服务器地址、访问密码和设备名，点击 连接。
3. 本地书籍会自动上传到服务器，服务器上有而本机没有的书会自动下载（可以关闭）。

连接期间 WebDAV 备份和进度同步会暂停，断开后自动恢复。其他设备的阅读进度不会悄悄改变你的阅读位置，阅读器会先询问是否跳转。服务器每天会自动备份一次自己的书库。

</details>

## 下载

| 渠道     | 分支   | 镜像标签          | 应用                                                            |
| -------- | ------ | ----------------- | --------------------------------------------------------------- |
| 正式版   | `main` | `latest`、`X.Y.Z` | [最新版本](https://github.com/Gabrlie/GripRead/releases/latest) |
| 预发布版 | `dev`  | `dev`             | [预发布版本](https://github.com/Gabrlie/GripRead/releases)      |

每个版本都提供：

- **Android**：arm64-v8a（大多数手机）、armeabi-v7a（较旧的 32 位手机）、x86_64 / x86（模拟器和部分平板），以及包含全部架构的通用包。
- **macOS**：Apple Silicon 和 Intel 各一个 `.dmg`。应用没有签名，第一次打开时请在应用上右键选择「打开」，或在 系统设置 › 隐私与安全性 中点击「仍要打开」。

每个发布页都附有更新内容、提交记录和 `SHA256SUMS` 校验文件，历次变化见 [更新日志](CHANGELOG.md)。版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)，预发布版本形如 `X.Y.Z-beta.N`，用于正式发布前的测试。

## 从源码构建

**环境要求：** Node.js 22 及以上、pnpm 和 Rust stable。在 Linux 上，Tauri 还需要 [WebKitGTK 开发包](https://v2.tauri.app/start/prerequisites/)。

```sh
pnpm install
pnpm tauri dev               # 运行桌面应用
pnpm tauri build --debug     # 构建桌面应用
docker build -t gripread .   # 构建服务器镜像
```

**Android** 需要 JDK 17 以及 Android SDK 和 NDK，通过 `JAVA_HOME`、`ANDROID_HOME` 和 `NDK_HOME` 指定：

```sh
pnpm android:build           # 构建 arm64 调试版 APK
```

## 开发

```sh
pnpm check                   # 格式、文档、类型、测试、静态检查和前端构建
```

| 路径             | 内容                                       |
| ---------------- | ------------------------------------------ |
| `src/`           | React 界面，应用和网页版共用               |
| `crates/core/`   | 书库、阅读、书源、备份和同步，不依赖 Tauri |
| `crates/server/` | 服务器：网页版、账号和同步接口             |
| `src-tauri/`     | Tauri 外壳和 Android 插件                  |
| `.ai/`           | 规格说明、设计决策和开发计划（英文）       |

从 [AGENTS.md](AGENTS.md) 和 [文档索引](.ai/README.md) 开始阅读。[架构](.ai/architecture.md) 说明了模块划分和依赖方向，[工作流程](.ai/engineering/workflow.md) 说明了分支、提交、版本和发布。开发在 `dev` 分支进行，稳定后合并到 `main`。

## 未来规划

以下是接下来的方向，不承诺具体时间：

- **漫画**：在线漫画源、本地漫画（CBZ、ZIP、图片文件夹）和专门的漫画阅读界面（0.3.1 开发中）。
- **RSS 订阅**：订阅源管理、文章阅读、全文获取，以及在设备间同步已读和收藏。
- **AI 检索与问答**：按已读进度回答书中的人物和情节问题，不剧透；跨书检索内容。
- **有声书与朗读**：更自然的朗读声音和有声书支持。
- **桌面平台**：Windows 和 Linux 版本。
- **网页版**：补齐与应用一致的功能。

## 免责声明

1. 手不释卷是开源免费软件，仅供学习交流和阅读你有权阅读的内容。
2. 本软件不提供、不托管任何书籍内容，也不内置书源。书源、订阅中的内容来自第三方网站，由用户自行添加，与本软件及开发者无关。请遵守当地法律法规和网站的服务条款，尊重作者版权，支持正版。
3. 翻译会把文本发送给你配置的第三方翻译服务，相关费用、隐私和内容由该服务及其条款负责。
4. 开发者不收集任何个人数据。书籍、进度和设置保存在你的设备，以及你自己选择的 WebDAV 或自建服务器上，请自行备份。
5. 本软件按「现状」提供，不作任何担保；因使用本软件造成的数据丢失或其他损失，开发者不承担责任。
6. 如认为某些内容侵犯了你的权利，请联系提供该内容的网站处理。

使用本软件即表示你已阅读并同意以上内容。应用首次启动时会显示这份声明，之后可在 设置 › 关于 中查看。

## 致谢

- [阅读（Legado）](https://github.com/gedoor/legado)：手不释卷的阅读体验和书源格式参照了它。
- [OpenCC](https://github.com/BYVoid/OpenCC)：简繁转换词表（Apache-2.0）。
- [Tauri](https://tauri.app/)、[React](https://react.dev/) 和 [shadcn/ui](https://ui.shadcn.com/)。

## 许可证

手不释卷是自由软件，以 [GNU 通用公共许可证 v3.0](LICENSE) 发布。你可以自由使用、研究、修改和分享；如果分发本软件或修改后的版本，必须以相同许可证公开源代码。
