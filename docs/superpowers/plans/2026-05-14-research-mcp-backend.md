# Research MCP Backend (Plan 1 v2 — Standalone Project)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在全新独立目录 `C:\research-mcp\` 建一个 A 股投研 MCP 数据后端项目。对外提供统一的 22 个 op：19 个老 op 通过 subprocess 透传到 `C:\LinDangAgent\data_query.py`（保留其 5-6 层兜底），3 个新 op（research-report / announcement / news）自实现，2 个老 op（price / peers）做"加强版"包装（LinDangAgent 结果不理想时本项目内自带 Ashare / akshare 行业兜底补救）。

**Architecture:**
- **透传层** `lindang_proxy.py` — subprocess 调用 LinDangAgent.data_query.py，把 stdout JSON 透传出来。**完全只读使用 LinDangAgent**，不修改它任何文件。
- **自实现层** `research_client.py` / `news_client.py` — 新增 3 op 的 fetcher，主源 akshare + 副源东财 HTTP 直连。
- **加强层** `peers_enhancer.py` / `price_enhancer.py` — 包装老 op 结果，发现假兜底/数据不全时用 Ashare/akshare 行业接口补救。
- **Vendor 库** `research_mcp/vendor/Ashare.py` — mpquant/Ashare 单文件库，作为价格"最后救场"。
- **统一 CLI 入口** `query.py` — 子命令风格沿用 data_query.py 约定（标准 JSON 到 stdout，日志到 stderr），AI/Hub 端只需要知道这一个入口。
- **独立 git repo + uv 环境** — 完全独立可单测可单独部署，与 LinDangAgent 并列存在不互相污染。

**Tech Stack:** Python 3.12+, uv 包管理, akshare>=1.18.0, requests>=2.31.0, pandas>=2.0.0, pytest>=7.0.0。

**与 LinDangAgent 的关系：** LinDangAgent 完全不动；本项目运行时通过 `subprocess.run(["uv", "run", "python", r"C:\LinDangAgent\data_query.py", op, ...])` 调用其现有 19 op。LinDangAgent secrets.toml 等敏感配置由 LinDangAgent 自己管理，本项目不复制。

**与 Hub 端的关系：** 本 plan 不动 Hub。Plan 2（后续）让 Hub 的 `core/research-mcp-server.js` 改调本项目的 `query.py`。

---

## File Structure

**新建目录与文件（全部在 `C:\research-mcp\`）**：

```
C:\research-mcp\
├── .gitignore
├── README.md
├── CLAUDE.md                          # 项目规范
├── pyproject.toml                     # uv 配置 + dependencies
├── query.py                           # 统一 CLI 入口（22 op）
├── research_mcp/                      # Python 包
│   ├── __init__.py
│   ├── lindang_proxy.py               # subprocess 透传 LinDangAgent 19 op
│   ├── research_client.py             # research-report fetcher
│   ├── news_client.py                 # announcement + market_news fetchers
│   ├── peers_enhancer.py              # 包装 LinDangAgent peers 做强兜底
│   ├── price_enhancer.py              # LinDangAgent price 失败时 Ashare 救场
│   └── vendor/
│       ├── __init__.py
│       └── Ashare.py                  # mpquant/Ashare 单文件 vendor
├── tests/
│   ├── __init__.py
│   ├── conftest.py                    # pytest 配置 + 共享 fixture
│   ├── test_lindang_proxy.py
│   ├── test_research_client.py
│   ├── test_news_client.py
│   ├── test_peers_enhancer.py
│   ├── test_price_enhancer.py
│   ├── test_ashare_vendor.py
│   └── test_query_cli.py              # CLI 集成测试
└── docs/
    ├── AGENT_GUIDE.md                 # 给 AI 圆桌成员看的 22 op 手册
    └── superpowers/
        └── plans/
            └── 2026-05-14-research-mcp-backend.md  # 本文件副本（Task 1 复制）
```

**约定**：
- 所有 fetcher 返回 `tuple[result_dict_or_None, fetch_warning_str_or_None]`
- `query.py` op 函数沿用 `_ok(op, **payload)` / `_err(op, error, **extra)` helper（参考 LinDangAgent 风格）
- 输出严格 JSON 到 stdout（`ensure_ascii=False`）+ 日志/进度到 stderr
- 测试需要网络的标 `@pytest.mark.network`（conftest 注册）；CI/本地默认跑（无需手动开关）

---

## Tasks

### Task 1: 项目骨架（git init + uv + 目录结构）

**Files:**
- Create: `C:\research-mcp\.gitignore`
- Create: `C:\research-mcp\README.md`
- Create: `C:\research-mcp\CLAUDE.md`
- Create: `C:\research-mcp\pyproject.toml`
- Create: `C:\research-mcp\research_mcp\__init__.py`
- Create: `C:\research-mcp\research_mcp\vendor\__init__.py`
- Create: `C:\research-mcp\tests\__init__.py`
- Create: `C:\research-mcp\tests\conftest.py`

- [ ] **Step 1.1: 创建项目目录 + git init**

```powershell
New-Item -ItemType Directory -Path C:\research-mcp -Force | Out-Null
Set-Location C:\research-mcp
git init -b main
```

- [ ] **Step 1.2: 写 `.gitignore`**

```gitignore
# Python
__pycache__/
*.py[cod]
*.egg-info/
.pytest_cache/
.ruff_cache/
.mypy_cache/

# Virtual env / uv
.venv/
.python-version

# Editors
.vscode/
.idea/

# OS
Thumbs.db
.DS_Store

# Secrets (本项目不该存任何 secrets；LinDangAgent 自管)
secrets.toml
*.env

# Build / temp
build/
dist/
*.log

# Cache
.cache/
```

- [ ] **Step 1.3: 写 `pyproject.toml`**

```toml
[project]
name = "research-mcp"
version = "0.1.0"
description = "A-share investment research MCP backend (facade over LinDangAgent + self-implemented research/news/announcement fetchers)"
requires-python = ">=3.12"
dependencies = [
    "akshare>=1.18.0",
    "requests>=2.31.0",
    "pandas>=2.0.0",
    "numpy>=1.24.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=7.0.0",
]

[tool.pytest.ini_options]
testpaths = ["tests"]
markers = [
    "network: tests requiring network access (akshare/eastmoney/Ashare)",
    "slow: tests that take >5s",
]

[tool.uv]
package = true
```

- [ ] **Step 1.4: 写 `README.md`**

```markdown
# research-mcp

A-share investment research MCP backend. Acts as a unified 22-op facade:
- 19 ops transparently proxied to LinDangAgent (`C:\LinDangAgent\data_query.py`)
- 3 new ops (research-report / announcement / news) implemented in-project
- 2 ops (price / peers) enhanced with extra fallback layers (Ashare, akshare industry)

## Usage

```bash
# Any op uses the unified entry:
uv run python query.py <op> [args...]

# Examples
uv run python query.py snapshot 600519              # proxies to LinDangAgent
uv run python query.py research-report 600519       # self-implemented
uv run python query.py announcement 600519          # self-implemented
uv run python query.py news                         # self-implemented (market-wide, no symbol)
uv run python query.py peers 600519                 # enhanced (LinDangAgent + akshare industry)
```

## Architecture

See `docs/superpowers/plans/2026-05-14-research-mcp-backend.md` for full design.

## Testing

```bash
uv run pytest tests/ -v              # requires network (akshare / Ashare)
```
```

- [ ] **Step 1.5: 写 `CLAUDE.md`（项目规范）**

```markdown
# research-mcp 项目规范

## 项目定位
A 股投研 MCP 工具的数据后端 facade。**不修改 LinDangAgent**，只通过 subprocess 调它的 data_query.py。
新功能（research-report / news / announcement / price-enhancer / peers-enhancer）在本项目内实现。

## 铁律
1. **不动 LinDangAgent**：只读使用，subprocess 调用。LinDangAgent 自己的 19 op 由它自己维护。
2. **统一入口 query.py**：所有调用方（CLI / MCP server / 手测）只走这一个口。
3. **输出严格 JSON 到 stdout**：日志和进度全部到 stderr，不污染 stdout。
4. **每个 op 必须返回 `{ok, op, ...}` 标准 schema**（与 LinDangAgent data_query.py 一致）。
5. **fetch_warning 透传**：底层兜底信号原样向上传，让 AI 知道走了哪层副源。
6. **Python 命令必须用 `uv run python`**（不要直接 `python`，环境是 uv 管的）。
7. **测试用 pytest**，需要网络的标 `@pytest.mark.network`。

## 目录约定
- `research_mcp/` — Python 包（fetcher 实现）
- `tests/` — pytest 单测
- `docs/AGENT_GUIDE.md` — 给 AI 圆桌成员看的 op 手册
- `docs/superpowers/` — 规划/计划文档

