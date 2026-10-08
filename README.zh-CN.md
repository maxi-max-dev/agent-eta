# Agent ETA

**你的 Agent，还要多久？**

在本机记录有明确边界的 Agent 运行，结合相似历史估计剩余时间。提供命令行、JavaScript 接口和可携带的 Skill，无需账号、API Key 或运行依赖。

这是 **v0.3.0 实验版本**：接入、状态、估计和前瞻评测可用，跨用户的预测准确度尚未建立。它不判断 Agent 的答案或代码是否合格。

## 两分钟跑起来

需要 **Node.js 22.13 或更高版本**，无需 `npm install`。

```sh
git clone https://github.com/maxi-max-dev/agent-eta.git
cd agent-eta
node bin/agent-eta.js --help
node bin/agent-eta.js run --profile wiring-test --class coding -- node -e "setTimeout(() => console.log('done'), 1500)"
```

最后一条仅验证接线。把 `--` 后面的部分替换为真实命令，把 `--profile` 换成稳定的工作流标识。测试和真实工作用不同 profile。命令正常执行，Agent ETA 向 stderr 写状态 JSON，自动上报心跳并保留退出码。它跟踪的是子进程；如果启动器先退出、远端任务还没结束，这个边界就不合适。

也可从固定 GitHub 版本直接运行，需要 npm 和 Git，首次会下载包：

```sh
npm exec --yes --package=github:maxi-max-dev/agent-eta#v0.3.0 -- agent-eta --help
```

当前只发布 GitHub，没有发布到 npm registry。

## 让 Agent 自己接入

把下面这段给有终端能力的 Agent：

> 阅读本仓库 `skills/agent-eta/SKILL.md`，用 Agent ETA 跟踪本次有明确结束边界的任务。用 CLI 的绝对路径，各次调用固定同一个数据库绝对路径。开始、等待、恢复和结束按真实情况上报；历史不足或观测过期时直接说清楚。时间预估不能代替任务验收。

这份 [Skill](skills/agent-eta/SKILL.md) 可按各 Agent 的技能机制载入；不支持 Skill 的 Agent 也可读取它作为说明。**有终端与 Node.js 的 Agent 可走通用接口，不代表每家厂商的原生插件都已实测。** 纯聊天模型需要宿主提供工具。

跨多个工具的任务可这样上报：

```sh
node bin/agent-eta.js start --profile my-agent --class coding
# 将返回 JSON 中的 runId 填入下面的 RUN_ID。
node bin/agent-eta.js ping RUN_ID
node bin/agent-eta.js status RUN_ID
node bin/agent-eta.js pause RUN_ID
node bin/agent-eta.js resume RUN_ID
node bin/agent-eta.js finish RUN_ID --outcome succeeded
```

工作时约每 30 秒上报 `ping`，等人前 `pause`，恢复后 `resume`。失败/取消用 `--outcome failed` / `cancelled`。`watch RUN_ID --interval 5` 持续刷新，`list` 查看近期运行。默认数据库在当前目录 `.agent-eta/runs.sqlite`；跨目录必须每条命令传同一个 `--db /绝对路径/runs.sqlite`，或统一设置 `AGENT_ETA_TRACKER_DB`。

## 为什么一开始可能没有数字

| 情况 | 行为 |
| --- | --- |
| 同 profile/class 的有效成功历史少于 3 次 | `cold_start`，不给编出来的 ETA。 |
| 达到门槛，仍在运行 | 给实验性的剩余活跃分钟 P20/P50/P80，最多用近期 200 次相似记录。 |
| 暂停等人 | 停止倒计时，暂停不计入运行耗时。 |
| 超过 60 秒没有真实上报 | `stale`，撤下数字；该次运行不进入以后训练历史。 |
| 心跳恢复，但之前有观测中断 | `observation_gap`，本次仍不报数字，避免把未知耗时当成可信历史。 |
| 成功、失败或取消 | 明确终态，不再预测。 |

每次读取都会重算，`estimatedAt` 表示重算时间，`observedAt` 表示最后真实上报。刷新不等于 Agent 有进展。长工具调用无法上报时，使用命令包装方式，或接受过期状态，不能伪造心跳。

