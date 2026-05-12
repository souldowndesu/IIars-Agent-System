from chat_logic import ToolRegistry
import os

main_registry = ToolRegistry()

current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(current_dir)
tools_dir = os.path.join(project_root, "tools")

main_registry.register(tools_path=tools_dir)