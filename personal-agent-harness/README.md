# Personal Agent Harness

一个基于 `@earendil-works/pi-agent-core` 的通用 Agent Harness，提供可控执行、权限治理、可观测性和离线评测能力。

项目边界：

- pi 负责模型适配、流式调用、Agent Loop、工具协议和持久化 Session Tree。
- 本项目负责 Run 控制、权限策略、Hooks、Trace、预算限制、环境诊断和 Eval 回归。

## 核心能力

- SDK 和非交互式 CLI
- 基于 pi SQLite 后端的持久化 Session
- `read`、`write`、`edit`、`exec` 编码工具
- 路径规范化和符号链接越界防护
- `allow`、`ask`、`deny` 权限规则
- 类型化 Hooks 和只读 Events
- Run、Turn、模型请求、工具调用和 Hook Span
- 默认 metadata-only Trace
- command、file、trace grader
- 隔离 Eval、命名 Baseline 和回归对比
- SWE-bench Lite Case 加载、仓库缓存和标准 Patch 导出
- 环境代理自动适配和 `harness doctor` 自检

MVP 暂不包含 TUI、Web Dashboard、Gateway、MCP、多智能体、长期记忆、Codex OAuth 和 LLM Judge。

## 安装与验证

需要 Node.js 22.19 或更高版本。

```bash
npm install --ignore-scripts
npm run check
npm test
npm run demo
npm run build
```

`npm run demo` 使用 faux provider，不需要 API Key。

SWE-bench 数据桥接额外需要 Python 3.10 或更高版本：

```bash
python3 -m venv .venv-swebench
source .venv-swebench/bin/activate
pip install -r python/requirements.txt
npm run test:python
```

官方 Docker grader 使用独立环境，避免与 PyArrow Bridge 的依赖互相影响：

```bash
python3 -m venv .venv-swebench-grader
source .venv-swebench-grader/bin/activate
pip install -r python/grader-requirements.txt
```

## DeepSeek 配置

复制示例配置：

```bash
cp harness.config.example.json harness.config.json
```

API Key 只放环境变量，不写入 JSON：

```bash
export DEEPSEEK_API_KEY="你的 API Key"
```

默认配置：

```json
{
  "provider": "deepseek",
  "model": "deepseek-v4-pro",
  "dataDir": ".harness",
	"network": {
    "proxy": "auto",
    "connectTimeoutMs": 15000
	},
	"swebench": {
		"pythonExecutable": ".venv-swebench/bin/python",
		"graderPythonExecutable": ".venv-swebench-grader/bin/python"
	}
}
```

`proxy: "auto"` 会在检测到 `HTTP_PROXY` 或 `HTTPS_PROXY` 时自动启用环境代理，并遵循 `NO_PROXY`。也可以显式设置为 `env` 或 `direct`。

配置优先级：CLI 参数 > `HARNESS_PROVIDER/HARNESS_MODEL` 环境变量 > JSON。

## 环境诊断

正式运行前执行：

```bash
harness doctor
```

Doctor 检查：

- Node.js 版本
- 配置结构和模型 ID
- 凭证是否存在，但不输出凭证内容
- 环境代理和模型服务连通性
- Trace 与 Session SQLite 数据库

机器可读输出：

```bash
harness doctor --format json > doctor.json
```

## 执行与 Session

```bash
harness run "阅读 README.md 并总结项目架构"
harness session list
harness session continue <session-id> "继续分析权限系统"
```

每次 Run 完成后会输出 Run ID、Session ID、耗时、Token、成本和可直接复制的 Trace 命令。

## Trace 查询

```bash
harness trace list
harness trace list --limit 10 --status failed
harness trace show latest
harness trace show <run-id>
```

默认显示中文摘要和 Span 树。完整 JSON：

```bash
harness trace show latest --format json > /tmp/trace.json
less /tmp/trace.json
```

不依赖 `jq`。如果下游管道提前关闭，CLI 会将 `EPIPE` 视为正常退出。

## Eval

项目包含一个可直接运行的 Smoke Suite：

```bash
harness eval run evals/smoke.json \
  --config harness.eval.config.json \
  --results-dir eval-results
```

查询结果：

```bash
harness eval list --results-dir eval-results
harness eval show latest --results-dir eval-results
harness eval show latest --results-dir eval-results --format json > /tmp/eval.json
```

报告同时保存在：

```text
eval-results/<eval-id>/report.json
eval-results/<eval-id>/<case-id>/result.json
eval-results/<eval-id>/<case-id>/workspace-changes.json
eval-results/eval.sqlite
```

## Baseline 回归

保存命名 Baseline：

```bash
harness eval baseline save latest \
  --name deepseek-v4-pro \
  --results-dir eval-results
```

查看 Baseline：

```bash
harness eval baseline list --results-dir eval-results
```

将最新结果与 Baseline 对比：

