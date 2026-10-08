# AgentWhen

**你的 Agent，还要多久？**

在本机记录有明确边界的 Agent 运行，结合相似历史估计剩余时间。提供命令行、JavaScript 接口和可携带的 Skill，无需账号、API Key 或运行依赖。

这是 **v0.1.0 实验版本**：接入、状态和估计可用，跨用户的预测准确度尚未建立。它不判断 Agent 的答案或代码是否合格。

## 两分钟跑起来

需要 **Node.js 22.13 或更高版本**，无需 `npm install`。

```sh
git clone https://github.com/maxi-max-dev/agentwhen.git
cd agentwhen
node bin/agentwhen.js --help
node bin/agentwhen.js run --profile wiring-test --class coding -- node -e "setTimeout(() => console.log('done'), 1500)"
```

最后一条仅验证接线。把 `--` 后面的部分替换为真实命令，把 `--profile` 换成稳定的工作流标识。测试和真实工作用不同 profile。命令正常执行，AgentWhen 向 stderr 写状态 JSON，自动上报心跳并保留退出码。它跟踪的是子进程；如果启动器先退出、远端任务还没结束，这个边界就不合适。

也可从固定 GitHub 版本直接运行，需要 npm 和 Git，首次会下载包：

```sh
npm exec --yes --package=github:maxi-max-dev/agentwhen#v0.1.0 -- agentwhen --help
```

当前只发布 GitHub，没有发布到 npm registry。

## 让 Agent 自己接入

把下面这段给有终端能力的 Agent：

> 阅读本仓库 `skills/agentwhen/SKILL.md`，用 AgentWhen 跟踪本次有明确结束边界的任务。用 CLI 的绝对路径，各次调用固定同一个数据库绝对路径。开始、等待、恢复和结束按真实情况上报；历史不足或观测过期时直接说清楚。时间预估不能代替任务验收。

这份 [Skill](skills/agentwhen/SKILL.md) 可按各 Agent 的技能机制载入；不支持 Skill 的 Agent 也可读取它作为说明。**有终端与 Node.js 的 Agent 可走通用接口，不代表每家厂商的原生插件都已实测。** 纯聊天模型需要宿主提供工具。

跨多个工具的任务可这样上报：

```sh
node bin/agentwhen.js start --profile my-agent --class coding
# 将返回 JSON 中的 runId 填入下面的 RUN_ID。
node bin/agentwhen.js ping RUN_ID
node bin/agentwhen.js status RUN_ID
node bin/agentwhen.js pause RUN_ID
node bin/agentwhen.js resume RUN_ID
node bin/agentwhen.js finish RUN_ID --outcome succeeded
```

工作时约每 30 秒上报 `ping`，等人前 `pause`，恢复后 `resume`。失败/取消用 `--outcome failed` / `cancelled`。`watch RUN_ID --interval 5` 持续刷新，`list` 查看近期运行。默认数据库在当前目录 `.agentwhen/runs.sqlite`；跨目录必须每条命令传同一个 `--db /绝对路径/runs.sqlite`，或统一设置 `AGENTWHEN_DB`。

## 为什么一开始可能没有数字

| 情况 | 行为 |
| --- | --- |
| 同 profile/class 的有效成功历史少于 3 次 | `cold_start`，不给编出来的 ETA。 |
| 达到门槛，仍在运行 | 给实验性的剩余活跃分钟 P20/P50/P80，最多用近期 200 次相似记录。 |
| 暂停等人 | 停止倒计时，暂停不计入运行耗时。 |
| 超过 60 秒没有真实上报 | `stale`，撤下数字；该次运行不进入以后训练历史。 |
| 成功、失败或取消 | 明确终态，不再预测。 |

每次读取都会重算，`estimatedAt` 表示重算时间，`observedAt` 表示最后真实上报。刷新不等于 Agent 有进展。长工具调用无法上报时，使用命令包装方式，或接受过期状态，不能伪造心跳。

**3 次只是工程门槛，不代表准确。** 输出标记 `calibrated: false`，P80 不是已验证的 80% 保证。预测剩余活跃时间，未来等人多久并不知道。任务比历史更长时，剩余时间可能增加；长任务低估仍是重点问题。

## 看得见的演示

```sh
npm start
```

打开 **http://127.0.0.1:4318**，默认只回放合成情境，不读取本机 Agent 日志。演示可看计划变化、重试和等待如何影响估计。

停止演示后运行 `npm run start:live` 可明确开启实验性的本机 Codex 日志观察。此接入依赖日志格式；Claude 解析目前仅用于诊断。**原型仪表盘与通用 CLI 数据库独立，首版 CLI 运行不会显示在该仪表盘里。** 任务/项目层暂不承诺可靠数字。

JavaScript 接入见 [英文 README](README.md#javascript-sdk)，可运行例子见 [examples/sdk.mjs](examples/sdk.mjs)。

## 数据与验证

通用接口只存生成 ID、profile/class、状态与时间，不存提示词、命令或输出，不上传数据，不调用模型。被包装的命令自身仍可正常联网。源码含合成样例，不含作者真实会话、数据库和私人截图。

```sh
npm test
npm run evaluate
```

测试通过说明行为符合检查，不证明真实预测准确度；真实效果需要未来固定版本、固定预测时点、同样本基线比较。贡献见 [CONTRIBUTING.md](CONTRIBUTING.md)，后续见 [ROADMAP.md](ROADMAP.md)。MIT 开源。
