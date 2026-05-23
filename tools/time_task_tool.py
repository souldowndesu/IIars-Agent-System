"""
时间任务管理工具 + 获取当前时间工具
提供对 time_table.db 中 Agent 类型定时任务的 CRUD 操作，以及获取系统本地时间。
System 类型任务由 time_manager 内部管理，不暴露给 LLM。
"""
import sqlite3
import os
from typing import Optional
from datetime import datetime, timedelta
import calendar


# ---- 数据库路径 ----
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "database", "time_table.db")


# ---- _calculate_next_run ----
def _calculate_next_run(mode: str, trigger_expr: str, base_time: datetime = None) -> str:
    """计算下次执行时间，逻辑与 time_manager.TimeManager._calculate_next_run 一致"""
    if base_time is None:
        base_time = datetime.now()
    try:
        if mode == "none":
            # 已经是绝对时间 "YYYY-MM-DD HH:MM"
            return trigger_expr

        elif mode == "daily":
            hour, minute = map(int, trigger_expr.split(":"))
            target = base_time.replace(hour=hour, minute=minute, second=0, microsecond=0)
            if target <= base_time:
                target += timedelta(days=1)
            return target.strftime("%Y-%m-%d %H:%M")

        elif mode == "weekly":
            w_str, time_str = trigger_expr.split(" ")
            target_w = int(w_str)
            hour, minute = map(int, time_str.split(":"))
            target = base_time.replace(hour=hour, minute=minute, second=0, microsecond=0)

            days_ahead = target_w - target.isoweekday()
            if days_ahead < 0 or (days_ahead == 0 and target <= base_time):
                days_ahead += 7
            target += timedelta(days=days_ahead)
            return target.strftime("%Y-%m-%d %H:%M")

        elif mode == "monthly":
            d_str, time_str = trigger_expr.split(" ")
            target_d = int(d_str)
            hour, minute = map(int, time_str.split(":"))

            test_year = base_time.year
            test_month = base_time.month
            for _ in range(24):
                last_day_of_month = calendar.monthrange(test_year, test_month)[1]
                if target_d > 0:
                    actual_d = target_d
                else:
                    actual_d = last_day_of_month + target_d + 1
                if 1 <= actual_d <= last_day_of_month:
                    target = datetime(test_year, test_month, actual_d, hour, minute)
                    if target > base_time:
                        return target.strftime("%Y-%m-%d %H:%M")
                test_month += 1
                if test_month > 12:
                    test_month = 1
                    test_year += 1

            raise ValueError("在未来2年中找不到符合条件的月份")

    except Exception:
        return "2099-12-31 23:59"


# ---- Schema ----
TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "time_task",
        "description": (
            "管理 time_table.db 中的定时任务，以及获取当前系统时间。\n"
            "仅支持 Agent 类型任务的增删改查，System 任务只能查看不能修改。\n"
            "支持以下操作：\n"
            "  get_time: 获取当前本地系统日期和时间\n"
            "  list_tasks: 列出当前所有定时任务\n"
            "  add_agent_task: 添加一个新的 Agent 定时任务（支持单次和循环）\n"
            "  update_task: 修改指定任务（仅限 Agent 类型，不可修改 System 任务）\n"
            "  delete_task: 删除指定任务"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "description": "要执行的操作",
                    "enum": ["get_time", "list_tasks", "add_agent_task", "update_task", "delete_task"]
                },
                "trigger_time": {
                    "type": "string",
                    "description": (
                        "触发时间表达式。\n"
                        "- daily 模式: HH:MM，如 '08:30'\n"
                        "- weekly 模式: 周几 HH:MM，如 '1 08:00'（1=周一,7=周日）\n"
                        "- monthly 模式: 第几天 HH:MM，如 '1 08:00' 或 '-1 08:00'（-1 表示最后一天）\n"
                        "- none 模式: YYYY-MM-DD HH:MM 绝对时间\n"
                        "（add_agent_task 必填，update_task 可选）"
                    )
                },
                "task_info": {
                    "type": "string",
                    "description": "任务描述/提示词，即到时间后推送给 Agent 的消息内容（add_agent_task 必填，update_task 可选）"
                },
                "session_id": {
                    "type": "string",
                    "description": "目标会话 ID（add_agent_task 必填，update_task 可选）"
                },
                "session_type": {
                    "type": "string",
                    "description": "会话类型，如 main、compact 等，默认 main（可选）"
                },
                "is_recurring": {
                    "type": "boolean",
                    "description": "是否循环任务，true/false。不指定时默认 false（单次任务）（add_agent_task / update_task 可选）"
                },
                "recurrence_mode": {
                    "type": "string",
                    "description": "循环模式：'none'（不循环/绝对时间）、'daily'、'weekly'、'monthly'。添加循环任务时必须指定（add_agent_task / update_task 可选）",
                    "enum": ["none", "daily", "weekly", "monthly"]
                },
                "task_id": {
                    "type": "integer",
                    "description": "任务 ID（update_task / delete_task 必填）"
                }
            },
            "required": ["action"]
        }
    }
}