```bash
harness eval compare baseline:deepseek-v4-pro latest \
  --results-dir eval-results
```

Compare 输出成功率、平均成本、P95 延迟和逐 Case 回归；出现回归时返回非零退出码。仍可直接传入历史 `report.json` 路径。

## Eval Suite 格式

```json
{
  "name": "coding-smoke",
  "cases": [
    {
      "id": "create-config",
      "input": "创建 config.json，并设置 enabled=true",
      "fixture": "./fixtures/create-config",
      "timeoutMs": 30000,
      "tags": ["files", "smoke"],
      "graders": [
        { "type": "file", "path": "config.json", "contains": "enabled" },
        { "type": "command", "command": "node -e \"JSON.parse(require('fs').readFileSync('config.json'))\"" },
        { "type": "trace", "toolCalled": "write", "maxTurns": 4, "maxTokens": 12000 }
      ]
    }
  ]
}
```

每个 Case 在独立临时目录中运行。测试失败、超时、安全违规和越界访问属于硬失败，不能被其他评分抵消。

## SWE-bench Lite

SWE-bench 使用 TypeScript 完成 Eval 编排、Git 仓库缓存、Agent 推理、Trace 和 Patch 导出；Python Bridge 只通过 PyArrow 读取本地 Parquet。数据集、仓库缓存和结果均位于 `eval-results/`，不会提交到 Git。

下载 Lite 数据集：

```bash
mkdir -p eval-results/cache/swebench-lite/dataset

curl -fL \
  -o eval-results/cache/swebench-lite/dataset/dev.parquet \
  https://huggingface.co/datasets/SWE-bench/SWE-bench_Lite/resolve/main/data/dev-00000-of-00001.parquet

curl -fL \
  -o eval-results/cache/swebench-lite/dataset/test.parquet \
  https://huggingface.co/datasets/SWE-bench/SWE-bench_Lite/resolve/main/data/test-00000-of-00001.parquet
```

诊断 Python、PyArrow、Parquet、Git、缓存目录和 Docker：

```bash
harness eval swebench doctor evals/swebench-lite-dev.json \
  --config harness.eval.config.json
```

运行 Suite 或其中一个声明过的实例：

```bash
harness eval run evals/swebench-lite-dev.json \
  --config harness.eval.config.json \
  --results-dir eval-results

harness eval run evals/swebench-lite-dev.json \
  --instance-id sqlfluff__sqlfluff-1625 \
  --config harness.eval.config.json \
  --results-dir eval-results
```

输出结构：

```text
eval-results/<eval-id>/
├── report.json
├── predictions.jsonl
└── <instance-id>/
    ├── prediction.json
    ├── model.patch
    ├── result.json
    └── data/harness.sqlite
```

Patch 生成成功后，先确保 Docker Desktop 已启动，并在 `Settings → Resources → WSL Integration` 中启用当前 WSL 发行版：

如果生成端不运行 Docker，可以导出独立评分包并发送到评分服务器：

```bash
harness eval export latest \
  --results-dir eval-results \
  --output eval-results/grading-bundles/sqlfluff-1625.tar.gz

tar -tzf eval-results/grading-bundles/sqlfluff-1625.tar.gz
```

评分包包含 `manifest.json`、`predictions.jsonl`、生成时的 `report.json` 和 `patches/*.patch`。`manifest.json` 使用 dataset checksum、split、实例集合、repo/base commit 和每个 Patch 的 SHA-256 生成确定性 `bundleId`，不包含 API Key、Prompt、Completion、仓库源码或 SQLite 数据库。

服务器评分完成后返回以下稳定 JSON：

```json
{
  "schemaVersion": 1,
  "kind": "swebench-grading-result",
  "bundleId": "<manifest 中的 bundleId>",
  "evalId": "<eval-id>",
  "graderVersion": "4.1.0",
  "gradeId": "server-grade-001",
  "startedAt": 1700000000000,
  "endedAt": 1700000010000,
  "artifactsDir": "s3://bucket/swebench/server-grade-001",
  "cases": [
    {
      "instanceId": "sqlfluff__sqlfluff-1625",
      "status": "resolved",
      "reportPath": "server-grade-001/sqlfluff__sqlfluff-1625/report.json",
      "testOutputPath": "server-grade-001/sqlfluff__sqlfluff-1625/test_output.txt"
    }
  ]
}
```

将结果导回生成端：

```bash
harness eval import grading-result.json --results-dir eval-results
harness eval show <eval-id> --results-dir eval-results
```

导入时会重新计算本地 Patch 的 `bundleId`，严格校验 Eval ID、实例集合和 Patch checksum，随后原子更新 `report.json`、逐 Case `result.json` 与 `eval.sqlite`。已评分报告不能重复导入。

如果在本机直接评分，再确保 Docker Desktop 已启动，并在 `Settings → Resources → WSL Integration` 中启用当前 WSL 发行版：

