# 离线优先的 V50 语料重建计划

## Summary

第二阶段基于已下载快照重建可靠的 V50 / 疯狂星期四语料边界，再完整分析参考文案，最后归纳套路、评分标准和 Kimi prompt。这里的“离线优先”指后续不会再访问外部网页获取参考资料；但 LLM 分析、Kimi 生成测试可以在显式步骤中访问模型 API。

注意：`samples/snapshots/` 保存的是原始网页 HTML / JSON / MHTML 快照，不是已经整理好的文案列表。可直接阅读和评估的文案语料要由第二阶段分割脚本抽取到 `v50_segments.json`，再经过 QA 与分析进入 canonical / rejected。

默认输入使用：

- `samples/latest.json`
- `samples/snapshots/20260520_094418/manifest.json`

## Key Changes

- 网络边界：语料索引、分割、分割 QA 全程只读本地快照；除非重新执行 Plan 1 抓取脚本，否则不得访问网页、搜索引擎或参考文案站点；只有 `analyze` / `test` 阶段在显式配置 Kimi API 时允许联网调用模型。
- 原始资料不可变：`samples/`、snapshot HTML/JSON/MHTML 只读；所有重建产物写入 `references/rebuild/20260520_094418/`。
- 三段离线流水线：
  - `scripts/index_v50_snapshot.py` 读取 manifest，校验本地文件和 SHA256，生成 `raw_documents.json`。
  - `scripts/segment_v50_sources.py` 只做离线分割，输出 `v50_segments.json` 和 `v50_segments.audit.json`。
  - `scripts/check_v50_segments.py` 只读 QA，检查错误拆分、来源噪声、重复、异常短句和回归样例。
- 分割策略以来源结构为准：crazy-thursday collection 按卡片为原子单元，卡片内编号列表不得拆散；vme 优先详情页正文；GitHub JSON 按原始记录；知乎/豆瓣按帖子结构和连续语义块。
- `text-collections/486` 是 blocker 回归：`2025年目标` 那类多行编号文案必须保留为一条完整 segment。
- LLM 分析阶段只消费 QA 通过的 segment，输出 `v50_analysis.json`，再基于分析结果生成：
  - `v50_patterns.md`
  - `v50_quality_rubric.md`
  - `v50_references.canonical.json`
  - `v50_references.rejected.json`
- rubric 必须在完整阅读和分析后形成，不提前硬编码“必须出现 V50 / KFC / 疯狂星期四”；抽象但有效的疯四文案允许进入边界样本。
- Prompt 重建只在语料分析之后进行，更新 `prompts/kimi_v50_prompts.md`，包含生成、自评、低分重写、多样性约束和关键词融合约束。
- 开发测试分离：实现分割/分析的 agent 不做最终 QA；QA subagent 只读验证并报告，不修改代码或 prompt。

## Test Plan

- 离线源索引测试：断网或不调用网络时，能从 `samples/latest.json` 找到所有成功记录；本地文件存在、非空、SHA256 匹配；2 个已知失败 URL 被写入 audit。
- 分割回归测试：`text-collections/486.html` 中编号目标文案不被拆成多条；`488`、`529` 合集页无明显孤儿编号短句。
- 噪声测试：segment 正文不得包含导航、按钮、标签堆、版权、站点页脚、分页 UI。
- 重复测试：同源同正文重复必须合并或标记 duplicate，不直接进入 canonical。
- LLM 分析测试：无显式 `V50` 的抽象样本不能被自动判失败；只有标题、日期、普通短句、广告或站点噪声不能进入 gold。
- Kimi 测试：用常规、抽象、难融合、边界关键词生成多批样本；评估 prompt 打分；低分样本重写；测试 subagent 独立报告失败模式。

## Assumptions

- 当前 snapshot `20260520_094418` 是本轮重建的唯一语料来源。
- `53xt` 不进入本轮参考源。
- `crazy-thursday.com/post/22214` 和 `vme.im/jokes/I_kwDOLrzjj87K7pIM` 保持为已知下载失败项，除非用户要求重新执行 Plan 1。
- Kimi API token 不写入 manifest、语料文件、测试输出或计划文件；脚本只从运行时环境变量读取。
- 本计划只重写第二阶段计划，不执行实际代码修改或语料重建。
