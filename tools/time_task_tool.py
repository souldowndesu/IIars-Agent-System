"""
时间任务管理工具
提供对 time_table.db 中 Agent 类型定时任务的 CRUD 操作。
System 类型任务由 time_manager 内部管理，不暴露给 LLM。
"""
import sqlite3
import os
from typing import Optional


# ---- 数据库路径 ----
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "database", "time_table.db")


# ---- Schema ----
TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "time_task",
        "description": (
            "管理 time_table.db 中的定时任务。\n"
            "仅支持 Agent 类型任务的增删改查，System 任务只能查看不能修改。\n"
            "支持以下操作：\n"
            "  list_tasks: 列出当前所有定时任务\n"
            "  add_agent_task: 添加一个新的 Agent 定时任务\n"
            "  update_task: 修改指定任务（仅限 Agent 类型，不可修改 System 任务）\n"
            "  delete_task: 删除指定任务"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "description": "要执行的操作",
                    "enum": ["list_tasks", "add_agent_task", "update_task", "delete_task"]
                },
                "trigger_time": {
                    "type": "string",
                    "description": "触发时间，格式 HH:MM（add_agent_task 必填，update_task 可选）"
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
                "task_id": {
                    "type": "integer",
                    "description": "任务 ID（update_task / delete_task 必填）"
                }
            },
            "required": ["action"]
        }
    }
}


# ---- 数据库辅助 ----
def _get_db() -> sqlite3.Connection:
    """获取数据库连接"""
    return sqlite3.connect(DB_PATH)


# ---- 业务操作 ----
def _list_tasks() -> str:
    """列出所有定时任务，返回格式化字符串"""
    with _get_db() as db:
        cursor = db.execute(
            "SELECT id, task_type, trigger_time, action_cmd, task_info, session_id, session_type, triggered "
            "FROM time_table ORDER BY trigger_time ASC"
        )
        tasks = cursor.fetchall()

    if not tasks:
        return "📭 当前没有任何定时任务。"

    lines = ["📋 当前定时任务列表：", "─" * 55]
    for t in tasks:
        task_id, task_type, trigger_time, action_cmd, task_info, session_id, session_type, triggered = t
        status = "✅已触发" if triggered else "⏳待触发"
        if task_type == "system":
            lines.append(
                f"  [{task_id}] 🖥️ SYSTEM  | ⏰ {trigger_time} | {action_cmd} | {status}"
            )
        else:
            info_preview = (task_info or "")[:40]
            lines.append(
                f"  [{task_id}] 🤖 AGENT   | ⏰ {trigger_time} | 会话:{session_id}({session_type}) | {status}\n"
                f"         任务: {info_preview}{'...' if len(task_info or '') > 40 else ''}"
            )
    lines.append("─" * 55)
    lines.append(f"共 {len(tasks)} 个任务")
    return "\n".join(lines)


def _add_agent_task(trigger_time: str, task_info: str, session_id: str, session_type: str = "main") -> str:
    """添加一个 Agent 类型的定时任务"""
    with _get_db() as db:
        db.execute(
            "INSERT INTO time_table (task_type, trigger_time, action_cmd, task_info, session_id, session_type) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            ("agent", trigger_time, "agent", task_info, session_id, session_type)
        )
        db.commit()
    return f"✅ 已添加 Agent 任务：⏰ {trigger_time} → 会话 {session_id}({session_type}) | {task_info[:50]}"


def _update_task(task_id: int, trigger_time: Optional[str] = None, task_info: Optional[str] = None,
                 session_id: Optional[str] = None, session_type: Optional[str] = None) -> str:
    """修改指定任务，仅允许修改 Agent 类型任务"""
    with _get_db() as db:
        # 检查任务是否存在及其类型
        cursor = db.execute("SELECT id, task_type FROM time_table WHERE id = ?", (task_id,))
        row = cursor.fetchone()
        if not row:
            return f"❌ 未找到任务 ID: {task_id}"

        _, task_type = row
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

        if not updates:
            return f"⚠️ 未提供任何要修改的字段（task_id={task_id}），任务未变更。"

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
                  task_id: int = None):
    """
    执行时间任务管理操作
    """
    action = action.strip()

    if action == "list_tasks":
        return _list_tasks()

    elif action == "add_agent_task":
        if not trigger_time:
            return "❌ add_agent_task 需要 trigger_time 参数（格式 HH:MM）"
        if not task_info:
            return "❌ add_agent_task 需要 task_info 参数（任务描述/提示词）"
        if not session_id:
            return "❌ add_agent_task 需要 session_id 参数（目标会话 ID）"
        return _add_agent_task(trigger_time, task_info, session_id, session_type or "main")

    elif action == "update_task":
        if task_id is None:
            return "❌ update_task 需要 task_id 参数"
        # 过滤掉 None 值，避免传入不需要修改的字段
        kwargs = {}
        if trigger_time is not None:
            kwargs["trigger_time"] = trigger_time
        if task_info is not None:
            kwargs["task_info"] = task_info
        if session_id is not None:
            kwargs["session_id"] = session_id
        if session_type is not None:
            kwargs["session_type"] = session_type
        return _update_task(task_id, **kwargs)

    elif action == "delete_task":
        if task_id is None:
            return "❌ delete_task 需要 task_id 参数"
        return _delete_task(task_id)

    else:
        return f"❌ 未知操作: {action}，支持的操作：list_tasks, add_agent_task, update_task, delete_task"