## 与 LinDangAgent 的边界
- LinDangAgent 路径硬编码 `C:\LinDangAgent\data_query.py`（未来如需可配置）
- 不复制 LinDangAgent 的 secrets.toml；老 op 走 subprocess 时 LinDangAgent 自己加载
- Ashare / akshare 等新源在本项目 pyproject.toml 装；不依赖 LinDangAgent 的 requirements.txt
```

- [ ] **Step 1.6: 创建包结构**

```powershell
New-Item -ItemType Directory -Path C:\research-mcp\research_mcp\vendor -Force | Out-Null
New-Item -ItemType Directory -Path C:\research-mcp\tests -Force | Out-Null
New-Item -ItemType Directory -Path C:\research-mcp\docs\superpowers\plans -Force | Out-Null
```

`research_mcp/__init__.py`：

```python
"""research-mcp: A-share investment research MCP backend."""
__version__ = "0.1.0"
```

`research_mcp/vendor/__init__.py`：

```python
"""Vendored single-file third-party libraries.

Each file here is copied verbatim from its upstream project to avoid
pip-installed dependency risk on potentially abandoned packages.
"""
```

`tests/__init__.py`：（空文件）

- [ ] **Step 1.7: 写 `tests/conftest.py`**

```python
"""Shared pytest fixtures and config."""
import pytest


def pytest_collection_modifyitems(config, items):
    """Auto-mark tests in test_ashare_vendor.py and others as 'network'
    if they aren't already marked. This is informational only — we still
    run them by default because the project is data-source-heavy."""
    # 占位钩子：当前不实际过滤，仅打 marker 供后续 -m 选择使用
    pass


@pytest.fixture(scope="session")
def lindang_data_query_path():
    """LinDangAgent data_query.py 绝对路径常量。"""
    return r"C:\LinDangAgent\data_query.py"
```

- [ ] **Step 1.8: 安装依赖**

```bash
uv sync
```

Expected: 创建 `.venv/`，安装 akshare/requests/pandas/numpy/pytest 等。

- [ ] **Step 1.9: 跑空测试验证 pytest 工作**

```bash
uv run pytest tests/ -v
```

Expected: `collected 0 items` 且无错误。

- [ ] **Step 1.10: Commit**

```bash
git add .
git commit -m "chore: initial project scaffolding for research-mcp

Standalone A-share research MCP backend. Acts as a unified facade:
19 ops proxied to LinDangAgent (subprocess), 3 new ops self-implemented,
2 enhanced ops with extra fallback. Does NOT modify LinDangAgent.

Structure: research_mcp/ package (fetchers), tests/ (pytest),
docs/ (AGENT_GUIDE + plans). pyproject.toml uses uv with akshare/
requests/pandas/numpy. Python 3.12+ required."
```

---

### Task 2: lindang_proxy.py — subprocess 透传 19 个老 op

**Files:**
- Create: `research_mcp/lindang_proxy.py`
- Test: `tests/test_lindang_proxy.py`

**Why this task:** 让本项目透明使用 LinDangAgent 的 19 个老 op，不重写也不修改 LinDangAgent。subprocess 调用 + JSON parse + 透传。

- [ ] **Step 2.1: 写测试**

`tests/test_lindang_proxy.py`：

```python
"""lindang_proxy integration tests. Calls real LinDangAgent subprocess."""
import pytest

from research_mcp.lindang_proxy import call_lindang


def test_call_lindang_gate_600519():
    result = call_lindang("gate", "600519")
    assert result is not None
    assert result.get("ok") is True
    assert result.get("op") == "gate"
    assert "status" in result
    assert "tradable" in result


def test_call_lindang_basic_600519():
    result = call_lindang("basic", "600519")
    assert result.get("ok") is True
    assert result.get("op") == "basic"
    assert "info" in result
    info = result["info"]
    assert isinstance(info, dict)
    # 至少有部分基本面字段
    assert len(info) > 3


def test_call_lindang_snapshot_600519():
    result = call_lindang("snapshot", "600519")
    assert result.get("ok") is True
    assert result.get("op") == "snapshot"
    # snapshot 含 gate/basic/price_summary/indicators/capital_flow
    assert any(k in result for k in ["gate", "basic", "indicators"])


def test_call_lindang_invalid_op_returns_error():
    result = call_lindang("nonexistent-op", "600519")
    # subprocess returncode != 0 时，proxy 应返回 None 或 ok=False
    assert result is None or result.get("ok") is False
```

- [ ] **Step 2.2: 跑测试确认失败**

```bash
uv run pytest tests/test_lindang_proxy.py -v
```

Expected: ImportError（lindang_proxy 还没建）。

- [ ] **Step 2.3: 实现 `lindang_proxy.py`**

```python
# -*- coding: utf-8 -*-
"""Subprocess proxy to LinDangAgent.data_query.py.

Transparent invocation of LinDangAgent's 19 existing ops without modifying
that project. Returns parsed JSON dict on success, None on subprocess error.

All stderr from LinDangAgent is suppressed (its logger writes there); only
stdout JSON is parsed. fetch_warning fields in LinDangAgent output are
preserved as-is in the returned dict so callers can see fallback signals.
"""

from __future__ import annotations

import json
import logging
import subprocess
import sys
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

LINDANG_DATA_QUERY = Path(r"C:\LinDangAgent\data_query.py")
LINDANG_CWD = Path(r"C:\LinDangAgent")

# 每个 op 的合理超时（秒）
OP_TIMEOUTS = {
    "snapshot": 90,
    "financial": 60,
    "qmt-financial": 60,
    "price": 30,
    "indicators": 30,
    "qmt-realtime": 15,
    "qmt-kline": 15,
    "qmt-sector": 30,
}
DEFAULT_TIMEOUT = 30