**3 次只是工程门槛，不代表准确。** 输出标记 `calibrated: false`，P80 不是已验证的 80% 保证。预测剩余活跃时间，未来等人多久并不知道。任务比历史更长时，剩余时间可能增加；长任务低估仍是重点问题。

## 看得见的演示

```sh
npm start
```

打开 **http://127.0.0.1:4318**，首页显示同一数据库中的通用 Agent 运行，每 5 秒刷新。刷新不会代替 Agent 上报心跳。右上角可切换到合成演示和 Codex 观察，默认不开启日志读取。

跨目录时可以指定数据库启动页面：

```sh
node bin/agent-eta.js serve --db /绝对路径/runs.sqlite --port 4318
```

运行命令使用同一个 `--db`。空状态、冷启动、暂停、过期和终态都有明确说明；页面断连会撤下旧估计。

停止演示后运行 `npm run start:live` 可明确开启实验性的本机 Codex 日志观察。此接入依赖日志格式；Claude 解析目前仅用于诊断。通用运行与 Codex 观察现在共用网页入口，各自保留清楚的数据来源。 任务/项目层暂不承诺可靠数字。

JavaScript 接入见 [英文 README](README.md#javascript-sdk)，可运行例子见 [examples/sdk.mjs](examples/sdk.mjs)。

## 留下当时的预测，之后才知道准不准

每次显示的非终态预测或弃权状态，都会存入本机 `eta_forecasts`，包含当时时间、活跃耗时、模型版本，以及只用当时历史计算的简单中位数基线。相同记录去重，之后任务完成也不会改写旧预测。`forecastId` 可用于回查。这是后续真实评测的基础，还不是准确度提升的证明。记录会随使用增长，保留期限和导出功能在计划中。

改名兼容旧的 `agentwhen` 命令、`AgentWhen` 接口、`AGENTWHEN_DB` 环境变量和原数据格式；当前目录如已有 `.agentwhen/runs.sqlite` 会继续使用，显式 `--db` 优先。旧 GitHub 链接重定向，v0.1.0 历史发布保留原名，不删除用户数据。

## 一条命令核对预测

通过 CLI/SDK 积累运行后，对已有数据库执行：

```sh
node bin/agent-eta.js evaluate --db /绝对路径/runs.sqlite
```

输出可复算的 JSON，可自行重定向保存。命令只读数据库，不重新预测，也不修改记录。在每次运行的第 1、5、10 个活跃分钟，分别取之后 30 秒内的第一条预测，每个点每次运行最多一条；先前的弃权不能用后来的数字替换。主模型和当时冻结的中位数基线使用完全相同的成功、持续观测样本，按 profile、任务类别与版本分别报告误差、严重低估、P80 覆盖、区间宽度和按运行重采样的描述性区间。单样本不报置信区间。

失败、取消、缺失预测、冷启动、暂停、观测中断会单独报数，不混入成功时长精度。未结束运行单列为 pending，不能忽略只看已结束运行可能偏向短任务的问题。没有可评分样本会明确写 `no_scorable_pairs`；旧库没有预测记录则写 `missing_journal`，不会事后补造。

统计规则已在实现前冻结，见 [前瞻评测协议](docs/PROSPECTIVE-EVALUATION.md)。报告包含本机运行/profile 元数据，不会自动上传。哈希只能检查记录一致性，不能单独证明真实使用或排除合成数据。**这一版完成评测工具，还没有证明预测更准。** 全量记录导出与磁盘用量仍在后续计划中。

## 数据与验证

通用接口只存生成 ID、profile/class、状态与时间，不存提示词、命令或输出，不上传数据，不调用模型。被包装的命令自身仍可正常联网。源码含合成样例，不含作者真实会话、数据库和私人截图。

```sh
npm test
npm run evaluate
```

`npm run evaluate` 是旧的合成回放；`agent-eta evaluate --db ...` 才是读取通用预测记录的前瞻评测。测试通过说明行为符合检查，不证明真实预测准确度；真实效果需要未来固定版本、固定预测时点、同样本基线比较。贡献见 [CONTRIBUTING.md](CONTRIBUTING.md)，后续见 [ROADMAP.md](ROADMAP.md)。MIT 开源。
