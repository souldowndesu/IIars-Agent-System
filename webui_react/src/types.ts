// types.ts
export const BASE_URL = 'http://127.0.0.1:8001';

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

export interface ServerEvent {
  event: 'start' | 'content' | 'tool_status' | 'end' | 'error' | 'interrupt';
  data?: string;
  status?: 'start' | 'result';
  name?: string;
  executed_well?: boolean;
  result_data?: string;
  tool_args?: string;
  error_msg?: string;
}

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