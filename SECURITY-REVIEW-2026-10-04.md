# 仓库安全审查报告 — medusa-paypal

> 审查日期：2026-10-04（扫描执行：2026-10-03 22:46–22:47，本地）
> 工具：Semgrep 1.179.0（uv 安装）／Gitleaks 8.30.1
> 原始输出：`C:\Projects\security-review\raw\medusa-paypal.semgrep.json`、`medusa-paypal.gitleaks.json`
> 运行方式：全程本地；Semgrep `--metrics=off`，代码未上传任何外部服务（仅从 Semgrep Registry 下载规则集）

## 一、项目概览（语言/框架/扫描规则集）

| 项 | 值 |
|---|---|
| 仓库 | `C:\Projects\medusa-paypal`（origin `https://github.com/MengYYY369/medusa-paypal.git`，分支 main；另有 upstream `alphabite-dev/medusa-paypal`） |
| 审查基线 | `dc47b049f8dea8802c0ade295a0dab94836353df`（2026-10-03，"chore(release): 0.9.3"） |
| 拉取情况 | 审查前落后 origin/main 11 个提交，已 `git pull --ff-only` 拉齐；工作区干净 |
| 项目类型 | Medusa v2 PayPal 支付提供商插件（含 vault 绑定能力）；包 `@mengyyy369/medusa-paypal` 0.9.3；yarn 1.22 + TypeScript + jest；无 GitHub Actions 工作流 |
| 扫描规则集 | `p/nodejs` + `p/typescript` + `p/default` |
| Semgrep 扫描量 | 82 个 git 跟踪文件；执行 214 条规则（加载 1075 条）；解析率 ~100%；2 条命中（同一规则、同一行，重复输出） |
| Gitleaks 扫描量 | 62 个提交、1.50 MB；0 条命中 |

**严重度判定标准**：P0 = Semgrep ERROR 级且经核实可实际利用（或 gitleaks 检出真实生产凭证）；P1 = Semgrep WARNING/MEDIUM 级、影响真实构建/发布/运行链路；P2 = Semgrep INFO/低置信、仅测试/脚本/文档代码、经核实为误报。

## 二、高危问题（P0）

**本次扫描未发现 P0 级问题。** Semgrep 无 ERROR 级输出；gitleaks 0 条命中。

## 三、中危问题（P1）

无。

## 四、低危/提示（P2）

| # | 位置 | 规则 | 级别/置信度 | 说明 | 判定与建议 |
|---|---|---|---|---|---|
| 1 | `src/admin/__tests__/translations.spec.ts:26`（重复输出 2 条） | `javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal` | WARNING/LOW | 测试中 `sourceFiles(dir)` 递归扫描翻译字典文件，`path.join` 的输入来自 `__dirname` 与 `readdirSync`，semgrep 无法确认来源 | 误报：测试代码、无外部输入；无需修复 |

## 五、硬编码密钥清单（来自 gitleaks）

**未发现任何泄漏**：gitleaks 扫描 62 个提交、1.50 MB，`no leaks found`。

## 六、误报说明

| 条目 | 判定为误报的理由 |
|---|---|
| `path-join-resolve-traversal` @ `translations.spec.ts:26` | 该测试用 `readdirSync`/`statSync` 遍历仓库内的 `src/` 目录树来校验翻译 key 的使用情况；`path.join` 的 `dir` 来自 `__dirname` 推导的固定目录，不存在用户可控输入，也不在运行时执行。semgrep 的规则基于"未知来源变量"启发式，此处为典型误报。 |

## 七、修复优先级排序与总结

**无待办修复项。**

**总结**：本次审查最干净的一个仓库——Semgrep 2 条输出为同一处测试代码的重复误报，gitleaks 0 条命中，无工作流、无发布脚本风险面。无需改动。