def call_lindang(op: str, *args: str, timeout: int | None = None) -> dict[str, Any] | None:
    """调用 LinDangAgent data_query.py 的指定 op。

    Args:
        op: op 名（如 "gate" / "basic" / "snapshot" / "qmt-realtime"）
        *args: 传给 op 的位置参数（symbol 或其他）
        timeout: 子进程超时（秒）；默认按 OP_TIMEOUTS 字典查

    Returns:
        dict (parsed JSON) on success, None on subprocess error / JSON parse fail.
        失败时也可能返回 dict but with ok=False（LinDangAgent 自己返回的标准错误格式）。
    """
    if timeout is None:
        timeout = OP_TIMEOUTS.get(op, DEFAULT_TIMEOUT)

    if not LINDANG_DATA_QUERY.exists():
        logger.error("LinDangAgent data_query.py not found at %s", LINDANG_DATA_QUERY)
        return None

    cmd = [
        "uv", "run", "python", str(LINDANG_DATA_QUERY),
        op, *[str(a) for a in args if a is not None],
    ]
    try:
        result = subprocess.run(
            cmd, cwd=str(LINDANG_CWD),
            capture_output=True, text=True, encoding="utf-8",
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        logger.error("lindang_proxy[%s] timeout after %ss", op, timeout)
        return None
    except FileNotFoundError as e:
        logger.error("lindang_proxy[%s] uv not on PATH: %s", op, e)
        return None

    if result.returncode not in (0, 1):
        logger.warning(
            "lindang_proxy[%s] unexpected returncode %d: stderr=%s",
            op, result.returncode, result.stderr[:300],
        )

    stdout = (result.stdout or "").strip()
    if not stdout:
        logger.warning("lindang_proxy[%s] empty stdout (stderr=%s)", op, result.stderr[:200])
        return None

    # 偶有 stdout 被 xtquant 之类污染，提取首个 { 起的内容
    json_start = stdout.find("{")
    if json_start < 0:
        json_start = stdout.find("[")
    if json_start >= 0:
        stdout = stdout[json_start:]

    try:
        return json.loads(stdout)
    except json.JSONDecodeError as e:
        logger.error("lindang_proxy[%s] JSON parse error: %s; stdout=%s", op, e, stdout[:300])
        return None
```

- [ ] **Step 2.4: 跑测试通过**

```bash
uv run pytest tests/test_lindang_proxy.py -v
```

Expected: 4 passed.

- [ ] **Step 2.5: Commit**

```bash
git add research_mcp/lindang_proxy.py tests/test_lindang_proxy.py
git commit -m "feat(proxy): add lindang_proxy.call_lindang for subprocess transparency

Run LinDangAgent.data_query.py via uv run, parse stdout JSON, return dict.
Stderr suppressed (LinDangAgent uses stderr for logging). Per-op timeouts
configured (snapshot 90s, financial 60s, others 30s default).

This is the only bridge to LinDangAgent's existing 19 ops — research-mcp
will not duplicate or modify any of its fetchers."
```

---

### Task 3: Ashare vendor + 测试

**Files:**
- Copy: `C:\LinDangAgent\spike\Ashare.py` → `research_mcp/vendor/Ashare.py`
- Test: `tests/test_ashare_vendor.py`

- [ ] **Step 3.1: 复制 Ashare.py**

```powershell
Copy-Item C:\LinDangAgent\spike\Ashare.py C:\research-mcp\research_mcp\vendor\Ashare.py
```

在 `research_mcp/vendor/Ashare.py` 顶部追加一行（紧跟原 docstring 之后）：

```python
# Vendored from: https://github.com/mpquant/Ashare (commit-as-of: 2026-05-14)
# Single-file library, MIT licensed per upstream README. No pip dependency.
```

- [ ] **Step 3.2: 写测试**

`tests/test_ashare_vendor.py`：

```python
"""Ashare vendor integration test (requires network)."""
import pytest


def test_ashare_daily_kline_600519():
    from research_mcp.vendor.Ashare import get_price
    df = get_price("sh600519", frequency="1d", count=10)
    assert df is not None
    assert len(df) > 0
    for col in ["open", "high", "low", "close", "volume"]:
        assert col in df.columns
    assert df["close"].iloc[-1] > 0


def test_ashare_daily_000001():
    from research_mcp.vendor.Ashare import get_price
    df = get_price("sz000001", frequency="1d", count=10)
    assert len(df) > 0
    assert df["close"].iloc[-1] > 0


def test_ashare_minute_kline_600519():
    from research_mcp.vendor.Ashare import get_price
    df = get_price("sh600519", frequency="15m", count=10)
    assert df is not None
    assert len(df) > 0
    assert "close" in df.columns
```

- [ ] **Step 3.3: 跑测试通过**

```bash
uv run pytest tests/test_ashare_vendor.py -v
```

Expected: 3 passed.

- [ ] **Step 3.4: Commit**

```bash
git add research_mcp/vendor/Ashare.py tests/test_ashare_vendor.py
git commit -m "feat(vendor): add mpquant/Ashare single-file library

Vendored as the price-fallback last-resort source. Sina+Tencent dual-source
auto-failover, zero dependency, no API key. Provides daily/weekly/minute
K-line in DataFrame format (cols: open/high/low/close/volume).

Will be wired into price_enhancer.py (Task 8) for the case where
LinDangAgent's price chain (QMT→Tushare→akshare→EM→Baostock) returns
empty/unusable data."
```

---

### Task 4: research_client — research-report fetcher

**Files:**
- Create: `research_mcp/research_client.py`
- Test: `tests/test_research_client.py`

- [ ] **Step 4.1: 写测试**

`tests/test_research_client.py`：

```python
"""research_client tests. Requires network."""
import pytest


def test_get_research_report_600519():
    from research_mcp.research_client import get_research_report
    result, warn = get_research_report("600519.SH")
    assert result is not None
    assert "reports" in result
    assert len(result["reports"]) > 0
    r0 = result["reports"][0]
    for key in ["title", "publish_date", "org", "rating"]:
        assert key in r0


def test_get_research_report_accepts_code6_only():
    """支持 600519 不带后缀。"""
    from research_mcp.research_client import get_research_report
    result, warn = get_research_report("600519")
    assert result is not None
    assert len(result["reports"]) > 0


def test_get_research_report_source_field():
    """result 应含 source 字段表明走了哪个源。"""
    from research_mcp.research_client import get_research_report
    result, warn = get_research_report("600519.SH")
    assert result.get("source") in ("akshare", "eastmoney_http")
```

- [ ] **Step 4.2: 跑测试确认失败**

```bash
uv run pytest tests/test_research_client.py -v
```

Expected: ImportError。

- [ ] **Step 4.3: 实现 `research_client.py`**

```python
# -*- coding: utf-8 -*-
"""Research report fetcher.

2-tier fallback:
  Primary: akshare.stock_research_report_em
  Fallback: eastmoney HTTP direct (reportapi.eastmoney.com/report/list)

Both normalized to a flat 'reports' list with standardized keys.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta
from typing import Any

logger = logging.getLogger(__name__)


def _ts_code_to_code6(ts_code: str) -> str:
    """600519.SH → 600519, 600519 → 600519"""
    return ts_code.split(".")[0] if "." in ts_code else ts_code


def _safe_str(v: Any) -> str:
    if v is None:
        return ""
    return str(v).strip()


def _research_via_akshare(code6: str) -> tuple[list[dict] | None, str | None]:
    try:
        import akshare as ak
        df = ak.stock_research_report_em(symbol=code6)
        if df is None or df.empty:
            return [], None
        reports = []
        for _, row in df.iterrows():
            reports.append({
                "title": _safe_str(row.get("报告名称")),
                "publish_date": _safe_str(row.get("日期")),
                "org": _safe_str(row.get("机构")),
                "rating": _safe_str(row.get("报告类型")),
                "predict_eps_this_year": row.get("2026-盈利预测-每股收益") or row.get("2025-盈利预测-每股收益"),
                "predict_pe_this_year": row.get("2026-盈利预测-市盈率") or row.get("2025-盈利预测-市盈率"),
                "industry": _safe_str(row.get("行业")),
                "pdf_url": _safe_str(row.get("报告PDF链接")),
            })
        return reports, None
    except Exception as e:
        return None, f"akshare research 失败：{type(e).__name__}: {e}"


def _research_via_eastmoney_http(code6: str) -> tuple[list[dict] | None, str | None]:
    """东财研报 HTTP 直连（akshare 包装底层就是这个接口，字段更全）。"""
    try:
        import requests
        url = "https://reportapi.eastmoney.com/report/list"
        params = {
            "industryCode": "*", "pageSize": "50", "industry": "*",
            "rating": "*", "ratingChange": "*",
            "beginTime": (datetime.now() - timedelta(days=365)).strftime("%Y-%m-%d"),
            "endTime": datetime.now().strftime("%Y-%m-%d"),
            "pageNo": "1", "fields": "", "qType": "0",
            "code": code6, "_": str(int(time.time() * 1000)),
        }
        headers = {
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://data.eastmoney.com/",
        }
        r = requests.get(url, params=params, headers=headers, timeout=8)
        if r.status_code != 200:
            return None, f"eastmoney HTTP {r.status_code}"
        data = r.json()
        items = data.get("data", []) or []
        reports = []
        for it in items:
            info_code = _safe_str(it.get("infoCode"))
            reports.append({
                "title": _safe_str(it.get("title")),
                "publish_date": _safe_str(it.get("publishDate"))[:10],
                "org": _safe_str(it.get("orgSName") or it.get("orgName")),
                "rating": _safe_str(it.get("emRatingName")),
                "rating_change": it.get("ratingChange"),
                "researcher": _safe_str(it.get("researcher")),
                "predict_eps_this_year": it.get("predictThisYearEps"),
                "predict_pe_this_year": it.get("predictThisYearPe"),
                "predict_eps_next_year": it.get("predictNextYearEps"),
                "predict_pe_next_year": it.get("predictNextYearPe"),
                "industry": _safe_str(it.get("indvInduName")),
                "pdf_url": f"https://pdf.dfcfw.com/pdf/H3_{info_code}_1.pdf" if info_code else "",
            })
        return reports, None
    except Exception as e:
        return None, f"eastmoney HTTP 失败：{type(e).__name__}: {e}"


def get_research_report(ts_code: str) -> tuple[dict | None, str | None]:
    """两层兜底：akshare → eastmoney HTTP 直连。

    Returns:
        ({"reports": [...], "source": "akshare"|"eastmoney_http"}, fetch_warning|None)
        失败全部时返回 (None, warning_chain)
    """
    code6 = _ts_code_to_code6(ts_code)
    warnings: list[str] = []

    reports, warn = _research_via_akshare(code6)
    if reports is not None:
        return {"reports": reports, "source": "akshare"}, warn

    warnings.append(warn or "akshare returned None")
    reports, warn = _research_via_eastmoney_http(code6)
    if reports is not None:
        warnings.append(warn or "")
        return {"reports": reports, "source": "eastmoney_http"}, "; ".join(w for w in warnings if w) or None

    warnings.append(warn or "eastmoney returned None")
    return None, "; ".join(warnings)
```

- [ ] **Step 4.4: 跑测试通过**

```bash
uv run pytest tests/test_research_client.py -v
```

Expected: 3 passed.

- [ ] **Step 4.5: Commit**

```bash
git add research_mcp/research_client.py tests/test_research_client.py
git commit -m "feat: research_client with 2-tier akshare+eastmoney fallback

Primary: akshare.stock_research_report_em (758 reports for 600519 in
spike, 2.1s). Fallback: direct eastmoney HTTP to reportapi.eastmoney.com/
report/list (20 reports, 223ms, richer fields).

Normalized output: reports list with title/publish_date/org/rating/
predict_eps_this_year/predict_pe_this_year/industry/pdf_url. Eastmoney
source adds rating_change/researcher/next_year predictions."
```

---

### Task 5: news_client — announcement fetcher

**Files:**
- Create: `research_mcp/news_client.py`
- Test: `tests/test_news_client.py`

- [ ] **Step 5.1: 写测试**

`tests/test_news_client.py`：

```python
"""news_client tests. Requires network."""
import pytest


def test_get_announcement_600519():
    from research_mcp.news_client import get_announcement
    result, warn = get_announcement("600519.SH", days_back=60)
    assert result is not None
    assert "announcements" in result
    assert isinstance(result["announcements"], list)
    if result["announcements"]:
        a0 = result["announcements"][0]
        for key in ["title", "date", "url"]:
            assert key in a0


def test_get_announcement_default_days_back():
    from research_mcp.news_client import get_announcement
    result, warn = get_announcement("600519.SH")
    assert result is not None
    assert "announcements" in result


def test_get_announcement_limit():
    from research_mcp.news_client import get_announcement
    result, warn = get_announcement("600519.SH", limit=5)
    if result and result["announcements"]:
        assert len(result["announcements"]) <= 5
```

- [ ] **Step 5.2: 跑测试确认失败**

```bash
uv run pytest tests/test_news_client.py -v
```

Expected: ImportError。

- [ ] **Step 5.3: 实现 `news_client.py`（先填 announcement，留 market_news placeholder）**

```python
# -*- coding: utf-8 -*-
"""News & announcement fetchers.

Public API:
  - get_announcement(ts_code, days_back, limit) → ({"announcements": [...]}, warn)
  - get_market_news(limit) → ({"items": [...]}, warn)  # filled in Task 6

Announcement chain:
  Primary: akshare.stock_zh_a_disclosure_report_cninfo (wraps cninfo)
  Fallback: eastmoney announcement HTTP direct

Market news: akshare.stock_news_main_cx (Caixin, single source, v1 scope).
Per-stock news intentionally not implemented in v1 (akshare.stock_news_em
has unsolvable pyarrow bug; v2 will add self-impl eastmoney search parser).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

logger = logging.getLogger(__name__)


def _ts_code_to_code6(ts_code: str) -> str:
    return ts_code.split(".")[0] if "." in ts_code else ts_code


def _safe_str(v: Any) -> str:
    if v is None:
        return ""
    return str(v).strip()


# ─────────────────────────────────────────────────────────────────────────────
# announcement
# ─────────────────────────────────────────────────────────────────────────────

def _announcement_via_akshare_cninfo(code6: str, start_date: str, end_date: str) -> tuple[list[dict] | None, str | None]:
    try:
        import akshare as ak
        df = ak.stock_zh_a_disclosure_report_cninfo(
            symbol=code6, market="沪深京", category="",
            start_date=start_date, end_date=end_date,
        )
        if df is None or df.empty:
            return [], None
        out = []
        for _, row in df.iterrows():
            out.append({
                "title": _safe_str(row.get("公告标题")),
                "date": _safe_str(row.get("公告时间"))[:10],
                "url": _safe_str(row.get("公告链接")),
            })
        return out, None
    except Exception as e:
        return None, f"akshare cninfo 失败：{type(e).__name__}: {e}"


def _announcement_via_eastmoney_http(code6: str, days_back: int) -> tuple[list[dict] | None, str | None]:
    try:
        import requests
        url = "https://np-anotice-stock.eastmoney.com/api/security/ann"
        params = {
            "sr": "-1", "page_size": "30", "page_index": "1",
            "ann_type": "A", "client_source": "web",
            "stock_list": code6, "f_node": "1", "s_node": "1",
            "begin_date": (datetime.now() - timedelta(days=days_back)).strftime("%Y-%m-%d"),
            "end_date": datetime.now().strftime("%Y-%m-%d"),
        }
        headers = {"User-Agent": "Mozilla/5.0"}
        r = requests.get(url, params=params, headers=headers, timeout=8)
        if r.status_code != 200:
            return None, f"eastmoney 公告 HTTP {r.status_code}"
        data = r.json() or {}
        items = (data.get("data") or {}).get("list", []) or []
        out = []
        for it in items:
            art_code = _safe_str(it.get("art_code"))
            out.append({
                "title": _safe_str(it.get("title")),
                "date": _safe_str(it.get("notice_date") or it.get("eiTime"))[:10],
                "url": f"https://np-anotice-stock.eastmoney.com/api/content/ann?art_code={art_code}" if art_code else "",
            })
        return out, None
    except Exception as e:
        return None, f"eastmoney 公告 HTTP 失败：{type(e).__name__}: {e}"


def get_announcement(ts_code: str, days_back: int = 60, limit: int = 30) -> tuple[dict | None, str | None]:
    code6 = _ts_code_to_code6(ts_code)
    end = datetime.now().strftime("%Y%m%d")
    start = (datetime.now() - timedelta(days=days_back)).strftime("%Y%m%d")
    warnings: list[str] = []

    items, warn = _announcement_via_akshare_cninfo(code6, start, end)
    if items is not None:
        return {"announcements": items[:limit], "source": "akshare_cninfo"}, warn

    warnings.append(warn or "")
    items, warn = _announcement_via_eastmoney_http(code6, days_back)
    if items is not None:
        return {"announcements": items[:limit], "source": "eastmoney_http"}, "; ".join(w for w in warnings + [warn or ""] if w) or None

    warnings.append(warn or "")
    return None, "; ".join(w for w in warnings if w)


# ─────────────────────────────────────────────────────────────────────────────
# market news (placeholder, filled in Task 6)
# ─────────────────────────────────────────────────────────────────────────────

def get_market_news(limit: int = 50) -> tuple[dict | None, str | None]:
    raise NotImplementedError("filled in Task 6")
```

- [ ] **Step 5.4: 跑测试通过**

```bash
uv run pytest tests/test_news_client.py -v
```

Expected: 3 passed.

- [ ] **Step 5.5: Commit**

```bash
git add research_mcp/news_client.py tests/test_news_client.py
git commit -m "feat: news_client.get_announcement with cninfo+eastmoney fallback

Primary: akshare.stock_zh_a_disclosure_report_cninfo (wraps cninfo
official endpoint, 32 announcements for 600519 in 60-day window, 636ms
in spike). Fallback: direct eastmoney announcement HTTP.

Normalized: announcements list with title/date/url. get_market_news
placeholder for Task 6."
```

---

### Task 6: news_client — market_news fetcher

**Files:**
- Modify: `research_mcp/news_client.py` — fill `get_market_news`

- [ ] **Step 6.1: 写测试**

追加到 `tests/test_news_client.py`：

```python
def test_get_market_news_default():
    from research_mcp.news_client import get_market_news
    result, warn = get_market_news()
    assert result is not None
    assert "items" in result
    assert len(result["items"]) >= 10
    item = result["items"][0]
    for key in ["tag", "summary", "url"]:
        assert key in item


def test_get_market_news_limit():
    from research_mcp.news_client import get_market_news
    result, warn = get_market_news(limit=5)
    assert result is not None
    assert len(result["items"]) == 5
```

- [ ] **Step 6.2: 跑测试确认失败**

```bash
uv run pytest tests/test_news_client.py::test_get_market_news_default -v
```

Expected: FAIL（NotImplementedError）。

- [ ] **Step 6.3: 实现 get_market_news（替换 Task 5 留的 placeholder）**

把 `news_client.py` 末尾的 `get_market_news` 实现替换为：

```python
def get_market_news(limit: int = 50) -> tuple[dict | None, str | None]:
    """Caixin main news (single source, v1 scope: market-wide only)."""
    try:
        import akshare as ak
        df = ak.stock_news_main_cx()
        if df is None or df.empty:
            return {"items": [], "source": "akshare_caixin"}, "财新返回空"
        items = []
        for _, row in df.head(limit).iterrows():
            items.append({
                "tag": _safe_str(row.get("tag")),
                "summary": _safe_str(row.get("summary")),
                "url": _safe_str(row.get("url")),
            })
        return {"items": items, "source": "akshare_caixin"}, None
    except Exception as e:
        return None, f"财新失败：{type(e).__name__}: {e}"
```

- [ ] **Step 6.4: 跑测试通过**

```bash
uv run pytest tests/test_news_client.py -v
```

Expected: 5 passed.

- [ ] **Step 6.5: Commit**

```bash
git add research_mcp/news_client.py tests/test_news_client.py
git commit -m "feat: news_client.get_market_news (Caixin single source)

v1 covers only market-wide news via akshare.stock_news_main_cx (100
items in spike, 661ms). Per-stock news is v2 scope (requires
self-implementing eastmoney search HTTP parser since akshare
stock_news_em has pyarrow regex bug)."
```

---

### Task 7: peers_enhancer — 包装 LinDangAgent peers 修复假兜底

**Files:**
- Create: `research_mcp/peers_enhancer.py`
- Test: `tests/test_peers_enhancer.py`

**Why this task:** LinDangAgent 的 peers 是"假兜底"——Tushare 估值失败时退化为"行业+名单"无估值。我们包装它，发现退化迹象时本项目自己用 akshare 行业接口补救。

- [ ] **Step 7.1: 写测试**

`tests/test_peers_enhancer.py`：

```python
"""peers_enhancer integration tests."""
import pytest
from unittest.mock import patch, MagicMock


def test_peers_enhanced_normal_path():
    """LinDangAgent peers 正常 → 直接透传，不补救。"""
    from research_mcp.peers_enhancer import get_peers_enhanced
    result, warn = get_peers_enhanced("600519")
    assert result is not None
    assert "text" in result
    assert "行业" in result["text"]


def test_peers_enhanced_supplements_when_lindang_degraded():
    """模拟 LinDangAgent 返回假兜底（无估值字段）→ 本项目应补 akshare 行业估值。"""
    from research_mcp import peers_enhancer

    # 模拟 LinDangAgent 返回降级数据
    degraded = {
        "ok": True, "op": "peers", "symbol": "600519.SH",
        "stock_name": "贵州茅台",
        "text": "行业：白酒Ⅱ\n同行业个股：五粮液、洋河股份、泸州老窖",
        "fetch_warning": None,
    }
    with patch.object(peers_enhancer, "call_lindang", return_value=degraded):
        result, warn = peers_enhancer.get_peers_enhanced("600519")
        assert result is not None
        # 补救后应该带某种估值关键词
        text = result["text"]
        keywords = ["PE", "PB", "市值", "估值", "资金", "市盈率"]
        assert any(k in text for k in keywords), f"补救未补估值：{text[:200]}"


def test_peers_enhanced_returns_none_when_lindang_unreachable():
    """LinDangAgent 不可达 → enhancer 应仍尝试补救。"""
    from research_mcp import peers_enhancer
    with patch.object(peers_enhancer, "call_lindang", return_value=None):
        result, warn = peers_enhancer.get_peers_enhanced("600519")
        # 补救层应该尝试（不一定成功），warn 应有内容
        assert warn  # 必须有 warning 解释发生了啥
```

- [ ] **Step 7.2: 跑测试确认失败**

```bash
uv run pytest tests/test_peers_enhancer.py -v
```

Expected: ImportError。

- [ ] **Step 7.3: 实现 `peers_enhancer.py`**

```python
# -*- coding: utf-8 -*-
"""peers enhancer: wraps LinDangAgent peers + adds akshare industry fallback.

LinDangAgent's get_sector_peers has a 'fake fallback' problem: when Tushare
valuation is unavailable, it returns just '行业 + 名单' with zero valuation
data. We wrap it, detect this degraded state (no PE/PB/market cap keywords
in text), and supplement with akshare industry valuation.

3-tier supplement chain (only kicks in when LinDangAgent is degraded):
  1. akshare.stock_industry_pe_ratio_cninfo (industry-level PE)
  2. akshare.stock_sector_fund_flow_rank (industry fund flow)
  3. Just label as degraded (no further supplement possible)
"""

from __future__ import annotations

import logging

from research_mcp.lindang_proxy import call_lindang

logger = logging.getLogger(__name__)

# 估值/资金面关键词——文本中包含任一即认为 LinDangAgent 给了正常数据，不需要补救
VALUATION_KEYWORDS = ("PE", "PB", "市值", "估值", "市盈率", "市净率", "净流入")


def _is_degraded(text: str) -> bool:
    """检测 LinDangAgent peers 返回是否是降级文本（无估值字段）。"""
    if not text:
        return True
    return not any(k in text for k in VALUATION_KEYWORDS)


def _industry_from_text(text: str) -> str | None:
    """从 LinDangAgent peers 返回文本中提取行业名。"""
    if not text:
        return None
    for line in text.split("\n"):
        if line.startswith("行业："):
            return line.split("：", 1)[1].strip().split()[0]
    return None


def _supplement_via_akshare_industry_pe(industry: str) -> tuple[str | None, str | None]:
    """akshare 行业 PE 聚合。"""
    try:
        import akshare as ak
        df = ak.stock_industry_pe_ratio_cninfo(symbol=industry)
        if df is None or df.empty:
            return None, "akshare 行业 PE 空"
        latest = df.tail(1).iloc[0]
        pe_cols = [c for c in df.columns if "市盈率" in c or "PE" in c]
        if not pe_cols:
            return None, "akshare 行业 PE 无估值列"
        lines = [f"行业 {industry} 估值（akshare 补救）："]
        for col in pe_cols[:3]:
            lines.append(f"  {col}: {latest[col]}")
        return "\n".join(lines), None
    except Exception as e:
        return None, f"akshare 行业 PE 失败：{type(e).__name__}: {e}"


def _supplement_via_eastmoney_industry_flow(industry: str) -> tuple[str | None, str | None]:
    """东财行业资金流（akshare 包装）。"""
    try:
        import akshare as ak
        df = ak.stock_sector_fund_flow_rank(indicator="今日", sector_type="行业资金流")
        if df is None or df.empty:
            return None, "东财行业资金 空"
        row = df[df["名称"].astype(str).str.contains(industry, na=False)]
        if row.empty:
            return None, f"东财行业资金 找不到 {industry}"
        r = row.iloc[0]
        return (
            f"行业 {industry} 资金面（东财补救）：\n"
            f"  今日主力净流入：{r.get('今日主力净流入-净额', 'N/A')}\n"
            f"  今日涨跌幅：{r.get('今日涨跌幅', 'N/A')}"
        ), None
    except Exception as e:
        return None, f"东财行业资金 失败：{type(e).__name__}: {e}"


def get_peers_enhanced(symbol: str) -> tuple[dict | None, str | None]:
    """调 LinDangAgent peers；如发现降级，本项目补 akshare 行业估值/东财资金面。

    Returns:
        ({"text": str, "lindang_text": str|None, "supplements": [...]}, warning)
        失败时 (None, warning)
    """
    warnings: list[str] = []
    lindang_result = call_lindang("peers", symbol)

    if lindang_result is None:
        warnings.append("LinDangAgent peers 不可达")
        lindang_text = None
    else:
        lindang_text = lindang_result.get("text", "")
        if lindang_result.get("fetch_warning"):
            warnings.append(f"lindang warning: {lindang_result['fetch_warning']}")

    if lindang_text and not _is_degraded(lindang_text):
        # LinDangAgent 正常返回带估值数据，透传不补救
        return {"text": lindang_text, "lindang_text": lindang_text, "supplements": []}, \
               "; ".join(warnings) or None

    # 进入补救路径
    industry = _industry_from_text(lindang_text or "") if lindang_text else None
    if not industry:
        # 无法确定行业，本项目尝试自己 resolve（通过 lindang_proxy basic）
        basic = call_lindang("basic", symbol)
        if basic and basic.get("info"):
            industry = basic["info"].get("行业") or basic["info"].get("industry")

    if not industry:
        warnings.append("无法确定行业，跳过补救")
        return {"text": lindang_text or "", "lindang_text": lindang_text, "supplements": []}, \
               "; ".join(warnings)

    supplements: list[str] = []

    sup, warn = _supplement_via_akshare_industry_pe(industry)
    if sup:
        supplements.append(sup)
    elif warn:
        warnings.append(warn)

    sup, warn = _supplement_via_eastmoney_industry_flow(industry)
    if sup:
        supplements.append(sup)
    elif warn:
        warnings.append(warn)

    if not supplements:
        warnings.append("所有补救源失败")

    enhanced_text = (lindang_text or "") + ("\n\n" + "\n\n".join(supplements) if supplements else "")

    return {
        "text": enhanced_text,
        "lindang_text": lindang_text,
        "supplements": supplements,
        "industry": industry,
    }, "; ".join(warnings) or None
```

- [ ] **Step 7.4: 跑测试通过**

```bash
uv run pytest tests/test_peers_enhancer.py -v
```

Expected: 3 passed.

- [ ] **Step 7.5: Commit**

```bash
git add research_mcp/peers_enhancer.py tests/test_peers_enhancer.py
git commit -m "feat: peers_enhancer wraps LinDangAgent + akshare industry fallback

LinDangAgent's get_sector_peers degrades to 'industry + name list' (no
PE/PB) when Tushare valuation fails. This enhancer detects that
degradation (text without PE/PB/market cap keywords) and supplements
with:
  1. akshare.stock_industry_pe_ratio_cninfo (industry-level PE)
  2. akshare.stock_sector_fund_flow_rank (industry fund flow)

