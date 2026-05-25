# 🌳 Skill Tree — 工具技能树

本文件是 my-agent 系统的**工具技能树索引**。它列出了所有可用的工具及其功能描述，供 LLM 在运行时通过 `tool_manager` 按需加载。

> **工作流**：LLM 启动后应首先调用 `tool_manager` 的 `load_skill_tree` action 加载本文件，了解有哪些工具可用。随后使用 `tool_manager` 的 `add` action 按需加载具体工具，使用 `delete` 卸载不再需要的工具。

---

## 🔧 工具管理器 (tool_manager)

**此工具默认已加载，无需手动 add。同样的还有bash_tool**

| 属性 | 值 |
|------|-----|
| 函数名 | `tool_manager` |
| 文件 | `tools/tool_manager.py` |
| 类型 | 系统管理工具（已内置） |

**操作列表：**

| action | 说明 | targets 参数 |
|--------|------|-------------|
| `load_skill_tree` | 加载本技能树文件，获取所有工具概览 | `[]`（空数组） |
| `load_skill` | 加载指定 skill/md 文件，将其内容注入当前对话上下文 | `["skills/skill_tree.md"]` |
| `list_local` | 扫描本地 tools 目录，列出所有可用的工具文件名 | `[]`（空数组） |
| `add` | 按文件名（不含 .py 后缀）加载一个或多个工具 | `["time_tool", "bash_tool"]` |
| `delete` | 卸载一个或多个已加载的工具 | `["time_tool"]` |
| `check` | 查看当前已挂载的工具列表 | `[]`（空数组） |

**使用建议：**
- 启动时先 `load_skill_tree` 了解工具全貌
- 根据用户意图用 `add` 加载所需工具
- 不需要的工具可用 `delete` 卸载以节省上下文
- 不确定有哪些工具可用时，用 `list_local` 扫描本地磁盘

---

## 📦 可用工具清单

以下是 tools/ 目录下所有符合协议（包含 `TOOL_SCHEMA` + `execute`）的工具。

### 1. bash_tool — Bash 命令执行,此工具也已经默认加载了

| 属性 | 值 |
|------|-----|
| 函数名 | `execute_bash` |
| 文件 | `tools/bash_tool.py` |
| add 名称 | `bash_tool` |

**功能**：在 WSL2 Ubuntu 环境中执行 Bash 命令。通过 HTTP 转发到本地 WSL 执行服务器（`127.0.0.1:8000`）。

**参数**：
- `command` (string, 必填) — 完整的 Bash 命令

**使用场景**：需要执行 Linux 命令行操作时使用，例如文件操作、安装软件、运行脚本等。

**注意事项**：
- Windows C 盘路径需转换为 `/mnt/c/...`
- 不要执行交互式命令（如 vim、nano、top）
- 需要确认的命令应附加 `-y` 标志（如 `apt-get install -y`）

---

### 2. time_tool — 获取当前时间

| 属性 | 值 |
|------|-----|
| 函数名 | `get_current_time` |
| 文件 | `tools/time_tool.py` |
| add 名称 | `time_tool` |

**功能**：获取当前本地系统日期和时间，无参数。返回日期、时间、星期、Unix 时间戳和 UTC 偏移量。

**参数**：无

**使用场景**：需要知道当前时间、日期或星期几时使用。

---

### 3. time_task_tool — 定时任务管理 + 获取时间

| 属性 | 值 |
|------|-----|
| 函数名 | `time_task` |
| 文件 | `tools/time_task_tool.py` |
| add 名称 | `time_task_tool` |

**功能**：管理 `database/time_table.db` 中的定时任务。既包含获取时间功能，也包含任务 CRUD 操作。仅支持新增/修改/删除 Agent 类型任务，System 任务只能查看。

**参数**：
- `action` (string, 必填) — 操作类型
- 其他参数见下表

**action 类型：**

| action | 说明 | 额外参数 |
|--------|------|---------|
| `get_time` | 获取当前系统时间（同 time_tool） | 无 |
| `list_tasks` | 列出所有定时任务 | 无 |
| `add_agent_task` | 添加 Agent 定时任务 | `trigger_time`, `task_info`, `session_id`, `session_type`(可选), `is_recurring`(可选), `recurrence_mode`(可选) |
| `update_task` | 修改指定任务（仅 Agent 类型） | `task_id`(必填), 其他字段可选 |
| `delete_task` | 删除指定任务 | `task_id`(必填) |

**循环模式 (recurrence_mode)：**
- `none` — 不循环 / 绝对时间 (`YYYY-MM-DD HH:MM`)
- `daily` — 每天 (`HH:MM`)
- `weekly` — 每周 (`周几 HH:MM`，1=周一, 7=周日)
- `monthly` — 每月 (`第几天 HH:MM`，-1=最后一天)

**使用场景**：设置提醒、定时推送消息、定时执行任务等。

**注意事项**：如果只需要获取时间，也可以使用更轻量的 `time_tool`。

---

