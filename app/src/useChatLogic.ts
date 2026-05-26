// src/useChatLogic.ts
import { useState, useRef, useCallback, useEffect } from 'react';
import EventSource from 'react-native-sse'; 
import AsyncStorage from '@react-native-async-storage/async-storage'; 
import { BASE_URL } from './types';
import type { Message, ServerEvent } from './types';

// 【防红屏补丁】生成绝对唯一的 ID，彻底抛弃单纯的 Date.now()
const generateUUID = () => `${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

export function useChatLogic() {
  const [sessions, setSessions] = useState<Record<string, Message[]>>({ main: [] });
  const [currentSessionId, setCurrentSessionId] = useState<string>('main');
  const [generatingStates, setGeneratingStates] = useState<Record<string, boolean>>({});
  const [connectionStates, setConnectionStates] = useState<Record<string, 'connected' | 'disconnected' | 'connecting'>>({});
  
  const eventSourcesRef = useRef<Record<string, any>>({});

  useEffect(() => {
    AsyncStorage.getItem('chatSessions').then(local => {
      if (local) {
        const parsed = JSON.parse(local);
        Object.keys(parsed).forEach(k => { if (k.startsWith('compact__')) delete parsed[k]; });
        setSessions(parsed);
      }
    }).catch(console.error);

    // 【防套娃补丁】组件卸载时，强制杀掉所有底层的 SSE 幽灵连接
    return () => {
      Object.values(eventSourcesRef.current).forEach(es => {
        if (es) es.close();
      });
    };
  }, []);

  const saveLocal = async (newSessions: Record<string, Message[]>) => {
    const storageData = { ...newSessions };
    Object.keys(storageData).forEach(k => { if (k.startsWith('compact__')) delete storageData[k]; });
    setSessions(newSessions); 
    await AsyncStorage.setItem('chatSessions', JSON.stringify(storageData));
  };

  const getBackendParams = (frontendId: string) => {
    if (frontendId.startsWith('compact__')) return { backendId: frontendId.replace('compact__', ''), backendType: 'compact' };
    if (frontendId.startsWith('temp-')) return { backendId: frontendId, backendType: 'temp' };
    if (frontendId === 'main') return { backendId: 'main', backendType: 'main' };
    if (frontendId.includes('_')) return { backendId: frontendId, backendType: frontendId.split('_')[0] };
    return { backendId: frontendId, backendType: 'chat' };
  };

  const syncHistory = useCallback(async (frontendId: string) => {
    if (frontendId.startsWith('compact__')) return; 
    try {
      const { backendId, backendType } = getBackendParams(frontendId);
      const res = await fetch(`${BASE_URL}/get-history?session_id=${backendId}&session_type=${backendType}`);
      if (!res.ok) return;
      
      const rawText = await res.text();
      if (!rawText) return;
      const data = JSON.parse(rawText);
      
      if (data.status === 'ok' && data.messages) {
        let lastToolCalls: any[] = []; 
        const formatted = data.messages.map((m: any, i: number) => {
          if (m.role === 'assistant' && m.tool_calls) lastToolCalls = m.tool_calls;
          if (m.role === 'tool') {
            let args = '{}';
            if (Array.isArray(lastToolCalls)) {
              const tc = lastToolCalls.find(t => t.id === m.tool_call_id || (t.function && t.function.name === m.name));
              if (tc && tc.function && tc.function.arguments) args = tc.function.arguments;
            }
            return { ...m, id: generateUUID(), tool_args: args, status: 'success' };
          }
          return { ...m, id: generateUUID() };
        }) as Message[];

        setSessions(prev => {
          const newSessions = { ...prev, [frontendId]: formatted };
          const storageData = { ...newSessions };
          Object.keys(storageData).forEach(k => { if (k.startsWith('compact__')) delete storageData[k]; });
          AsyncStorage.setItem('chatSessions', JSON.stringify(storageData)).catch(console.error);
          return newSessions;
        });
      }
    } catch (e) {
      console.error('History sync failed:', e);
    }
  }, []);

  // 【核心状态机补丁】彻底重构事件处理机制
  const handleServerEvent = useCallback((payload: ServerEvent, frontendId: string) => {
    setSessions(prev => {
      const sessionMsgs = prev[frontendId] || [];
      const newMsgs = [...sessionMsgs];
      const genId = `gen_${frontendId}`;

      switch (payload.event) {
        case 'start':
          setGeneratingStates(s => ({ ...s, [frontendId]: true }));
          // 强制清理可能残留的同名 ID
          newMsgs.forEach(m => { if (m.id === genId) m.id = `locked_${generateUUID()}`; });
          newMsgs.push({ id: genId, role: 'assistant', content: '', time: new Date().toISOString() });
          break;

        case 'content':
          // 绝对精准匹配最后一个消息，防止分裂
          const targetIdx = newMsgs.findIndex(m => m.id === genId);
          if (targetIdx !== -1) {
            newMsgs[targetIdx] = { ...newMsgs[targetIdx], content: newMsgs[targetIdx].content + (payload.data || '') };
          } else {
            newMsgs.push({ id: genId, role: 'assistant', content: payload.data || '', time: new Date().toISOString() });
          }
          break;

        case 'tool_status':
          if (payload.status === 'start') {
            // 工具开始时，隐藏之前可能产生的大模型空思考泡泡
            const lastM = newMsgs[newMsgs.length - 1];
            if (lastM && lastM.role === 'assistant' && lastM.id === genId && !lastM.content.trim()) {
              newMsgs.pop();
            } else {
              newMsgs.forEach(m => { if (m.id === genId) m.id = `locked_${generateUUID()}`; });
            }
            newMsgs.push({ id: `tool_${generateUUID()}`, role: 'tool', content: '', name: payload.name, status: 'running', time: new Date().toISOString() });
          } else if (payload.status === 'result') {
            // 倒序查找最近的一个运行中工具，精准替换状态
            const toolIndex = newMsgs.findLastIndex(m => m.role === 'tool' && m.name === payload.name && m.status === 'running');
            if (toolIndex !== -1) {
              newMsgs[toolIndex] = { ...newMsgs[toolIndex], status: payload.executed_well ? 'success' : 'error', tool_args: payload.tool_args, content: payload.result_data || '无返回结果' };
            } else {
              // 容错：如果没找到 running 状态，直接新建一个结果气泡
              newMsgs.push({ id: `tool_${generateUUID()}`, role: 'tool', name: payload.name, status: payload.executed_well ? 'success' : 'error', tool_args: payload.tool_args, content: payload.result_data || '无返回结果', time: new Date().toISOString() });
            }
          }
          break;

        case 'end':
        case 'interrupt':
        case 'error':
          setGeneratingStates(s => ({ ...s, [frontendId]: false }));
          
          // 封口操作：将 genId 转化为永久 UUID，彻底防止 Key 冲突
          const finalizeIdx = newMsgs.findIndex(m => m.id === genId);
          if (finalizeIdx !== -1) newMsgs[finalizeIdx].id = `msg_${generateUUID()}`;

          if (payload.event === 'error') newMsgs.push({ id: `err_${generateUUID()}`, role: 'system', content: `错误: ${payload.error_msg}`, time: new Date().toISOString() });
          else if (payload.event === 'interrupt') newMsgs.push({ id: `int_${generateUUID()}`, role: 'system', content: `⏹ 生成已终止`, time: new Date().toISOString() });
          
          if (payload.event === 'end' && frontendId.startsWith('compact__')) {
            const origId = frontendId.replace('compact__', '');
            fetch(`${BASE_URL}/cmd?session_id=${origId}&session_type=main&cmd=refresh`, { method: 'POST' }).then(() => syncHistory(origId));
          }
          break;
      }

      const storageData = { ...prev, [frontendId]: newMsgs };
      Object.keys(storageData).forEach(k => { if (k.startsWith('compact__')) delete storageData[k]; });
      AsyncStorage.setItem('chatSessions', JSON.stringify(storageData)).catch(console.error);
      
      return { ...prev, [frontendId]: newMsgs };
    });
  }, [syncHistory]);

  const connectSSE = useCallback((frontendId: string) => {
    // 【防套娃补丁】在建立新连接前，无条件掐死之前的旧连接！
    if (eventSourcesRef.current[frontendId]) {
      eventSourcesRef.current[frontendId].close();
      delete eventSourcesRef.current[frontendId];
    }
    
    setConnectionStates(prev => ({ ...prev, [frontendId]: 'connecting' }));
    const { backendId, backendType } = getBackendParams(frontendId);
    
    const es = new EventSource(`${BASE_URL}/stream?session_id=${backendId}&session_type=${backendType}`);
    eventSourcesRef.current[frontendId] = es;

    es.addEventListener('open', () => setConnectionStates(prev => ({ ...prev, [frontendId]: 'connected' })));
    es.addEventListener('message', (e: any) => { 
      if (e.data) {
        try { handleServerEvent(JSON.parse(e.data), frontendId); } 
        catch (err) { console.error("JSON Parse Error:", err); }
      }
    });
    es.addEventListener('error', () => {
      setConnectionStates(prev => ({ ...prev, [frontendId]: 'disconnected' }));
      es.close();
      delete eventSourcesRef.current[frontendId];
    });
  }, [handleServerEvent]);

  const disconnectSSE = useCallback((frontendId: string) => {
    if (eventSourcesRef.current[frontendId]) {
      eventSourcesRef.current[frontendId].close();
      delete eventSourcesRef.current[frontendId];
      setConnectionStates(prev => ({ ...prev, [frontendId]: 'disconnected' }));
    }
  }, []);

  const switchSession = useCallback(async (frontendId: string) => {
    setCurrentSessionId(frontendId);
    await syncHistory(frontendId);
    connectSSE(frontendId);
    if (!frontendId.startsWith('compact__')) {
      const { backendId, backendType } = getBackendParams(frontendId);
      fetch(`${BASE_URL}/cmd?session_id=${backendId}&session_type=${backendType}&cmd=refresh`, { method: 'POST' }).catch(() => {});
    }
  }, [syncHistory, connectSSE]);

  const sendMessage = async (text: string) => {
    if (!text.trim() || generatingStates[currentSessionId]) return;
    const userMsg: Message = { id: `usr_${generateUUID()}`, role: 'user', content: text, time: new Date().toISOString() };
    saveLocal({ ...sessions, [currentSessionId]: [...(sessions[currentSessionId] || []), userMsg] });

    try {
      const { backendId, backendType } = getBackendParams(currentSessionId);
      await fetch(`${BASE_URL}/str-input?session_id=${backendId}&session_type=${backendType}&user_input=${encodeURIComponent(text)}`, { method: 'POST' });
    } catch (e) { console.error('Send failed', e); }
  };

  const interrupt = async () => {
    const { backendId, backendType } = getBackendParams(currentSessionId);
    await fetch(`${BASE_URL}/cmd?session_id=${backendId}&session_type=${backendType}&cmd=interrupt`, { method: 'POST' });
  };

  const compactMemory = async () => {
    const { backendId } = getBackendParams(currentSessionId);
    const compactFrontendId = `compact__${backendId}`;
    if (generatingStates[compactFrontendId]) return;

    try {
      setGeneratingStates(s => ({ ...s, [compactFrontendId]: true }));
      setSessions(prev => ({
        ...prev,
        [compactFrontendId]: [{ id: `sys_${generateUUID()}`, role: 'system', content: '🧠 正在后台分析主会话的上下文，提取核心摘要...', time: new Date().toISOString() }]
      }));
      
      connectSSE(compactFrontendId);
      await fetch(`${BASE_URL}/cmd?session_id=${backendId}&session_type=main&cmd=flush`, { method: 'POST' });
      await fetch(`${BASE_URL}/cmd?session_id=${backendId}&session_type=compact&cmd=refresh`, { method: 'POST' });
      await fetch(`${BASE_URL}/str-input?session_id=${backendId}&session_type=compact&user_input=${encodeURIComponent("请对上方获取的对话进行提炼和总结，输出一份精简的记忆摘要。")}`, { method: 'POST' });
    } catch (e) {
      console.error('Compact init failed', e);
      setGeneratingStates(s => ({ ...s, [compactFrontendId]: false }));
    }
  };

  return { 
    sessions, currentSessionId, generatingStates, connectionStates, 
    switchSession, sendMessage, interrupt, compactMemory, setSessions,
    connectSSE, disconnectSSE 
  };
}