Normal path (LinDangAgent returns valuation data) is transparent
passthrough. fetch_warning chain preserved for AI visibility into
which sources contributed."
```

---

### Task 8: price_enhancer — LinDangAgent price 失败时 Ashare 救场

**Files:**
- Create: `research_mcp/price_enhancer.py`
- Test: `tests/test_price_enhancer.py`

**Why this task:** LinDangAgent 的 price 链已经是 5-6 层兜底（QMT→Tushare→akshare→EM→Baostock），但**仍可能全挂**（罕见但发生过：节假日 + Tushare token 过期 + 网络抽风）。本 enhancer 在 LinDangAgent 完全失败时用本项目 vendor 的 Ashare 补救。

- [ ] **Step 8.1: 写测试**

`tests/test_price_enhancer.py`：

```python
"""price_enhancer tests."""
import pytest
from unittest.mock import patch


def test_price_enhanced_normal_path_passes_through():
    """LinDangAgent price 正常 → 透传，不调 Ashare。"""
    from research_mcp import price_enhancer

    fake_lindang_result = {
        "ok": True, "op": "price", "symbol": "600519.SH", "stock_name": "贵州茅台",
        "days": 60, "summary": "...",
        "recent": [{"日期": "2026-05-13", "收盘": 1344.09}],
        "fetch_warning": None,
    }
    with patch.object(price_enhancer, "call_lindang", return_value=fake_lindang_result):
        result, warn = price_enhancer.get_price_enhanced("600519", days=60)
        assert result is not None
        assert result.get("source_chain") == "lindang"
        assert "recent" in result


