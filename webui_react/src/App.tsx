// App.tsx
import { useState, useRef, useEffect, type SyntheticEvent } from 'react';
import { useChatLogic } from './useChatLogic';
import { useTimetable } from './useTimetable';
import type { Message, TimeTask } from './types'; 
import { 
  Send, Square, MessageSquare, PlusCircle, 
  Settings2, BrainCircuit, CheckCircle2, XCircle, Wifi, WifiOff, Loader2,
  CalendarClock, Clock, Trash2, X
} from 'lucide-react';

export default function App() {
  const [currentView, setCurrentView] = useState<'chat' | 'timetable'>('chat');

  const {
    sessions,
    currentSessionId,
    generatingStates,
    connectionStates,
    switchSession,
    sendMessage,
    interrupt,
    compactMemory,
    setSessions,
    connectSSE,       // 引入控制方法
    disconnectSSE     // 引入控制方法
  } = useChatLogic();

  const { tasks, fetchTasks, addTask, deleteTask } = useTimetable();

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);

  const currentMessages = sessions[currentSessionId] || [];
  const isGenerating = generatingStates[currentSessionId] || false;
  const connectionStatus = connectionStates[currentSessionId] || 'disconnected';
  const isCompactMode = currentSessionId.startsWith('compact__');

  useEffect(() => {
    if (currentView === 'timetable') fetchTasks();
  }, [currentView, fetchTasks]);

  const handleScroll = () => {
    if (!scrollContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    setIsPinnedToBottom(scrollHeight - scrollTop - clientHeight < 50);
  };

  useEffect(() => {
    if (isPinnedToBottom && currentView === 'chat') {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [currentMessages.length, isPinnedToBottom, currentView]); 

  const createTempChat = () => {
    const newId = `temp-${Date.now()}`;
    setSessions((prev: Record<string, Message[]>) => ({ ...prev, [newId]: [] }));
    switchSession(newId);
    setCurrentView('chat'); 
  };

  return (
    <div className="flex h-screen bg-neutral-900 text-neutral-100 font-sans">
      
      <aside className="w-64 bg-neutral-950 border-r border-neutral-800 flex flex-col shadow-2xl z-20">
        <div className="p-4 flex flex-col gap-3 border-b border-neutral-800">
          <button 
            onClick={createTempChat}
            className="flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white py-2.5 px-4 rounded-xl transition-all font-medium shadow-lg shadow-blue-900/20"
          >
            <PlusCircle size={18} /> 新建临时对话
          </button>
          
          <button 
            onClick={() => setCurrentView('timetable')}
            className={`flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl transition-all font-medium border ${
              currentView === 'timetable' 
                ? 'bg-purple-900/30 border-purple-800/50 text-purple-300' 
                : 'bg-neutral-900 hover:bg-neutral-800 border-neutral-700 text-neutral-400'
            }`}
          >
            <CalendarClock size={18} /> 定时任务表
          </button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          <div className="text-xs font-semibold text-neutral-600 mb-2 px-2 uppercase tracking-wider">历史会话</div>
          {Object.keys(sessions).map(id => {
            const isCompacting = id.startsWith('compact__');
            const isActive = currentSessionId === id && currentView === 'chat';
            const isBusy = generatingStates[id];
            
            return (
              <div 
                key={id}
                onClick={() => { switchSession(id); setCurrentView('chat'); }}
                className={`flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-all ${
                  isActive ? 'bg-neutral-800 shadow-md' : 'hover:bg-neutral-800/50'
                }`}
              >
                {isBusy ? (
                  <Loader2 size={18} className="animate-spin text-blue-400" />
                ) : isCompacting ? (
                  <BrainCircuit size={18} className="text-purple-400" />
                ) : (
                  <MessageSquare size={18} className={isActive ? 'text-blue-400' : 'text-neutral-500'} />
                )}
                
                <span className={`truncate text-sm font-medium ${isCompacting ? 'text-purple-300' : isActive ? 'text-white' : 'text-neutral-400'}`}>
                  {id === 'main' ? '⭐ 主对话' : isCompacting ? `记忆压缩 [${id.replace('compact__', '')}]` : id}
                </span>
              </div>
            );
          })}
        </div>
      </aside>

      {currentView === 'chat' ? (
        <main className="flex-1 flex flex-col relative min-w-0">
          <header className="h-16 flex items-center justify-between px-6 border-b border-neutral-800 bg-neutral-900/80 backdrop-blur-md z-10">
            <h2 className="font-semibold text-lg flex items-center gap-2 text-neutral-200">
              {isCompactMode ? <BrainCircuit className="text-purple-400"/> : currentSessionId === 'main' ? '⭐' : <MessageSquare className="text-neutral-400"/>}
              {currentSessionId === 'main' ? '主对话' : isCompactMode ? '记忆压缩视界' : currentSessionId}
            </h2>
            <div className="flex items-center gap-3">
              {!isCompactMode && (currentSessionId === 'main' || currentSessionId.includes('main_')) && (
                <button 
                  onClick={compactMemory}
                  disabled={generatingStates[`compact__${currentSessionId}`]}
                  className="flex items-center gap-2 px-4 py-2 text-sm bg-purple-900/20 border border-purple-900/50 hover:bg-purple-900/40 rounded-lg transition-all text-purple-300 disabled:opacity-50"
                >
                  {generatingStates[`compact__${currentSessionId}`] ? <Loader2 size={16} className="animate-spin" /> : <BrainCircuit size={16} />} 
                  {generatingStates[`compact__${currentSessionId}`] ? '正在后台压缩' : '压缩当前记忆'}
                </button>
              )}
              
              {/* 网络状态按钮：支持手动控制 */}
              <button 
                title={connectionStatus === 'connected' ? "点击断开当前连接" : "点击尝试重新连接"}
                onClick={() => connectionStatus === 'connected' ? disconnectSSE(currentSessionId) : connectSSE(currentSessionId)}
                className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                  connectionStatus === 'connected' 
                    ? 'text-emerald-400 border-emerald-900/50 bg-emerald-900/10 hover:bg-emerald-900/30' 
                    : 'text-red-400 border-red-900/50 bg-red-900/10 hover:bg-red-900/30'
                }`}
              >
                {connectionStatus === 'connected' ? <Wifi size={16} /> : <WifiOff size={16} />}
                {connectionStatus === 'connected' ? '已连接' : '未连接'}
              </button>
            </div>
          </header>

          <div 
            className="flex-1 overflow-y-auto p-6 space-y-8 scroll-smooth bg-neutral-950/30"
            ref={scrollContainerRef}
            onScroll={handleScroll}
          >
            {currentMessages.length === 0 && (
              <div className="h-full flex items-center justify-center text-neutral-500 flex-col gap-4">
                {isCompactMode ? <BrainCircuit size={48} className="opacity-20" /> : <MessageSquare size={48} className="opacity-20" />}
                <p>{isCompactMode ? "后台正在提炼精华，稍后更新主对话..." : "暂无对话记录，打个招呼吧！"}</p>
              </div>
            )}
            {currentMessages.map((msg: Message) => (
              <MessageBubble key={msg.id} msg={msg} />
            ))}
            <div ref={messagesEndRef} className="h-4" />
          </div>

          <div className="p-4 bg-neutral-900 border-t border-neutral-800">
            <div className="max-w-4xl mx-auto relative flex items-center">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (isGenerating ? interrupt() : (sendMessage(input), setInput('')))}
                disabled={isCompactMode}
                placeholder={isCompactMode ? "⚠️ 记忆压缩过程中无法直接对话..." : "输入你的问题..."}
                className={`w-full bg-neutral-800 border border-neutral-700 text-white rounded-2xl pl-4 pr-28 py-4 focus:outline-none focus:ring-2 focus:ring-blue-600 transition-all shadow-inner ${
                  isCompactMode ? 'opacity-50 cursor-not-allowed bg-neutral-900' : ''
                }`}
              />
              <button
                onClick={() => isGenerating ? interrupt() : (sendMessage(input), setInput(''))}
                disabled={(!input.trim() && !isGenerating) || isCompactMode}
                className={`absolute right-2 flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl font-medium transition-all ${
                  isGenerating 
                    ? 'bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-900/50' 
                    : 'bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-30 disabled:cursor-not-allowed'
                }`}
              >
                {isGenerating ? <><Square size={16} fill="currentColor" /> 终止</> : <><Send size={16} /> 发送</>}
              </button>
            </div>
          </div>
        </main>
      ) : (
        <TimetablePanel tasks={tasks} onRefresh={fetchTasks} onAdd={addTask} onDelete={deleteTask} />
      )}
    </div>
  );
}

// ====================== 气泡组件 ======================
function MessageBubble({ msg }: { msg: Message }) {
  if (msg.role === 'tool') {
    return (
      <div className="flex w-full justify-center my-2">
        <details className="bg-neutral-800/40 border border-neutral-700/50 rounded-xl p-3 max-w-3xl w-full text-sm [&_summary::-webkit-details-marker]:hidden group backdrop-blur-sm">
          <summary className="flex items-center gap-2 cursor-pointer outline-none select-none text-neutral-400 hover:text-white transition-colors">
            <Settings2 size={16} className={msg.status === 'running' ? 'animate-spin text-blue-400' : 'text-neutral-500'} />
            <span className="font-medium tracking-wide">工具执行: {msg.name}</span>
            <div className="ml-auto flex items-center">
              {msg.status === 'running' && <span className="text-blue-400 text-xs px-2 py-0.5 rounded bg-blue-900/30">运行中</span>}
              {msg.status === 'success' && <CheckCircle2 size={16} className="text-emerald-500" />}
              {msg.status === 'error' && <XCircle size={16} className="text-red-500" />}
            </div>
          </summary>
          <div className="mt-3 space-y-2 border-t border-neutral-700/50 pt-3">
            <div>
              <div className="text-xs text-neutral-500 mb-1 font-semibold uppercase tracking-wider">📥 输入参数</div>
              <pre className="bg-neutral-950 p-3 rounded-lg text-neutral-300 font-mono text-xs overflow-x-auto whitespace-pre-wrap border border-neutral-800/80 shadow-inner">
                {msg.tool_args || '{}'}
              </pre>
            </div>
            {msg.content && (
              <div>
                <div className="text-xs text-neutral-500 mb-1 font-semibold uppercase tracking-wider">📤 输出结果</div>
                <pre className="bg-neutral-950 p-3 rounded-lg text-neutral-300 font-mono text-xs overflow-x-auto whitespace-pre-wrap border border-neutral-800/80 shadow-inner">
                  {msg.content}
                </pre>
              </div>
            )}
          </div>
        </details>
      </div>
    );
  }

  const isUser = msg.role === 'user';
  const isSystem = msg.role === 'system';

  if (isSystem) {
    return (
      <div className="flex w-full justify-center my-4">
        <div className="px-4 py-2 bg-neutral-800/50 border border-neutral-700/50 rounded-full text-xs text-neutral-400 font-medium">
          {msg.content}
        </div>
      </div>
    );
  }

  const displayTime = msg.time ? new Date(msg.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <div className={`flex w-full ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] flex flex-col gap-1.5 ${isUser ? 'items-end' : 'items-start'}`}>
        {displayTime && <span className="text-[11px] text-neutral-500 ml-1.5 font-medium tracking-wide">{displayTime}</span>}
        <div className={`px-5 py-3.5 rounded-3xl shadow-sm ${
          isUser 
            ? 'bg-blue-600 text-white rounded-br-sm shadow-blue-900/20' 
            : 'bg-neutral-800 text-neutral-200 rounded-bl-sm border border-neutral-700/50 shadow-black/20'
        }`}>
          {msg.isHtml ? (
             <div dangerouslySetInnerHTML={{ __html: msg.content }} className="prose prose-invert prose-sm max-w-none" />
          ) : (
            <div className="whitespace-pre-wrap leading-relaxed text-[15px]">{msg.content}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ====================== 时间表看板子组件 ======================
interface TimetablePanelProps {
  tasks: TimeTask[];
  onRefresh: () => void;
  onAdd: (task: Omit<TimeTask, 'id' | 'next_run_time' | 'triggered'>) => void;
  onDelete: (id: number) => void;
}

function TimetablePanel({ tasks, onRefresh, onAdd, onDelete }: TimetablePanelProps) {
  const [showModal, setShowModal] = useState(false);
  const [formData, setFormData] = useState<{
    task_type: 'agent' | 'system';
    is_recurring: boolean;
    recurrence_mode: 'none' | 'daily' | 'weekly' | 'monthly';
    trigger_time: string;
    action_cmd: string;
    task_info: string;
    session_id: string;
  }>({
    task_type: 'agent', is_recurring: false, recurrence_mode: 'none',
    trigger_time: '2024-01-01 12:00', action_cmd: '', task_info: '', session_id: 'main'
  });

  const handleSubmit = (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    onAdd({ ...formData, session_type: 'main' });
    setShowModal(false);
  };

  return (
    <main className="flex-1 flex flex-col bg-neutral-950 overflow-hidden relative">
      <header className="h-16 flex items-center justify-between px-8 border-b border-neutral-800 bg-neutral-900/80">
        <h2 className="font-semibold text-xl flex items-center gap-2 text-purple-100">
           <CalendarClock className="text-purple-400"/> 自动化任务看板
        </h2>
        <div className="flex gap-3">
          <button onClick={onRefresh} className="px-4 py-2 text-sm bg-neutral-800 hover:bg-neutral-700 rounded-lg transition-all text-neutral-300">刷新</button>
          <button onClick={() => setShowModal(true)} className="flex items-center gap-2 px-4 py-2 text-sm bg-purple-600 hover:bg-purple-500 rounded-lg transition-all text-white font-medium shadow-lg shadow-purple-900/20">
            <PlusCircle size={16} /> 新增任务
          </button>
        </div>
      </header>

      <div className="flex-1 p-8 overflow-y-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {tasks.map((t: TimeTask) => (
            <div key={t.id} className={`p-5 rounded-2xl border ${t.triggered && !t.is_recurring ? 'bg-neutral-900/50 border-neutral-800 opacity-60' : 'bg-neutral-800 border-neutral-700 shadow-xl'}`}>
              <div className="flex justify-between items-start mb-4">
                <div className="flex gap-2">
                  <span className={`text-xs px-2 py-1 rounded-md font-bold uppercase ${t.task_type === 'system' ? 'bg-red-900/30 text-red-400' : 'bg-blue-900/30 text-blue-400'}`}>
                    {t.task_type}
                  </span>
                  {t.is_recurring ? <span className="text-xs px-2 py-1 rounded-md bg-purple-900/30 text-purple-400 font-bold uppercase">循环 ({t.recurrence_mode})</span> : <span className="text-xs px-2 py-1 rounded-md bg-neutral-700 text-neutral-400 font-bold uppercase">单次</span>}
                </div>
                <button title="删除任务" aria-label="删除任务" onClick={() => onDelete(t.id)} className="text-neutral-500 hover:text-red-400 transition-colors p-1"><Trash2 size={18} /></button>
              </div>
              <h3 className="text-neutral-200 font-medium mb-2 truncate" title={t.task_info || t.action_cmd}>{t.task_type === 'agent' ? t.task_info : `System: ${t.action_cmd}`}</h3>
              <div className="space-y-1.5 text-sm text-neutral-400 mt-4 bg-neutral-900 p-3 rounded-xl border border-neutral-800">
                <div className="flex items-center gap-2"><Clock size={14} className="text-emerald-500"/> 下次执行: <span className="text-emerald-400">{t.next_run_time}</span></div>
                <div className="flex items-center gap-2"><Settings2 size={14}/> 设定规则: {t.trigger_time}</div>
                {t.task_type === 'agent' && <div className="flex items-center gap-2"><MessageSquare size={14}/> 投递会话: {t.session_id}</div>}
              </div>
            </div>
          ))}
          {tasks.length === 0 && <div className="col-span-full text-center text-neutral-500 py-20">没有配置任何任务。</div>}
        </div>
      </div>

      {showModal && (
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm z-50 flex justify-center items-center p-4">
          <form onSubmit={handleSubmit} className="bg-neutral-900 border border-neutral-800 p-6 rounded-2xl w-full max-w-md shadow-2xl flex flex-col gap-4 animate-in fade-in zoom-in-95">
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-lg font-bold text-white">新增定时任务</h3>
              <button type="button" title="关闭弹窗" aria-label="关闭弹窗" onClick={() => setShowModal(false)} className="text-neutral-500 hover:text-white"><X size={20}/></button>            
            </div>
            <div className="flex gap-4">
              <label className="flex-1 text-sm text-neutral-400">任务类型
                <select className="mt-1 w-full bg-neutral-800 p-2.5 rounded-lg text-white border border-neutral-700 outline-none" value={formData.task_type} onChange={e => setFormData({...formData, task_type: e.target.value as 'agent' | 'system'})}>
                  <option value="agent">Agent 对话注入</option>
                  <option value="system">系统底层指令</option>
                </select>
              </label>
              <label className="flex-1 text-sm text-neutral-400">循环模式
                <select className="mt-1 w-full bg-neutral-800 p-2.5 rounded-lg text-white border border-neutral-700 outline-none" value={formData.recurrence_mode} onChange={e => setFormData({...formData, recurrence_mode: e.target.value as 'none' | 'daily' | 'weekly' | 'monthly', is_recurring: e.target.value !== 'none'})}>
                  <option value="none">不循环 (None)</option>
                  <option value="daily">每日 (Daily)</option>
                  <option value="weekly">每周 (Weekly)</option>
                  <option value="monthly">每月 (Monthly)</option>
                </select>
              </label>
            </div>

            <label className="text-sm text-neutral-400">时间规则 (Trigger Expr) <span className="text-xs text-neutral-500 ml-2">如 "2099-01-01 12:00" 或 "18:30"</span>
              <input required type="text" className="mt-1 w-full bg-neutral-800 p-2.5 rounded-lg text-white border border-neutral-700" value={formData.trigger_time} onChange={e => setFormData({...formData, trigger_time: e.target.value})}/>
            </label>

            {formData.task_type === 'system' ? (
              <label className="text-sm text-neutral-400">系统指令
                <select className="mt-1 w-full bg-neutral-800 p-2.5 rounded-lg text-white border border-neutral-700" value={formData.action_cmd} onChange={e => setFormData({...formData, action_cmd: e.target.value})}>
                  <option value="">-- 选择指令 --</option>
                  <option value="start">唤醒/启动所有服务 (start)</option>
                  <option value="end">休眠/关闭所有服务 (end)</option>
                </select>
              </label>
            ) : (
              <>
                <label className="text-sm text-neutral-400">推送会话 ID
                  <input required type="text" className="mt-1 w-full bg-neutral-800 p-2.5 rounded-lg text-white border border-neutral-700" value={formData.session_id} onChange={e => setFormData({...formData, session_id: e.target.value})}/>
                </label>
                <label className="text-sm text-neutral-400">Agent 提示词 / 任务要求
                  <textarea required className="mt-1 w-full bg-neutral-800 p-2.5 rounded-lg text-white border border-neutral-700 resize-none h-24" value={formData.task_info} onChange={e => setFormData({...formData, task_info: e.target.value})} placeholder="例：现在是早上8点，请整理一下今天的新闻推送给我。"/>
                </label>
              </>
            )}

            <button type="submit" className="mt-4 w-full bg-purple-600 hover:bg-purple-500 py-3 rounded-xl font-bold text-white transition-colors shadow-lg shadow-purple-900/20">
              保存并装载任务
            </button>
          </form>
        </div>
      )}
    </main>
  );
}