# GripRead 协作规范

本文件是仓库根目录的简要入口；产品、设计、架构、工程和路线图细则集中在 [`.ai/`](.ai/README.md)。用户最新指令优先于既有约定，已有改动必须保留并在重叠时先检查再处理。

## 分工

- 主代理负责产品设计、技术规划、代码审查、最终整合和提交。
- 编码与文档落地默认委派 `gpt-5.6-luna`、`max` 推理强度的子代理；独立任务可以并行，但不要让多个代理同时编辑同一文件。若指定模型或推理强度不可用，必须回报主代理，不得静默更换模型或参数。
- 子代理完成后交回主代理审查，不得未经审查自行提交代码。

## 变更与验证

- 先读取相关文档和现有实现，再做小范围、可审查的修改；不要默认使用破坏性 Git 操作。
- 测试规模与改动风险匹配，不编写只复述实现的测试；交付前检查变更、链接和格式，对应用代码运行相称验证，未运行的检查必须如实记录。
- 文档以中文为主，设计决策进入 `.ai/` 对应分类；状态只记录实际完成或验证过的事项。

## Git 约定

- 初始化默认分支为 `main`；功能分支默认使用 `codex/` 前缀。
- 提交信息使用 Conventional Commits：`<type>[optional scope][!]: <description>`。常用类型为 `feat`、`fix`、`docs`、`refactor`、`test`、`chore`、`build`、`ci`、`perf`、`revert`；破坏性变更在 type 或可选 scope 后加 `!`，或在提交尾注使用 `BREAKING CHANGE:`。示例：`feat(reader)!: change reader locator format`。
- 不强加用户未要求的审批流程、提交钩子、联网 CI 或自动发布。

## 工作入口

开始任务先读取 [当前状态](.ai/status.md) 和 [工程流程](.ai/engineering/workflow.md)，再按任务读取 [产品](.ai/product/requirements.md)、[设计](.ai/design/interaction.md)、[架构](.ai/architecture/overview.md)、[内容源兼容](.ai/architecture/source-compatibility.md) 或 [测试策略](.ai/engineering/testing.md) 等分类文档。