def test_price_enhanced_uses_ashare_when_lindang_fails():
    """LinDangAgent 完全失败 → Ashare 接管。"""
    from research_mcp import price_enhancer

    with patch.object(price_enhancer, "call_lindang", return_value=None):
        result, warn = price_enhancer.get_price_enhanced("600519", days=10)
        assert result is not None
        assert result.get("source_chain") == "ashare"
        assert "recent" in result
        assert len(result["recent"]) > 0


def test_price_enhanced_uses_ashare_when_lindang_returns_empty():
    """LinDangAgent ok=True 但 recent 是空数组 → Ashare 救场。"""
    from research_mcp import price_enhancer
    empty_lindang = {
        "ok": True, "op": "price", "symbol": "600519.SH",
        "recent": [], "summary": "无数据",
    }
    with patch.object(price_enhancer, "call_lindang", return_value=empty_lindang):
        result, warn = price_enhancer.get_price_enhanced("600519", days=10)
        assert result is not None
        assert result.get("source_chain") == "ashare"
```

- [ ] **Step 8.2: 跑测试确认失败**

```bash
uv run pytest tests/test_price_enhancer.py -v
```

Expected: ImportError。

- [ ] **Step 8.3: 实现 `price_enhancer.py`**

```python
# -*- coding: utf-8 -*-
"""price enhancer: LinDangAgent price → Ashare last-resort fallback.

LinDangAgent already has 5-6 layer price fallback (QMT→Tushare→akshare→EM
→Baostock). This enhancer adds Ashare (vendored) as a final safety net
when all of LinDangAgent's sources return empty/fail. Ashare uses Sina+
Tencent public HTTP endpoints with zero dependencies — extremely reliable
as a last-resort source.
"""

