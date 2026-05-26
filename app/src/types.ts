// src/types.ts
export const BASE_URL = 'http://100.80.140.53:8001'; // 换成你电脑的 Tailscale IP

export type Role = 'user' | 'assistant' | 'tool' | 'system';

export interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  time: string;
  isHtml?: boolean;
  name?: string; 
  tool_args?: string;
  tool_call_id?: string;
  status?: 'running' | 'success' | 'error'; 
}

export type ServerEvent =
  | { event: 'start' }
  | { event: 'content'; data?: string }
  | { event: 'tool_status'; status: 'start'; name: string }
  | { event: 'tool_status'; status: 'result'; name: string; executed_well: boolean; tool_args?: string; result_data?: string }
  | { event: 'end' }
  | { event: 'interrupt' }
  | { event: 'error'; error_msg: string };

export interface TimeTask {
  id: number;
  task_type: 'system' | 'agent';
  is_recurring: boolean;
  recurrence_mode: 'none' | 'daily' | 'weekly' | 'monthly';
  trigger_time: string;
  next_run_time: string;
  action_cmd: string;
  task_info: string;
  session_id: string;
  session_type: string;
  triggered: boolean;
}