# ---- 获取当前时间 ----
def _get_current_time() -> str:
    """获取当前本地系统时间和日期，无参数。"""
    now = datetime.now().astimezone()
    tz = now.tzinfo
    tz_name = tz.tzname(now) if tz else "Unknown"
    utc_offset = now.strftime("%z")

    weekday_cn = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]
    weekday = weekday_cn[now.weekday()]

    return (
        f"📅 日期: {now.strftime('%Y-%m-%d')} ({weekday})\n"
        f"⏰ 时间: {now.strftime('%H:%M:%S')}\n"
        f"🌍 时区: {tz_name} (UTC{utc_offset})"
    )


# ---- 数据库辅助 ----
def _get_db() -> sqlite3.Connection:
    """获取数据库连接"""
    return sqlite3.connect(DB_PATH)


# ---- 循环模式中文显示 ----
_MODE_LABELS = {
    "none": "不循环",
    "daily": "每天",
    "weekly": "每周",
    "monthly": "每月",
}


# ---- 业务操作 ----
def _list_tasks() -> str:
    """列出所有定时任务，返回格式化字符串"""
    with _get_db() as db:
        cursor = db.execute(
            "SELECT id, task_type, is_recurring, recurrence_mode, trigger_time, next_run_time, "
            "action_cmd, task_info, session_id, session_type, triggered "
            "FROM time_table ORDER BY trigger_time ASC"
        )
        tasks = cursor.fetchall()

    if not tasks:
        return "📭 当前没有任何定时任务。"

    lines = ["📋 当前定时任务列表：", "─" * 65]
    for t in tasks:
        task_id, task_type, is_recurring, recurrence_mode, trigger_time, next_run_time, \
            action_cmd, task_info, session_id, session_type, triggered = t
        status = "✅已触发" if triggered else "⏳待触发"
        mode_label = _MODE_LABELS.get(recurrence_mode or "none", recurrence_mode or "none")
        recur_label = f" 🔄{mode_label}" if is_recurring else " 🔂单次"
        next_label = f" | 下次: {next_run_time}" if next_run_time else ""

        if task_type == "system":
            lines.append(
                f"  [{task_id}] 🖥️ SYSTEM  | ⏰ {trigger_time}{next_label} | {action_cmd} | {status}{recur_label}"
            )
        else:
            info_preview = (task_info or "")[:40]
            lines.append(
                f"  [{task_id}] 🤖 AGENT   | ⏰ {trigger_time}{next_label} | 会话:{session_id}({session_type}) | {status}{recur_label}\n"
                f"         任务: {info_preview}{'...' if len(task_info or '') > 40 else ''}"
            )
    lines.append("─" * 65)
    lines.append(f"共 {len(tasks)} 个任务")
    return "\n".join(lines)


def _add_agent_task(trigger_time: str, task_info: str, session_id: str,
                    session_type: str = "main",
                    is_recurring: bool = False,
                    recurrence_mode: str = "none") -> str:
    """添加一个 Agent 类型的定时任务"""
    is_rec_int = 1 if is_recurring else 0
    next_run = _calculate_next_run(recurrence_mode, trigger_time)

    with _get_db() as db:
        db.execute(
            "INSERT INTO time_table (task_type, is_recurring, recurrence_mode, trigger_time, "
            "next_run_time, action_cmd, task_info, session_id, session_type, triggered) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("agent", is_rec_int, recurrence_mode, trigger_time, next_run,
             "agent", task_info, session_id, session_type, 0)
        )
        db.commit()

    mode_label = _MODE_LABELS.get(recurrence_mode, recurrence_mode)
    recur_desc = f"（{mode_label}）" if is_recurring else "（单次）"
    return (
        f"✅ 已添加 Agent 任务{recur_desc}：⏰ {trigger_time}\n"
        f"   📆 下次执行: {next_run} → 会话 {session_id}({session_type})\n"
        f"   📝 {task_info[:50]}{'...' if len(task_info) > 50 else ''}"
    )


