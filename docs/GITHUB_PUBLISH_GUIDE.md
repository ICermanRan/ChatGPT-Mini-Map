# 把 ChatGPT 对话小地图发布到 GitHub

这份指南用于发布准备好的源码目录 `chatgpt-minimap-open-source`。推荐仓库名：`chatgpt-minimap`。文件目前只在本地准备，以下步骤需要你自己在 GitHub 操作；完成网页上传即可开源，Git 命令和 Release 都是可选项。

## 1. 准备上传的文件

如果拿到的是源码 ZIP，先解压，打开 `chatgpt-minimap-open-source`，直到能直接看到 `manifest.json`。上传的是这一层里面的文件和子文件夹：

```text
chatgpt-minimap-open-source/
├── manifest.json
├── README.md
├── LICENSE
├── .gitignore
├── .github/
├── CONTRIBUTING.md
├── CHANGELOG.md
├── content.js
├── conversation-bridge.js
├── conversation-model.js
├── navigation.js
├── panel.css
├── popup.html
├── popup.css
├── popup.js
├── icons/
└── docs/
```

不要只上传 ZIP，也不要上传整个 Codex 工作目录。源码目录之外的测试浏览器配置、临时文件和个人聊天截图不需要放进仓库。

本地默认准备了 **MIT 许可证**，署名采用中性的项目 contributors。MIT 允许商用、修改与再分发，分发时须保留版权和许可声明。你可以在首次发布前更换许可证，并同步修改 README 中的说明。参见 GitHub 维护的 [MIT 许可证介绍](https://choosealicense.com/licenses/mit/)。

## 2. 新建 Public 空仓库

1. 登录 GitHub，打开[新建仓库页面](https://github.com/new)。
2. Owner 选择你的账号，Repository name 填 `chatgpt-minimap`。
3. Description 可填：`为 ChatGPT 长对话添加小地图侧栏：问答目录、全文搜索、消息跳转与阅读定位。原生 JavaScript / Manifest V3，无需 API Key。`
4. 可见性选择 **Public**。
5. 关闭 **Add README**，`.gitignore` 和 License 都选 **None / 不添加**；这些文件源码包里已有。
6. 点击 **Create repository**。这些设置对应 GitHub 的[新建仓库说明](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-new-repository)。

## 3. 网页上传源码

1. 空仓库页面点击 **uploading an existing file**。如果仓库已有文件，使用 **Add file → Upload files**。
2. 打开本地源码目录，选中它**里面**的全部文件，以及 `.github`、`icons`、`docs` 子文件夹，拖到网页上传区域；不要拖最外层 `chatgpt-minimap-open-source` 文件夹。
3. 检查上传列表：应出现根目录的 `manifest.json`、`README.md`、`LICENSE`、`.gitignore`，以及 `icons/...`、`docs/...`。
4. 填写提交说明，例如 `Initial open-source release`，提交到 `main`。按钮可能显示 **Commit changes**；若界面使用 **Propose changes** 并创建了分支，按页面提示创建并合并 Pull Request。

网页上传支持拖入文件及文件夹。参见 GitHub 的[上传文件说明](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository)。

**别漏掉 `.gitignore` 和 `.github`：** 若文件选择器没有显示点开头文件，打开系统的“显示隐藏项目”后再选。`.github` 内的 Issue 模板也需要上传。若 `.gitignore` 仍上传不了，可在仓库根目录用 **Add file → Create new file**，文件名填 `.gitignore`，粘贴源码包中该文件的内容。文件名不要变成 `.gitignore.txt`。

提交后回到仓库首页确认：直接能看到 `manifest.json` 和 `README.md`，下方自动显示项目介绍。若首页只有一个 `chatgpt-minimap-open-source` 文件夹，说明多上传了一层，应把其内容放回仓库根目录。

现在可以分享仓库地址：把下面链接的 `YOUR_USERNAME` 换成你的 GitHub 用户名：

`https://github.com/YOUR_USERNAME/chatgpt-minimap`

## 4. 可选：发布一个方便下载的 Release

1. 仓库首页打开 **Releases → Draft a new release**。
2. 新建版本标签，使用 `manifest.json` 的版本号并加上 `v` 前缀；例如版本是 `1.2.2`，标签就填 `v1.2.2`。Target 选择 `main`。
3. 标题填写版本号，描述简要写本次功能或修复；可使用 [项目简介中的发布说明](PROJECT_INTRO.md)。初次公开收集兼容性反馈时，可勾选 **This is a pre-release**。
4. 将准备好的 **chatgpt-minimap-open-source-v1.2.2.zip** 拖入附件区（源码无需构建，解压后可直接加载），等待上传完成，再点 **Publish release**；暂不公开可选 **Save draft**。参见 GitHub 的[Release 操作说明](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)。

源码放在仓库里供阅读与修改，Release 附件供用户方便下载安装。上传 GitHub 不会自动上架 Edge 扩展商店；用户仍按 README 解压后以开发者模式加载。

## 5. 备选：使用 Git 上传

仅在**没有用网页上传源码、GitHub 仓库仍为空**时使用这一组首次上传命令。先安装 Git，并准备按 Git 提示登录 GitHub。下面全程指定独立源码目录，不需要进入 Codex 工作目录。

在 PowerShell 中，把 `$sourceFolder` 改成你电脑上解压后的源码目录绝对路径：

```powershell
$sourceFolder = 'C:\请替换为源码所在目录\chatgpt-minimap-open-source'
git -C "$sourceFolder" init -b main
git -C "$sourceFolder" rev-parse --show-toplevel
```

确认输出的是 `chatgpt-minimap-open-source` 这个目录，再执行下列命令。将 `YOUR_USERNAME` 换成你的 GitHub 用户名：

```powershell
git -C "$sourceFolder" add -- manifest.json README.md LICENSE .gitignore content.js conversation-bridge.js conversation-model.js navigation.js panel.css popup.html popup.css popup.js CONTRIBUTING.md CHANGELOG.md .github icons docs
git -C "$sourceFolder" status --short
git -C "$sourceFolder" commit -m "Initial open-source release"
git -C "$sourceFolder" remote add origin https://github.com/YOUR_USERNAME/chatgpt-minimap.git
git -C "$sourceFolder" push -u origin main
```

如果 Git 提示缺少提交者姓名或邮箱，使用你希望公开显示的提交身份完成本地 Git 配置，再重试 `commit`；项目许可证中的 contributors 署名不会替你设置 Git 身份。这一流程可对照 GitHub 的[将本地代码添加到 GitHub](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github)文档。

若已经完成网页上传，可以继续在网页中更新文件；无需再执行这组“首次上传”命令。