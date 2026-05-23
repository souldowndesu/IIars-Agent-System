// src/useChatLogic.ts
import { useState, useRef, useCallback } from 'react';
import { BASE_URL } from './types';
import type { Message, ServerEvent } from './types';

export function useChatLogic() {
  const [sessions, setSessions] = useState<Record<string, Message[]>>(() => {
    const local = localStorage.getItem('chatSessions');
    const parsed = local ? JSON.parse(local) : { main: [] };
    Object.keys(parsed).forEach(k => { if (k.startsWith('compact__')) delete parsed[k]; });
    return parsed;
  });
  
  const [currentSessionId, setCurrentSessionId] = useState<string>('main');
  const [generatingStates, setGeneratingStates] = useState<Record<string, boolean>>({});
  const [connectionStates, setConnectionStates] = useState<Record<string, 'connected' | 'disconnected' | 'connecting'>>({});
  
  const eventSourcesRef = useRef<Record<string, EventSource>>({});

  const saveLocal = (newSessions: Record<string, Message[]>) => {
    const storageData = { ...newSessions };
    Object.keys(storageData).forEach(k => {
      if (k.startsWith('compact__')) delete storageData[k];
    });
    setSessions(newSessions); 
    localStorage.setItem('chatSessions', JSON.stringify(storageData));
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
      const data = await res.json();
      if (data.status === 'ok' && data.messages) {
        const formatted = data.messages.map((m: Partial<Message>, i: number) => ({ ...m, id: `${Date.now()}-${i}` })) as Message[];
        setSessions(prev => {
          const newSessions = { ...prev, [frontendId]: formatted };
          localStorage.setItem('chatSessions', JSON.stringify(newSessions));
          return newSessions;
        });
      }
    } catch (e) {
      console.error('History sync failed', e);
    }
  }, []);

  const handleServerEvent = useCallback((payload: ServerEvent, frontendId: string) => {
    setSessions(prev => {
      const sessionMsgs = prev[frontendId] || [];
      const newMsgs = [...sessionMsgs];
      const lastMsg = newMsgs.length > 0 ? newMsgs[newMsgs.length - 1] : null;
      
      const genId = `gen_${frontendId}`;

      switch (payload.event) {
        case 'start':
          setGeneratingStates(s => ({ ...s, [frontendId]: true }));
          newMsgs.forEach(m => { if (m.id === genId) m.id = `locked_${Date.now()}_${Math.random()}`; });
          newMsgs.push({ id: genId, role: 'assistant', content: '', time: new Date().toISOString() });
          break;

        case 'content':
          if (lastMsg && lastMsg.role === 'assistant' && lastMsg.id === genId) {
            newMsgs[newMsgs.length - 1] = {
              ...lastMsg,
              content: lastMsg.content + (payload.data || '')
            };
          } else {
            newMsgs.forEach(m => { if (m.id === genId) m.id = `locked_${Date.now()}_${Math.random()}`; });
            newMsgs.push({
              id: genId,
              role: 'assistant',
              content: payload.data || '',
              time: new Date().toISOString()
            });
          }
          break;

        case 'tool_status':
          if (payload.status === 'start') {
            if (lastMsg && lastMsg.role === 'assistant' && lastMsg.id === genId && !lastMsg.content.trim()) {
              newMsgs.pop();
            } else {
              newMsgs.forEach(m => { if (m.id === genId) m.id = `locked_${Date.now()}_${Math.random()}`; });
            }
            newMsgs.push({
              id: `tool_${Date.now()}`,
              role: 'tool',
              content: '',
              name: payload.name,
              status: 'running',
              time: new Date().toISOString()
            });
          } else if (payload.status === 'result') {
            const toolIndex = newMsgs.findLastIndex(m => m.role === 'tool' && m.name === payload.name && m.status === 'running');
            if (toolIndex !== -1) {
              newMsgs[toolIndex] = {
                ...newMsgs[toolIndex],
                status: payload.executed_well ? 'success' : 'error',
                tool_args: payload.tool_args,
                content: payload.result_data || '无返回结果'
              };
            }
          }
          break;

        case 'end':
        case 'interrupt':
        case 'error':
          setGeneratingStates(s => ({ ...s, [frontendId]: false }));
          newMsgs.forEach(m => { if (m.id === genId) m.id = `locked_${Date.now()}_${Math.random()}`; });
          
          if (payload.event === 'error') {
            newMsgs.push({ id: `err_${Date.now()}`, role: 'system', content: `错误: ${payload.error_msg}`, time: new Date().toISOString() });
          } else if (payload.event === 'interrupt') {
            newMsgs.push({ id: `int_${Date.now()}`, role: 'system', content: `⏹ 生成已终止`, time: new Date().toISOString() });
          }
          
          if (payload.event === 'end' && frontendId.startsWith('compact__')) {
            const origId = frontendId.replace('compact__', '');
            fetch(`${BASE_URL}/cmd?session_id=${origId}&session_type=main&cmd=refresh`, { method: 'POST' })
              .then(() => syncHistory(origId));
          }
          break;
      }

      const storageData = { ...prev, [frontendId]: newMsgs };
      Object.keys(storageData).forEach(k => { if (k.startsWith('compact__')) delete storageData[k]; });
      localStorage.setItem('chatSessions', JSON.stringify(storageData));
      
      return { ...prev, [frontendId]: newMsgs };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connectSSE = useCallback((frontendId: string) => {
    if (eventSourcesRef.current[frontendId] && eventSourcesRef.current[frontendId].readyState !== EventSource.CLOSED) return;
    
    setConnectionStates(prev => ({ ...prev, [frontendId]: 'connecting' }));
    const { backendId, backendType } = getBackendParams(frontendId);
    const es = new EventSource(`${BASE_URL}/stream?session_id=${backendId}&session_type=${backendType}`);
    eventSourcesRef.current[frontendId] = es;

    es.onopen = () => setConnectionStates(prev => ({ ...prev, [frontendId]: 'connected' }));
    es.onmessage = (e: MessageEvent) => { handleServerEvent(JSON.parse(e.data), frontendId); };
    es.onerror = () => {
      setConnectionStates(prev => ({ ...prev, [frontendId]: 'disconnected' }));
      es.close();
      delete eventSourcesRef.current[frontendId];
    };
  }, [handleServerEvent]);

  // 新增：手动断开 SSE 连接
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
    const userMsg: Message = { id: `usr_${Date.now()}`, role: 'user', content: text, time: new Date().toISOString() };
    saveLocal({ ...sessions, [currentSessionId]: [...(sessions[currentSessionId] || []), userMsg] });

    try {
      const { backendId, backendType } = getBackendParams(currentSessionId);
      await fetch(`${BASE_URL}/str-input?session_id=${backendId}&session_type=${backendType}&user_input=${encodeURIComponent(text)}`, { method: 'POST' });
    } catch (e) {
      console.error('Send failed', e);
    }
  };

  const interrupt = async () => {
    const { backendId, backendType } = getBackendParams(currentSessionId);
    await fetch(`${BASE_URL}/cmd?session_id=${backendId}&session_type=${backendType}&cmd=interrupt`, { method: 'POST' });
  };

  const compactMemory = async () => {
    const { backendId } = getBackendParams(currentSessionId);
    const compactFrontendId = `compact__${backendId}`;

    if (generatingStates[compactFrontendId]) {
      return; // 防止重复点击
    }

    try {
      setGeneratingStates(s => ({ ...s, [compactFrontendId]: true }));
      // 重置压缩面板 UI
      setSessions(prev => ({
        ...prev,
        [compactFrontendId]: [{ id: `sys_${Date.now()}`, role: 'system', content: '🧠 正在后台分析主会话的上下文，提取核心摘要...', time: new Date().toISOString() }]
      }));
      
      // 1. 纯后台连接监听，不再自动跳转视图！
      connectSSE(compactFrontendId);

      // 2. 刷入主会话数据到磁盘
      await fetch(`${BASE_URL}/cmd?session_id=${backendId}&session_type=main&cmd=flush`, { method: 'POST' });
      
      // 3. 核心修复：强制刷新后端 compact 实例历史！彻底解决旧数据导致的重复问题！
      await fetch(`${BASE_URL}/cmd?session_id=${backendId}&session_type=compact&cmd=refresh`, { method: 'POST' });

      // 4. 发送压缩输入
      await fetch(`${BASE_URL}/str-input?session_id=${backendId}&session_type=compact&user_input=${encodeURIComponent("请对上方获取的对话进行提炼和总结，输出一份精简的记忆摘要。")}`, { method: 'POST' });
    } catch (e) {
      console.error('Compact init failed', e);
      setGeneratingStates(s => ({ ...s, [compactFrontendId]: false }));
    }
  };

  return { 
    sessions, currentSessionId, generatingStates, connectionStates, 
    switchSession, sendMessage, interrupt, compactMemory, setSessions,
    connectSSE, disconnectSSE  // 导出供 UI 手动控制
  };
}