def _update_task(task_id: int, trigger_time: Optional[str] = None, task_info: Optional[str] = None,
                 session_id: Optional[str] = None, session_type: Optional[str] = None,
                 is_recurring: Optional[bool] = None,
                 recurrence_mode: Optional[str] = None) -> str:
    """修改指定任务，仅允许修改 Agent 类型任务"""
    with _get_db() as db:
        # 检查任务是否存在及其类型
        cursor = db.execute(
            "SELECT id, task_type, recurrence_mode, trigger_time FROM time_table WHERE id = ?",
            (task_id,)
        )
        row = cursor.fetchone()
        if not row:
            return f"❌ 未找到任务 ID: {task_id}"

        _, task_type, current_rec_mode, current_trigger_time = row
        if task_type == "system":
            return f"❌ 禁止修改 System 类型任务（ID: {task_id}）。System 任务由系统内部管理。"

        # 构建动态 UPDATE 语句
        updates = {}
        if trigger_time is not None:
            updates["trigger_time"] = trigger_time
        if task_info is not None:
            updates["task_info"] = task_info
        if session_id is not None:
            updates["session_id"] = session_id
        if session_type is not None:
            updates["session_type"] = session_type
        if is_recurring is not None:
            updates["is_recurring"] = 1 if is_recurring else 0
        if recurrence_mode is not None:
            updates["recurrence_mode"] = recurrence_mode

        if not updates:
            return f"⚠️ 未提供任何要修改的字段（task_id={task_id}），任务未变更。"

        # 如果有 trigger_time 或 recurrence_mode 变化，重新计算 next_run_time
        final_trigger = updates.get("trigger_time", current_trigger_time)
        final_mode = updates.get("recurrence_mode", current_rec_mode) or "none"
        updates["next_run_time"] = _calculate_next_run(final_mode, final_trigger)

        set_clause = ", ".join(f"{k} = ?" for k in updates.keys())
        values = list(updates.values()) + [task_id]
        db.execute(f"UPDATE time_table SET {set_clause} WHERE id = ?", values)
        db.commit()

    fields_desc = ", ".join(f"{k}={v}" for k, v in updates.items())
    return f"✅ 已更新任务 ID {task_id}：{fields_desc}"


def _delete_task(task_id: int) -> str:
    """删除指定任务"""
    with _get_db() as db:
        cursor = db.execute("SELECT id, task_type, trigger_time, task_info FROM time_table WHERE id = ?", (task_id,))
        row = cursor.fetchone()
        if not row:
            return f"❌ 未找到任务 ID: {task_id}"

        _, task_type, trigger_time, task_info = row
        db.execute("DELETE FROM time_table WHERE id = ?", (task_id,))
        db.commit()

    type_label = "System" if task_type == "system" else "Agent"
    return f"🗑️ 已删除 [{type_label}] 任务 ID {task_id}：⏰ {trigger_time} | {(task_info or '')[:50]}"


# ---- 主执行入口 ----
async def execute(action: str, trigger_time: str = None, task_info: str = None,
                  session_id: str = None, session_type: str = "main",
                  is_recurring: bool = False,
                  recurrence_mode: str = "none",
                  task_id: int = None):
    """
    执行时间任务管理操作或获取时间操作
    """
    action = action.strip()

    if action == "get_time":
        return _get_current_time()

    elif action == "list_tasks":
        return _list_tasks()

    elif action == "add_agent_task":
        if not trigger_time:
            return "❌ add_agent_task 需要 trigger_time 参数"
        if not task_info:
            return "❌ add_agent_task 需要 task_info 参数（任务描述/提示词）"
        if not session_id:
            return "❌ add_agent_task 需要 session_id 参数（目标会话 ID）"
        return _add_agent_task(
            trigger_time, task_info, session_id,
            session_type or "main",
            is_recurring=is_recurring if is_recurring else False,
            recurrence_mode=recurrence_mode or "none"
        )

    elif action == "update_task":
        if task_id is None:
            return "❌ update_task 需要 task_id 参数"
        kwargs = {}
        if trigger_time is not None:
            kwargs["trigger_time"] = trigger_time
        if task_info is not None:
            kwargs["task_info"] = task_info
        if session_id is not None:
            kwargs["session_id"] = session_id
        if session_type is not None:
            kwargs["session_type"] = session_type
        if is_recurring is not None:
            kwargs["is_recurring"] = is_recurring
        if recurrence_mode is not None:
            kwargs["recurrence_mode"] = recurrence_mode
        return _update_task(task_id, **kwargs)

    elif action == "delete_task":
        if task_id is None:
            return "❌ delete_task 需要 task_id 参数"
        return _delete_task(task_id)

    else:
        return f"❌ 未知操作: {action}，支持的操作：get_time, list_tasks, add_agent_task, update_task, delete_task"