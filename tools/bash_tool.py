import httpx

TOOL_SCHEMA = {
            "type": "function",
            "function": {
                "name": "execute_bash",
                "description": (
                    "Execute a bash command in the WSL2 Ubuntu environment. "
                    "CRITICAL RULES: "
                    "1. Windows C drive is mounted at '/mnt/c/'. Translate paths accordingly. "
                    "2. Do NOT use interactive commands (like vim, nano, top) that require human input. "
                    "3. For confirmations, always append '-y' (e.g., 'apt-get install -y')."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string", 
                            "description": "The complete bash command to execute."
                        }
                    },
                    "required": ["command"]
                }
            }
        }

async def execute(command: str):
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.post("http://127.0.0.1:8000/execute",
                                     json={"command": command, "timeout":30},
                                     timeout=35.0)
            result_json = resp.json()
            formatted_result = f"[EXIT_CODE: {result_json['exit_code']}]\n{result_json['output']}"
            return formatted_result
        except httpx.TimeoutException:
            return "Error: HTTP Request to WSL server timed out."
        except Exception as e:
            return f"Error connecting to WSL execution server: {str(e)}"