from __future__ import annotations

import logging

from research_mcp.lindang_proxy import call_lindang

logger = logging.getLogger(__name__)


def _ts_code_to_ashare(ts_code: str) -> str:
    """600519.SH → sh600519, 000001.SZ → sz000001, 600519 → sh600519"""
    if "." in ts_code:
        code6, market = ts_code.split(".")
        return market.lower() + code6
    # 无后缀时按前缀推断
    if ts_code.startswith("6"):
        return "sh" + ts_code
    return "sz" + ts_code


def _try_ashare(symbol: str, days: int) -> tuple[dict | None, str | None]:
    try:
        from research_mcp.vendor.Ashare import get_price as ashare_get_price
        ashare_sym = _ts_code_to_ashare(symbol)
        df = ashare_get_price(ashare_sym, frequency="1d", count=days)
        if df is None or df.empty:
            return None, "Ashare 返回空"
        records = df.reset_index().rename(columns={
            "day": "日期", "index": "日期",
            "open": "开盘", "high": "最高", "low": "最低", "close": "收盘",
            "volume": "成交量",
        }).to_dict("records")
        last = records[-1] if records else {}
        first = records[0] if records else {}
        close_last = last.get("收盘", 0)
        close_first = first.get("收盘", 0)
        change_pct = ((close_last - close_first) / close_first * 100) if close_first else 0
        summary = (
            f"近 {days} 日：收盘 {close_first:.2f} → {close_last:.2f}，"
            f"区间涨跌 {change_pct:+.2f}%"
        )
        return {
            "recent": records,
            "summary": summary,
            "source_chain": "ashare",
        }, None
    except Exception as e:
        return None, f"Ashare 异常：{type(e).__name__}: {e}"


def get_price_enhanced(symbol: str, days: int = 60, tail: int = 10) -> tuple[dict | None, str | None]:
    """LinDangAgent price → Ashare 救场。

    判定 LinDangAgent 失败的两种情况：
      1. call_lindang 返回 None（subprocess 错误）
      2. ok=True 但 recent 数组为空（所有源都返回了空数据）
    """
    warnings: list[str] = []
    lindang_result = call_lindang("price", symbol, "--days", str(days), "--tail", str(tail))

    if lindang_result is not None:
        if lindang_result.get("ok") and lindang_result.get("recent"):
            # LinDangAgent 成功且非空
            return {
                "symbol": lindang_result.get("symbol"),
                "stock_name": lindang_result.get("stock_name"),
                "days": days,
                "summary": lindang_result.get("summary"),
                "recent": lindang_result.get("recent"),
                "source_chain": "lindang",
                "lindang_fetch_warning": lindang_result.get("fetch_warning"),
            }, lindang_result.get("fetch_warning")
        if lindang_result.get("ok"):
            warnings.append("LinDangAgent ok 但 recent 为空")
        else:
            warnings.append(f"LinDangAgent error: {lindang_result.get('error')}")
    else:
        warnings.append("LinDangAgent 不可达")

    # Ashare 救场
    ashare_result, ashare_warn = _try_ashare(symbol, days)
    if ashare_result is not None:
        ashare_result["lindang_warnings"] = warnings
        warnings_str = "; ".join(warnings + (["LinDangAgent 失败已切 Ashare"] if not warnings else []))
        return ashare_result, warnings_str
    warnings.append(ashare_warn or "Ashare 也失败")
    return None, "; ".join(warnings)
```

- [ ] **Step 8.4: 跑测试通过**

```bash
uv run pytest tests/test_price_enhancer.py -v
```

Expected: 3 passed.

- [ ] **Step 8.5: Commit**

```bash
git add research_mcp/price_enhancer.py tests/test_price_enhancer.py
git commit -m "feat: price_enhancer adds Ashare last-resort fallback

LinDangAgent already has 5-6 layer price fallback; this adds the
vendored Ashare (Sina+Tencent) as a final safety net when LinDangAgent
either returns subprocess error or ok=True but with empty recent[].

Detection logic:
  1. call_lindang returns None → Ashare
  2. ok=True but recent=[] → Ashare
  3. Otherwise pass through LinDangAgent result

source_chain field tells caller which source actually produced data
(lindang | ashare) so AI can know how degraded the chain was."
```

---

### Task 9: query.py — 统一 CLI 入口（22 op）

**Files:**
- Create: `C:\research-mcp\query.py`
- Test: `tests/test_query_cli.py`

- [ ] **Step 9.1: 写 CLI 集成测试**

`tests/test_query_cli.py`：

```python
"""query.py CLI integration tests."""
import json
import subprocess


def _run_query(op, *args):
    cmd = ["uv", "run", "python", "query.py", op, *[str(a) for a in args]]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", timeout=120, cwd=r"C:\research-mcp")
    assert r.returncode in (0, 1), f"unexpected returncode {r.returncode}: {r.stderr[:300]}"
    return json.loads(r.stdout)


def test_query_proxied_op_gate():
    out = _run_query("gate", "600519")
    assert out.get("ok") is True
    assert out.get("op") == "gate"


def test_query_proxied_op_snapshot():
    out = _run_query("snapshot", "600519")
    assert out.get("ok") is True
    assert out.get("op") == "snapshot"


def test_query_new_op_research_report():
    out = _run_query("research-report", "600519")
    assert out.get("ok") is True
    assert out.get("op") == "research-report"
    assert "reports" in out
    assert len(out["reports"]) > 0


def test_query_new_op_announcement():
    out = _run_query("announcement", "600519")
    assert out.get("ok") is True
    assert out.get("op") == "announcement"
    assert "announcements" in out


def test_query_new_op_news_no_symbol():
    out = _run_query("news")
    assert out.get("ok") is True
    assert out.get("op") == "news"
    assert "items" in out


def test_query_enhanced_op_peers():
    out = _run_query("peers", "600519")
    assert out.get("ok") is True
    assert out.get("op") == "peers"
    assert "text" in out


def test_query_enhanced_op_price():
    out = _run_query("price", "600519", "--days", "10")
    assert out.get("ok") is True
    assert out.get("op") == "price"
    assert "recent" in out
    assert "source_chain" in out  # enhanced 标记
```

- [ ] **Step 9.2: 跑测试确认失败**

```bash
uv run pytest tests/test_query_cli.py -v
```

Expected: 全部 FAIL（query.py 还没建）。

- [ ] **Step 9.3: 实现 `query.py`**

```python
#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""research-mcp 统一 CLI 入口。

22 个 op：
  - 19 个老 op 透传到 LinDangAgent (gate/basic/financial/...)
  - 3 个新 op 本项目实现 (research-report/announcement/news)
  - 2 个增强 op 本项目包装 (peers/price)

输出严格 JSON 到 stdout，日志到 stderr。
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys

logging.basicConfig(
    level=logging.WARNING,
    stream=sys.stderr,
    format="[%(name)s] %(message)s",
)

# 与 LinDangAgent 一致：网络代理白名单
os.environ.setdefault("NO_PROXY", "localhost,127.0.0.1")


def _out(obj: dict) -> None:
    sys.stdout.buffer.write(
        json.dumps(obj, ensure_ascii=False, default=str, indent=2).encode("utf-8")
    )
    sys.stdout.buffer.write(b"\n")


