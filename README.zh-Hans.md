<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-Hans.md">简体中文</a> ·
  <a href="README.zh-Hant.md">繁體中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a>
</p>

# Kikoto

本地优先的个人音频媒体库、来源浏览器和播放器。Kikoto 将 DLsite 风格元数据、本地文件夹、可重建缓存以及兼容 Kikoeru 的远程文件来源统一到一个作品模型中，并提供自托管 Web 应用和 Android 客户端。

> [!IMPORTANT]
> Kikoto 仍在积极开发中。升级前请备份 `config/` 和 `data/`，并在将实例暴露到网络前阅读[安全文档](docs/security/index.md)。

## 快速开始

1. 将 [`docker-compose.yml`](docker-compose.yml) 放到空目录。
2. 创建 `.env` 并设置强密码：

```dotenv
KIKOTO_ROOT_PASSWORD=replace-with-a-long-random-password
```

3. 创建 `config`、`cache`、`data` 目录，将支持的作品文件夹放入 `data/`。
4. 启动服务：

```sh
docker compose up -d --pull always
```

打开 <http://127.0.0.1:7655>。生产 Compose 会在宿主机 `7655` 同时提供 Web 应用和 API；`7659` 仅是容器内部后端端口，开发 Compose 才会单独发布它。

普通重启会复用已安装镜像。升级时使用 `--pull always`；需要可复现部署时，请将 `KIKOTO_IMAGE` 固定为经过审核的版本标签或 digest。升级前备份 `config/` 和 `data/`；已有数据库会在启动时迁移，不会从全新安装 baseline 重建。

## 用户文档

[用户指南](docs/user/index.md)涵盖安装、扫描规则、媒体库、远程来源、播放、工作流和设置。[运维文档](docs/operations/configuration.md)涵盖 Docker、配置、数据库、可靠性、故障排查和部署安全。

## 运行时目录

| 主机目录 | 容器目录 | 用途 |
| --- | --- | --- |
| `./config` | `/config` | SQLite 状态和首次来源配置 |
| `./data` | `/data` | 原始媒体、Fetch 媒体和回滚状态 |
| `./cache` | `/cache` | 可重建的封面和媒体缓存 |

这些目录可能含有私有媒体、账户状态、来源地址和凭据，请勿提交到仓库。

## 安全与隐私

生产实例默认要求登录。超级管理员可以有意开启只读的匿名媒体库浏览和播放；个人状态、配置和所有修改仍需认证。漏洞请通过 [SECURITY.md](SECURITY.md) 私下报告，并在分享日志前阅读 [PRIVACY.md](PRIVACY.md)。

## 开发与贡献

开发设置、测试、迁移和发布说明位于[完整文档索引](docs/README.md)。贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [AGENTS.md](AGENTS.md)。

## 许可证

Kikoto 采用 [GNU Affero General Public License v3.0](LICENSE)。
