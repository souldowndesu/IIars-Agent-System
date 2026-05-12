from src.chat_logic import ToolRegistry
import os

main_registry = ToolRegistry()

project_root = os.path.dirname(os.path.abspath(__file__))
tools_dir = os.path.join(project_root, "tools")

main_registry.register(tools_path=tools_dir)