### 4. ubaa_tool — UBAA 北航校园服务

| 属性 | 值 |
|------|-----|
| 函数名 | `ubaa_api` |
| 文件 | `tools/ubaa_tool.py` |
| add 名称 | `ubaa_tool` |

**功能**：通过 UBAA 网关访问北航校园服务 API。登录凭据从 `.env` 环境变量自动读取，对 LLM 透明。

**参数**：
- `action` (string, 必填) — 操作类型
- `params` (object, 可选) — 各操作所需的额外参数

**action 类型分类：**

**🔐 认证：**
| action | 说明 |
|--------|------|
| `login` | 手动登录（一般无需调用，系统自动处理） |
| `logout` | 退出登录 |
| `status` | 查看登录状态 |
| `announcement` | 获取系统公告 |

**📚 博雅课程 (BYKC)：**
| action | 说明 | params |
|--------|------|--------|
| `bykc_profile` | 查看博雅课程档案 | 无 |
| `bykc_courses` | 浏览可选课程列表 | `page`, `size`, `all` |
| `bykc_chosen` | 查看已选课程 | 无 |
| `bykc_detail` | 查看课程详情 | `course_id` |
| `bykc_select` | 选课 | `course_id` |
| `bykc_deselect` | 退课 | `course_id` |
| `bykc_sign` | 签到/签退 | `course_id`, `sign_type`(1=签到/2=签退), `lat`, `lng` |
| `bykc_statistics` | 查看统计数据 | 无 |

**📋 课堂签到：**
| action | 说明 | params |
|--------|------|--------|
| `signin_today` | 查看今日待签到课程 | 无 |
| `signin_do` | 执行课堂签到 | `course_id` |

**📅 课表：**
| action | 说明 | params |
|--------|------|--------|
| `schedule_today` | 查看今日课程 | 无 |
| `schedule_terms` | 获取可用学期列表 | 无 |
| `schedule_weeks` | 获取指定学期教学周 | `term_code` |
| `schedule_week` | 获取指定周课表 | `term_code`, `week` |

**📊 考试/成绩：**
| action | 说明 | params |
|--------|------|--------|
| `exam_list` | 查看考试安排 | `term_code` |
| `grade_list` | 查看成绩 | `term_code` |

**🏫 空间管理：**
| action | 说明 | params |
|--------|------|--------|
| `classroom` | 查询空闲教室 | `xqid`(1=学院路/2=沙河), `date`(YYYY-MM-DD) |

**📝 作业查询 (SPOC)：**
| action | 说明 | params |
|--------|------|--------|
| `spoc_assignments` | 获取 SPOC 作业列表 | 无 |
| `spoc_detail` | 获取 SPOC 作业详情 | `assignment_id` |

**📝 作业查询 (希冀/Judge)：**
| action | 说明 | params |
|--------|------|--------|
| `judge_assignments` | 获取希冀作业列表 | `include_expired`, `skip_course_ids` |
| `judge_detail` | 获取希冀作业详情 | `course_id`, `assignment_id` |

**🏟️ 场馆预约：**
| action | 说明 | params |
|--------|------|--------|
| `cgyy_sites` | 获取可预约场馆列表 | 无 |
| `cgyy_orders` | 查看预约记录 | `page`, `size` |

**⭐ 教学评价：**
| action | 说明 | params |
|--------|------|--------|
| `evaluation_list` | 查看待评价列表 | 无 |
| `evaluation_submit` | 提交教学评价 | `courses` |

**使用场景**：用户需要查看北航课程、选课、签到、查成绩、查课表、查作业等校园服务时使用。

**注意事项**：
- 学期代码 (`term_code`) 需先通过 `schedule_terms` 获取
- 登录凭据在 `.env` 中配置 `UBAA_USERNAME` / `UBAA_PASSWORD`，无需手动传入

---

## 🚀 推荐加载策略

### 默认/通用场景
加载 `time_tool` + `time_task_tool`，提供时间和任务管理能力。

### 开发/运维场景
加载 `bash_tool`，用于执行 WSL 命令。

### 北航校园场景
加载 `ubaa_tool` + `time_tool`，提供校园服务查询和时间支持。

### 全部加载（不推荐，令牌消耗大）
```json
{
  "action": "add",
  "targets": ["bash_tool", "time_tool", "time_task_tool", "ubaa_tool"]
}
```

---

## ⚠️ 注意事项

1. **命名规范**：`add`/`delete` 操作使用文件名（不含 `.py` 后缀），如 `time_tool`，而非函数名 `get_current_time`。
2. **按需加载**：为节省 token 消耗，建议只加载当前对话必需的工具。
3. **冲突处理**：`time_task_tool` 和 `time_tool` 都提供获取时间功能，一般加载其中一个即可；如需定时任务管理则加载 `time_task_tool`。
4. **skill 加载**：`load_skill` 可用于加载任意 `.md` 文件，将其内容作为上下文注入对话。`load_skill_tree` 是快捷方式，自动加载 `skills/skill_tree.md`。