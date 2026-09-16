# GripRead `.ai` 文档

这里保存产品设计、交互约束、技术架构、工程协作和实施计划。根目录 [README](../README.md) 只保留项目入口，根目录 [AGENTS.md](../AGENTS.md) 只保留协作摘要；本目录文档承载可持续维护的细则。

## 文档索引

- [产品需求](product/requirements.md)：首发范围、核心场景、功能边界和验收目标。
- [交互与视觉](design/interaction.md)：暖白纸感、导航、书架、小说阅读和 RSS 阅读交互。
- [系统架构](architecture/overview.md)：Tauri、前端、Rust、SQLite、文件和内容引擎的边界。
- [同步与数据](architecture/sync.md)：WebDAV、离线队列、定位、冲突和备份约束。
- [内容源兼容](architecture/source-compatibility.md)：阅读文本书源、QuickJS-NG/rquickjs 和兼容边界。
- [工程流程](engineering/workflow.md)：代理分工、分支、提交、变更和交付记录要求。
- [验证策略](engineering/testing.md)：基础验证、跨端验证和与改动规模匹配的测试要求。
- [路线图](plans/roadmap.md)：从基础验证到本地阅读、网络内容和 WebDAV 跨端闭环的里程碑。
- [初始设计快照](plans/2026-09-16-initial-design.md)：上一轮确认的完整 `proposed_plan` 原文，保留为历史基线。
- [当前状态](status.md)：当前仓库已经实际完成的文档和验证记录。

## 使用约定

分类文档是后续维护的入口，快照用于追溯 2026-09-16 的已确认设计。新增或修改决策时，先更新相应分类文档，再在 [状态记录](status.md) 中记下已经完成的工作；不要把未验证的实现、命令或测试结果写成事实。文档之间使用相对链接，链接目标不存在时应在交付前补齐或修正。