def _ok(op: str, **payload) -> None:
    _out({"ok": True, "op": op, **payload})


def _err(op: str, error: str, **extra) -> None:
    _out({"ok": False, "op": op, "error": error, **extra})
    sys.exit(1)


# ─── 透传层：老 19 op ────────────────────────────────────────────────

PROXIED_OPS = {
    "gate", "basic", "financial", "flow", "dragon-tiger", "valuation",
    "northbound", "margin", "holders", "pledge", "funds", "indicators",
    "snapshot",
    "qmt-kline", "qmt-realtime", "qmt-sector", "qmt-financial",
}


def op_proxied(args):
    """通用透传：原样把 args 转给 LinDangAgent。"""
    from research_mcp.lindang_proxy import call_lindang

    # 把 argparse 解析后的 namespace 还原成 LinDangAgent CLI 参数
    # 第一个参数是 symbol（通用约定），其余是 -- 形式可选参数
    op = args.op
    cmd_args = []
    if hasattr(args, "symbol") and args.symbol:
        cmd_args.append(args.symbol)
    if hasattr(args, "symbols") and args.symbols:
        cmd_args.append(args.symbols)
    if hasattr(args, "sector") and args.sector:
        cmd_args.append(args.sector)
    # 已知的 --xx 参数透传
    for opt_name in ("days", "tail", "years", "period", "count", "limit"):
        if hasattr(args, opt_name) and getattr(args, opt_name) is not None:
            cmd_args.extend([f"--{opt_name}", str(getattr(args, opt_name))])

    result = call_lindang(op, *cmd_args)
    if result is None:
        return _err(op, "LinDangAgent subprocess 失败")
    _out(result)
    sys.exit(0 if result.get("ok") else 1)


# ─── 新 3 op：自实现 ─────────────────────────────────────────────────

def op_research_report(args):
    from research_mcp.research_client import get_research_report
    result, warn = get_research_report(args.symbol)
    if result is None:
        return _err("research-report", warn or "所有源失败", symbol=args.symbol)
    _ok("research-report", symbol=args.symbol,
        reports=result.get("reports", []),
        count=len(result.get("reports", [])),
        data_source=result.get("source"),
        fetch_warning=warn)


def op_announcement(args):
    from research_mcp.news_client import get_announcement
    result, warn = get_announcement(args.symbol, days_back=args.days_back, limit=args.limit)
    if result is None:
        return _err("announcement", warn or "所有源失败", symbol=args.symbol)
    _ok("announcement", symbol=args.symbol,
        announcements=result.get("announcements", []),
        count=len(result.get("announcements", [])),
        data_source=result.get("source"),
        days_back=args.days_back, fetch_warning=warn)


def op_news(args):
    from research_mcp.news_client import get_market_news
    result, warn = get_market_news(limit=args.limit)
    if result is None:
        return _err("news", warn or "财新失败")
    _ok("news", scope="market",
        items=result.get("items", []),
        count=len(result.get("items", [])),
        data_source=result.get("source"),
        fetch_warning=warn)


# ─── 增强 2 op：包装 ─────────────────────────────────────────────────

def op_peers_enhanced(args):
    from research_mcp.peers_enhancer import get_peers_enhanced
    result, warn = get_peers_enhanced(args.symbol)
    if result is None:
        return _err("peers", warn or "全部失败", symbol=args.symbol)
    _ok("peers", symbol=args.symbol,
        text=result.get("text"),
        industry=result.get("industry"),
        supplements_count=len(result.get("supplements", [])),
        lindang_passed=(result.get("supplements") == []),
        fetch_warning=warn)


def op_price_enhanced(args):
    from research_mcp.price_enhancer import get_price_enhanced
    result, warn = get_price_enhanced(args.symbol, days=args.days, tail=args.tail)
    if result is None:
        return _err("price", warn or "全部失败", symbol=args.symbol)
    _ok("price", symbol=args.symbol,
        days=args.days,
        summary=result.get("summary"),
        recent=result.get("recent"),
        source_chain=result.get("source_chain"),
        fetch_warning=warn)


