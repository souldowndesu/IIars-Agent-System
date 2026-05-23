// useChatLogic.ts
import { useState, useRef, useCallback } from 'react';
import { BASE_URL } from './types';
import type { Message, ServerEvent } from './types';

export function useChatLogic() {
  // 修复：使用惰性初始化避免 useEffect 中同步 setState 导致的级联渲染警告
  const [sessions, setSessions] = useState<Record<string, Message[]>>(() => {
    const local = localStorage.getItem('chatSessions');
    return local ? JSON.parse(local) : { main: [] };
  });
  
  const [currentSessionId, setCurrentSessionId] = useState<string>('main');
  const [isGenerating, setIsGenerating] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'connecting'>('disconnected');
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactStatus, setCompactStatus] = useState('');
  const [compactContent, setCompactContent] = useState('');

  const eventSourceRef = useRef<EventSource | null>(null);

  const saveLocal = (newSessions: Record<string, Message[]>) => {
    setSessions(newSessions);
    localStorage.setItem('chatSessions', JSON.stringify(newSessions));
  };

  const getSessionType = (id: string) => {
    if (id.startsWith('temp-')) return 'temp';
    if (id === 'main') return 'main';
    if (id.includes('_')) return id.split('_')[0];
    return 'chat';
  };

  // 修复：处理服务端事件的函数必须在 connectSSE 前声明
  const handleServerEvent = useCallback((payload: ServerEvent, sessionId: string) => {
    setSessions(prev => {
      const sessionMsgs = prev[sessionId] || [];
      const newMsgs = [...sessionMsgs];
      const lastMsg = newMsgs[newMsgs.length - 1];

      switch (payload.event) {
        case 'start':
          setIsGenerating(true);
          newMsgs.push({ id: Date.now().toString(), role: 'assistant', content: '', time: new Date().toISOString() });
          break;
        case 'content':
          if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.status) {
            lastMsg.content += (payload.data || '');
          }
          break;
        case 'tool_status':
          if (payload.status === 'start') {
            if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.content) newMsgs.pop();
            newMsgs.push({
              id: Date.now().toString(),
              role: 'tool',
              content: '',
              name: payload.name,
              status: 'running',
              time: new Date().toISOString()
            });
          } else if (payload.status === 'result') {
            const toolMsg = newMsgs.find(m => m.role === 'tool' && m.name === payload.name && m.status === 'running');
            if (toolMsg) {
              toolMsg.status = payload.executed_well ? 'success' : 'error';
              toolMsg.tool_args = payload.tool_args;
              toolMsg.content = payload.result_data || '无返回结果';
            }
          }
          break;
        case 'end':
        case 'interrupt':
        case 'error':
          setIsGenerating(false);
          if (payload.event === 'error') {
            newMsgs.push({ id: Date.now().toString(), role: 'system', content: `错误: ${payload.error_msg}`, time: new Date().toISOString() });
          } else if (payload.event === 'interrupt') {
            newMsgs.push({ id: Date.now().toString(), role: 'system', content: `⏹ 生成已终止`, time: new Date().toISOString() });
          }
          localStorage.setItem('chatSessions', JSON.stringify({ ...prev, [sessionId]: newMsgs }));
          break;
      }
      return { ...prev, [sessionId]: newMsgs };
    });
  }, []);

  // 修复：建立连接的方法
  const connectSSE = useCallback((sessionId: string) => {
    if (eventSourceRef.current) eventSourceRef.current.close();
    
    setConnectionStatus('connecting');
    const type = getSessionType(sessionId);
    const es = new EventSource(`${BASE_URL}/stream?session_id=${sessionId}&session_type=${type}`);
    eventSourceRef.current = es;

    es.onopen = () => setConnectionStatus('connected');
    
    es.onmessage = (e: MessageEvent) => {
      const payload: ServerEvent = JSON.parse(e.data);
      handleServerEvent(payload, sessionId);
    };

    es.onerror = () => {
      setConnectionStatus('disconnected');
      es.close();
    };
  }, [handleServerEvent]);

  // 获取历史记录
  const syncHistory = useCallback(async (sessionId: string) => {
    try {
      const type = getSessionType(sessionId);
      const res = await fetch(`${BASE_URL}/get-history?session_id=${sessionId}&session_type=${type}`);
      const data = await res.json();
      if (data.status === 'ok' && data.messages) {
        // 修复：消除 any 报错
        const formatted = data.messages.map((m: Partial<Message>, i: number) => ({ 
          ...m, 
          id: `${Date.now()}-${i}` 
        })) as Message[];
        
        setSessions(prev => {
          const newSessions = { ...prev, [sessionId]: formatted };
          localStorage.setItem('chatSessions', JSON.stringify(newSessions));
          return newSessions;
        });
      }
    } catch (e) {
      console.error('History sync failed', e);
    }
  }, []);

  // 切换会话
  const switchSession = useCallback(async (sessionId: string) => {
    if (isGenerating) return;
    setCurrentSessionId(sessionId);
    await syncHistory(sessionId);
    connectSSE(sessionId);
    
    fetch(`${BASE_URL}/cmd?session_id=${sessionId}&session_type=${getSessionType(sessionId)}&cmd=refresh`, { method: 'POST' }).catch(() => {});
  }, [isGenerating, syncHistory, connectSSE]);

  const sendMessage = async (text: string) => {
    if (!text.trim() || isGenerating) return;

    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: text, time: new Date().toISOString() };
    saveLocal({ ...sessions, [currentSessionId]: [...(sessions[currentSessionId] || []), userMsg] });

    try {
      const type = getSessionType(currentSessionId);
      await fetch(`${BASE_URL}/str-input?session_id=${currentSessionId}&session_type=${type}&user_input=${encodeURIComponent(text)}`, { method: 'POST' });
    } catch (e) {
      console.error('Send failed', e);
    }
  };

  const interrupt = async () => {
    await fetch(`${BASE_URL}/cmd?session_id=${currentSessionId}&session_type=${getSessionType(currentSessionId)}&cmd=interrupt`, { method: 'POST' });
  };

  const compactMemory = async () => {
    if (isCompacting) return;
    setIsCompacting(true);
    setCompactStatus('正在压缩记忆...');
    setCompactContent('');
    
    try {
      await fetch(`${BASE_URL}/cmd?session_id=${currentSessionId}&session_type=main&cmd=flush`, { method: 'POST' });
      const compactId = `compact_${Date.now()}`;
      await fetch(`${BASE_URL}/str-input?session_id=${compactId}&session_type=compact&user_input=请压缩总结以上对话`, { method: 'POST' });
      
      const es = new EventSource(`${BASE_URL}/stream?session_id=${compactId}&session_type=compact`);
      es.onmessage = (e: MessageEvent) => {
        const payload = JSON.parse(e.data);
        if (payload.event === 'content') setCompactContent(prev => prev + (payload.data || ''));
        if (payload.event === 'end') {
          es.close();
          setCompactStatus('✅ 压缩完成，已更新主会话');
          setTimeout(() => setIsCompacting(false), 3000);
          fetch(`${BASE_URL}/cmd?session_id=${currentSessionId}&session_type=main&cmd=refresh`, { method: 'POST' }).then(() => syncHistory(currentSessionId));
        }
      };
      es.onerror = () => {
        es.close();
        setCompactStatus('❌ 压缩失败');
        setTimeout(() => setIsCompacting(false), 3000);
      }
    } catch (e) {
      console.error(e);
      setCompactStatus('❌ 压缩失败');
      setTimeout(() => setIsCompacting(false), 3000);
    }
  };

  return {
    sessions,
    currentSessionId,
    isGenerating,
    connectionStatus,
    isCompacting,
    compactStatus,
    compactContent,
    switchSession,
    sendMessage,
    interrupt,
    compactMemory,
    setSessions
  };
}