```bash
docker info
```

执行官方评分：

```bash
harness eval swebench grade latest \
  --config harness.eval.config.json \
  --results-dir eval-results \
  --max-workers 1 \
	--namespace none \
  --timeout 1800

harness eval show latest --results-dir eval-results
```

`dev` split 默认使用 `--namespace none` 在本地构建镜像，因为部分 dev Case 没有可拉取的 `swebench/*` 预构建镜像；`test` split 默认使用 `swebench`。可显式传入 `--namespace swebench` 使用远程镜像。首次本地构建可能占用较多 Docker 磁盘空间。

评分产物保存在 `eval-results/<eval-id>/official-grading/<grade-id>/`。评分完成后，报告同时保留 Patch 生成率并新增官方解决率、resolved/unresolved/error 数量，以及每个 Case 的 `report.json` 和 `test_output.txt` 路径。`unresolved` 是有效评分结果，不会让 CLI 返回失败；Docker、镜像或 evaluator 基础设施失败才返回非零状态。

本机内存低于官方建议的 16 GiB，因此默认只允许 `--max-workers 1`。`harness eval swebench doctor` 会检查 grader Python、`swebench==4.1.0`、Docker daemon、CPU 架构、WSL 工作区磁盘和内存；这些检查不会读取或输出凭证。WSL 工作区可用空间不等于 Docker Desktop 磁盘镜像所在 Windows 分区的可用空间，评分前还需要在 Docker Desktop 中确认磁盘镜像位置和容量。

为避免外部 Issue 或仓库代码通过 Shell 影响宿主机，SWE-bench 模式只向模型注册 `read/list/search/write/edit`，不注册 `exec`，并拒绝工作区外访问。`read` 默认最多返回 300 行/40KB，`search` 同时支持目录和单文件路径，避免大文件与无效工具调用快速膨胀上下文。仓库根据 `repo + baseCommit` 按需缓存，不初始化 submodule，也不安装项目依赖。

SWE-bench Baseline 只能比较相同 Parquet checksum、split 和实例集合：

```bash
harness eval baseline save latest --name swebench-lite-dev --results-dir eval-results
harness eval compare baseline:swebench-lite-dev latest --results-dir eval-results
```

## SDK

```typescript
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createNetworkRuntime, NodeHarness } from "personal-agent-harness/node";

const models = builtinModels();
const model = models.getModel("deepseek", "deepseek-v4-pro");
if (!model) throw new Error("Model not found");

const network = createNetworkRuntime(models, { proxy: "auto" });
const harness = await NodeHarness.create({
  dataDir: ".harness",
  cwd: process.cwd(),
  model,
  streamFn: network.streamFn,
});

try {
  const session = await harness.createSession();
  session.subscribe((event) => console.log(event.type, event.sequence));
  const result = await session.run("检查当前仓库");
  console.log(result.runId, result.status);
} finally {
  await harness.close();
  await network.close();
}
```

## 数据安全

默认 `metadata-only` Trace 不记录 Prompt、Completion、文件内容、命令输出、环境变量或完整工具参数。

采集内容必须显式配置调用方提供的 Redactor：

```typescript
capture: {
  mode: "redacted",
  redactor: (value) => value.replaceAll(/sk-[A-Za-z0-9]+/g, "[secret]"),
}
```

Doctor 和中文 Renderer 不输出 API Key 或代理 URL。

## 项目结构

```text
src/
├── runtime.ts          # pi Agent Runtime Adapter
├── permission.ts       # 权限规则与审批
├── hooks.ts            # 类型化 Hooks
├── trace-recorder.ts   # Span 与事件采集
├── eval.ts             # Eval Runner 与 Grader
├── swebench.ts         # SWE-bench Bridge、Git 缓存和 Patch Runner
├── swebench-grader.ts  # 官方 Docker evaluator 适配与结果解析
├── cli-app.ts          # 可测试 CLI 路由
└── node/
    ├── config.ts       # 严格配置解析
    ├── network.ts      # 环境代理和 StreamFn
    ├── doctor.ts       # 环境自检
    ├── render.ts       # 中文/JSON 展示
    ├── harness.ts      # Node Harness
    └── trace-store.ts  # Trace、Eval 与 Baseline SQLite
```

`python/swebench_bridge.py` 只负责本地 Parquet 的 schema 检查和 Case 白名单字段输出，不克隆仓库、不调用模型、不写 SQLite。

## 后续方向

1. 交互式权限审批与 TUI Trace Viewer。
2. Codex OAuth CredentialStore 适配。
3. 容器内安全 `exec` 与更大规模 SWE-bench 并发评分。
4. 更多真实 Coding Fixtures 和版本化基准集。
5. OpenTelemetry、Skill、Plugin、MCP 与多 Agent 扩展。