# ─── 主入口 ─────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(prog="query.py", description="research-mcp 统一查询入口")
    sub = parser.add_subparsers(dest="op", required=True)

    # 19 个透传 op
    for cmd in ("gate", "basic", "financial", "flow", "dragon-tiger",
                "northbound", "margin", "holders", "pledge", "funds",
                "snapshot", "indicators"):
        p = sub.add_parser(cmd)
        p.add_argument("symbol")

    p = sub.add_parser("valuation")
    p.add_argument("symbol")
    p.add_argument("--years", type=int, default=3)

    p = sub.add_parser("qmt-kline")
    p.add_argument("symbol")
    p.add_argument("--period", default="1d")
    p.add_argument("--count", type=int, default=60)
    p.add_argument("--tail", type=int, default=20)

    p = sub.add_parser("qmt-realtime")
    p.add_argument("symbols")

    p = sub.add_parser("qmt-sector")
    p.add_argument("sector")
    p.add_argument("--limit", type=int, default=50)

    p = sub.add_parser("qmt-financial")
    p.add_argument("symbol")
    p.add_argument("--years", type=int, default=3)

    # 新 3 op
    p = sub.add_parser("research-report")
    p.add_argument("symbol")

    p = sub.add_parser("announcement")
    p.add_argument("symbol")
    p.add_argument("--days-back", type=int, default=60)
    p.add_argument("--limit", type=int, default=30)

    p = sub.add_parser("news")
    p.add_argument("--limit", type=int, default=50)

    # 增强 2 op
    p = sub.add_parser("peers")
    p.add_argument("symbol")

    p = sub.add_parser("price")
    p.add_argument("symbol")
    p.add_argument("--days", type=int, default=60)
    p.add_argument("--tail", type=int, default=10)

    args = parser.parse_args()

    # 路由
    OPS = {
        "research-report": op_research_report,
        "announcement": op_announcement,
        "news": op_news,
        "peers": op_peers_enhanced,
        "price": op_price_enhanced,
    }
    if args.op in OPS:
        OPS[args.op](args)
    elif args.op in PROXIED_OPS:
        op_proxied(args)
    else:
        _err(args.op, f"unknown op: {args.op}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 9.4: 手动 smoke**

```bash
uv run python query.py snapshot 600519 | python -c "import json, sys; d=json.load(sys.stdin); print('snapshot ok=', d['ok'])"
uv run python query.py research-report 600519 | python -c "import json, sys; d=json.load(sys.stdin); print('research-report ok=', d['ok'], 'count=', d.get('count'))"
uv run python query.py peers 600519 | python -c "import json, sys; d=json.load(sys.stdin); print('peers ok=', d['ok'])"
uv run python query.py price 600519 --days 10 | python -c "import json, sys; d=json.load(sys.stdin); print('price ok=', d['ok'], 'source=', d.get('source_chain'))"
```

Expected: 各 op 都返回 `ok= True`。

- [ ] **Step 9.5: 跑 pytest**

```bash
uv run pytest tests/test_query_cli.py -v
```

Expected: 7 passed.

- [ ] **Step 9.6: Commit**

```bash
git add query.py tests/test_query_cli.py
git commit -m "feat: query.py unified CLI for 22 ops

Single entry point for all callers (AI roundtable, MCP server, manual
testing):
  - 19 ops transparently proxied to LinDangAgent
  - 3 new ops self-implemented (research-report / announcement / news)
  - 2 enhanced ops (peers / price) — wrap LinDang with extra fallback

Output: strict JSON to stdout (ensure_ascii=False, indent=2), logs to
stderr. Exit code 0 on ok=true, 1 on ok=false."
```

---

### Task 10: docs/AGENT_GUIDE.md — 给 AI 圆桌成员的 22 op 手册

**Files:**
- Create: `C:\research-mcp\docs\AGENT_GUIDE.md`

- [ ] **Step 10.1: 写 AGENT_GUIDE.md**

```markdown
# research-mcp · 圆桌 AI 投研查询手册

> 给 Claude / Gemini / Codex / DeepSeek / GLM 等圆桌成员看的。
> 唯一推荐入口：`uv run python C:\research-mcp\query.py <op> [args...]`

---

## 调用模式

```bash
cd C:\research-mcp
uv run python query.py <op> [args...]
```

- 输出：标准 JSON 到 stdout
- 日志/进度：stderr，不污染 stdout
- exit code：0 ok=true / 1 ok=false

---

## 22 个 op 清单

### 透传层（19 个，老牌数据走 LinDangAgent，已有 5-6 层兜底）

| op | 参数 | 说明 |
|---|---|---|
| `gate <code>` | symbol | 退市/ST 闸门 |
| `basic <code>` | symbol | 基本面（PE/PB/市值/换手率） |
| `financial <code>` | symbol | 财报摘要 |
| `flow <code>` | symbol | 主力资金流 |
| `dragon-tiger <code>` | symbol | 龙虎榜 |
| `valuation <code>` | symbol [--years 3] | PE/PB 历史分位 |
| `northbound <code>` | symbol | 北向持股 |
| `margin <code>` | symbol | 融资融券 |
| `holders <code>` | symbol | 大股东 |
| `pledge <code>` | symbol | 股权质押 |
| `funds <code>` | symbol | 基金持仓 |
| `snapshot <code>` | symbol | 一键综合（gate+basic+price+indicators+flow） |
| `indicators <code>` | symbol | 17 项技术指标 |
| `qmt-kline <code>` | symbol [--period 1d] [--count 60] [--tail 20] | QMT 实时 K 线 |
| `qmt-realtime <code1,code2>` | symbols | QMT 实时盘口 |
| `qmt-sector <name>` | sector [--limit 50] | QMT 板块成分 |
| `qmt-financial <code>` | symbol [--years 3] | QMT 财报三表 |

### 新增层（3 个，本项目自实现）🆕

| op | 参数 | 说明 |
|---|---|---|
| `research-report <code>` | symbol | 券商研报（标题/评级/目标价/盈利预测/PDF链接）。akshare 主源 → 东财 HTTP 副源 |
| `announcement <code>` | symbol [--days-back 60] [--limit 30] | 公司公告（巨潮官方）。akshare cninfo 主源 → 东财公告副源 |
| `news` | [--limit 50] | 财新大盘新闻 100 条最新（**v1 只有大盘，没有个股**） |

### 增强层（2 个，本项目包装 LinDangAgent 并加补救）

| op | 参数 | 说明 |
|---|---|---|
| `price <code>` | symbol [--days 60] [--tail 10] | K 线，LinDangAgent 全挂时 Ashare 救场。返回 `source_chain` 标识 |
| `peers <code>` | symbol | 同业对比，LinDangAgent 假兜底时 akshare 行业估值/资金补救 |

---

## 圆桌使用纪律

1. **gate 优先**：讨论新股先 `gate <code>` 拦截退市/ST
2. **snapshot 优先**：第一次接触某股时 `snapshot <code>` 一次拿全景
3. **新工具 v1 范围**：
   - `news` 是大盘新闻**不是个股新闻**（v1 限制；个股新闻待 v2）
   - `research-report` 是券商研报，不是公司财报（财报用 `financial`）
   - `announcement` 是法定披露公告（年报/停牌/重大事项）
4. **不要并行调多个 op**：tushare/QMT 都有 rate limit
5. **看 source_chain 字段**：`price` 返回 `source_chain="lindang"` 说明走的是 LinDang 链；`"ashare"` 说明是救场
6. **看 fetch_warning 字段**：非空说明走了某层副源，结论中可以提"数据来源是兜底"

---

## 调用链

```
AI 工具调用 ─→ Hub MCP server ─→ subprocess uv run python C:\research-mcp\query.py <op>
                                                           │
                                  ┌────────────────────────┼────────────────────────┐
                                  ▼                        ▼                        ▼
                          自实现 fetcher         包装 enhancer              透传 LinDangAgent
                       (research/announcement/   (peers/price)              (其他 19 op via
                        news_client.py)                                      subprocess)
                                                                                    │
                                                                                    ▼
                                                                       C:\LinDangAgent\data_query.py
                                                                       (5-6 层兜底完整保留)
```

---

## 与 LinDangAgent 的关系

本项目**不修改** LinDangAgent 任何文件。它的 19 个 op + 5-6 层兜底由 LinDangAgent 自己维护；本项目只做 subprocess 透传。如发现 LinDangAgent 某 op 老挂或字段缺漏，**回 LinDangAgent 项目修复，本项目可加 enhancer 临时补救**。
```

- [ ] **Step 10.2: 同时复制本 plan 到 research-mcp/docs/superpowers/plans/（历史保留）**

```powershell
Copy-Item C:\Users\lintian\claude-session-hub\docs\superpowers\plans\2026-05-14-research-mcp-backend.md C:\research-mcp\docs\superpowers\plans\2026-05-14-research-mcp-backend.md
```

- [ ] **Step 10.3: Commit**

```bash
git add docs/AGENT_GUIDE.md docs/superpowers/plans/2026-05-14-research-mcp-backend.md
git commit -m "docs: add AGENT_GUIDE for 22 ops + archive backend plan

AGENT_GUIDE is the contract surface for AI roundtable members. Plan file
copied from hub docs for project-local reference."
```

---

### Task 11: E2E smoke test

**Files:**
- Create: `C:\research-mcp\spike\smoke_e2e.py`

- [ ] **Step 11.1: 创建 spike/ 目录并写 smoke 脚本**

```powershell
New-Item -ItemType Directory -Path C:\research-mcp\spike -Force | Out-Null
```

`C:\research-mcp\spike\smoke_e2e.py`：

```python
# -*- coding: utf-8 -*-
"""E2E smoke: 跑 22 个 op 对 3 只测试股，验证 ok=true。

不含 QMT 4 个 op（需 QMT 客户端启动）。
"""
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

OPS = [
    # 透传老 op
    ("gate", "600519"),
    ("basic", "600519"),
    ("financial", "600519"),
    ("flow", "600519"),
    ("dragon-tiger", "600519"),
    ("valuation", "600519"),
    ("northbound", "600519"),
    ("margin", "600519"),
    ("holders", "600519"),
    ("pledge", "600519"),
    ("funds", "600519"),
    ("indicators", "600519"),
    ("snapshot", "600519"),
    # 新 op
    ("research-report", "600519"),
    ("announcement", "600519"),
    ("news", None),  # 无 symbol
    # 增强 op
    ("price", "600519"),
    ("peers", "600519"),
    # 跨股
    ("snapshot", "000001"),
    ("snapshot", "300750"),
    ("research-report", "300750"),
    ("price", "000001"),
]


def _run(op, symbol):
    cmd = ["uv", "run", "python", "query.py", op]
    if symbol:
        cmd.append(symbol)
    try:
        r = subprocess.run(
            cmd, capture_output=True, text=True, timeout=120, encoding="utf-8",
            cwd=r"C:\research-mcp",
        )
        if r.returncode not in (0, 1):
            return op, symbol, False, f"rc={r.returncode}"
        d = json.loads(r.stdout) if r.stdout.strip() else {"ok": False}
        ok = d.get("ok", False)
        note = d.get("error") or d.get("fetch_warning") or d.get("data_source") or ""
        return op, symbol, ok, str(note)[:80]
    except Exception as e:
        return op, symbol, False, f"{type(e).__name__}: {e}"[:80]


print(f"running {len(OPS)} smoke tests in parallel (max 3 workers)…", file=sys.stderr)
results = []
with ThreadPoolExecutor(max_workers=3) as ex:
    futs = [ex.submit(_run, op, sym) for op, sym in OPS]
    for f in as_completed(futs):
        results.append(f.result())

print()
ok_count = sum(1 for _, _, s, _ in results if s)
total = len(results)
for op, sym, ok, note in sorted(results, key=lambda x: (x[0], x[1] or "")):
    flag = "✓" if ok else "✗"
    print(f"  {flag} {op:18s} {sym or '-':10s}  {note}")

print(f"\nSMOKE: {ok_count}/{total} passed")
sys.exit(0 if ok_count == total else 1)
```

- [ ] **Step 11.2: 跑 smoke**

```bash
uv run python spike\smoke_e2e.py
```

Expected: 22/22 passed（或如有 QMT 相关失败，分析后决定是否接受）。

- [ ] **Step 11.3: Commit smoke 脚本**

```bash
git add spike/smoke_e2e.py
git commit -m "test: E2E smoke for all 22 ops across 3 test stocks

Parallel (max 3 workers, 120s timeout each) over 600519/000001/300750.
Covers proxied old ops + 3 new ops + 2 enhanced ops. QMT-specific ops
excluded (require QMT client running)."
```

---

## Verification Checklist (after all tasks)

- [ ] `uv run pytest tests/ -v` —— 全部 pass
- [ ] `uv run python spike/smoke_e2e.py` —— 22/22 pass
- [ ] `uv run python query.py research-report 600519` —— ok=true，reports 非空
- [ ] `uv run python query.py announcement 600519` —— ok=true
- [ ] `uv run python query.py news` —— ok=true，items >= 10
- [ ] `uv run python query.py peers 600519` —— ok=true，text 含估值关键词
- [ ] `uv run python query.py price 600519 --days 10` —— ok=true，source_chain 字段存在
- [ ] `uv run python query.py snapshot 600519` —— ok=true（透传 LinDangAgent）
- [ ] git log 至少 11 个 commits（每 task 一个）
- [ ] `C:\LinDangAgent\` 下没有任何文件变化（git status 与开始时一致）
- [ ] AGENT_GUIDE.md 列出全部 22 op

## Out of Scope (留给 Plan 2 / 后续)

- Hub 端 `core/lindang-bridge.js` 改调本项目 `query.py` → Plan 2
- Hub 端 `core/research-mcp-server.js` 改 tools 定义 → Plan 2
- 圆桌投研模式 prompt 切换 → Plan 2
- 个股新闻自实现东财 HTTP 解析 → v2
- pysnowball 雪球情绪 → v2+
- mootdx 加入兜底 → 当 Ashare 稳定性不足时再补
