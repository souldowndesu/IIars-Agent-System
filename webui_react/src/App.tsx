// App.tsx
import { useState, useRef, useEffect } from 'react';
import { useChatLogic } from './useChatLogic';
import type { Message } from './types'; 
import { 
  Send, Square, MessageSquare, PlusCircle, 
  Settings2, BrainCircuit, CheckCircle2, XCircle, Loader2, Wifi, WifiOff 
} from 'lucide-react';

export default function App() {
  const {
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
  } = useChatLogic();

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);

  const currentMessages = sessions[currentSessionId] || [];

  const handleScroll = () => {
    if (!scrollContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    setIsPinnedToBottom(isAtBottom);
  };

  useEffect(() => {
    if (isPinnedToBottom) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [currentMessages.length, isPinnedToBottom]); 

  const createTempChat = () => {
    const newId = `temp-${Date.now()}`;
    setSessions((prev: Record<string, Message[]>) => ({ ...prev, [newId]: [] }));
    switchSession(newId);
  };

  const handleSend = () => {
    if (isGenerating) {
      interrupt();
    } else {
      sendMessage(input);
      setInput('');
    }
  };

  return (
    <div className="flex h-screen bg-neutral-900 text-neutral-100 font-sans">
      <aside className="w-64 bg-neutral-950 border-r border-neutral-800 flex flex-col">
        <div className="p-4 flex flex-col gap-2 border-b border-neutral-800">
          <button 
            onClick={createTempChat}
            className="flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white py-2 px-4 rounded-lg transition-colors font-medium"
          >
            <PlusCircle size={18} /> 新建临时对话
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {Object.keys(sessions).map(id => (
            <div 
              key={id}
              onClick={() => switchSession(id)}
              className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
                currentSessionId === id ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:bg-neutral-800/50'
              }`}
            >
              <MessageSquare size={18} />
              <span className="truncate text-sm font-medium">
                {id === 'main' ? '⭐ 主对话' : id}
              </span>
            </div>
          ))}
        </div>
      </aside>

      <main className="flex-1 flex flex-col relative min-w-0">
        <header className="h-14 flex items-center justify-between px-6 border-b border-neutral-800 bg-neutral-900/80 backdrop-blur-md z-10">
          <h2 className="font-semibold text-lg flex items-center gap-2">
            {currentSessionId === 'main' ? '⭐ 主对话' : currentSessionId}
          </h2>
          <div className="flex items-center gap-3">
            {currentSessionId === 'main' && (
              <button 
                onClick={compactMemory}
                disabled={isCompacting}
                className="flex items-center gap-2 px-3 py-1.5 text-sm bg-neutral-800 hover:bg-neutral-700 rounded-md transition-colors text-purple-400 disabled:opacity-50"
              >
                <BrainCircuit size={16} /> 压缩记忆
              </button>
            )}
            <div className={`flex items-center gap-2 text-sm px-3 py-1.5 rounded-md border ${
              connectionStatus === 'connected' ? 'text-emerald-400 border-emerald-900/50 bg-emerald-900/20' : 'text-red-400 border-red-900/50 bg-red-900/20'
            }`}>
              {connectionStatus === 'connected' ? <Wifi size={16} /> : <WifiOff size={16} />}
              {connectionStatus === 'connected' ? '已连接' : '未连接'}
            </div>
          </div>
        </header>

        {isCompacting && (
          <div className="absolute top-14 left-0 right-0 bg-neutral-800 border-b border-neutral-700 p-4 shadow-xl z-20 animate-in slide-in-from-top-2">
            <div className="flex items-center gap-2 font-medium text-purple-400 mb-2">
              <Loader2 size={16} className="animate-spin" /> {compactStatus}
            </div>
            <div className="text-sm text-neutral-300 max-h-32 overflow-y-auto whitespace-pre-wrap font-mono">
              {compactContent}
            </div>
          </div>
        )}

        <div 
          className="flex-1 overflow-y-auto p-4 space-y-6 scroll-smooth"
          ref={scrollContainerRef}
          onScroll={handleScroll}
        >
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
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
              placeholder="输入你的问题..."
              className="w-full bg-neutral-800 border border-neutral-700 text-white rounded-xl pl-4 pr-24 py-4 focus:outline-none focus:ring-2 focus:ring-blue-600 transition-all shadow-inner"
            />
            <button
              onClick={handleSend}
              className={`absolute right-2 flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-medium transition-all ${
                isGenerating 
                  ? 'bg-neutral-700 hover:bg-red-600/80 text-white' 
                  : 'bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50 disabled:cursor-not-allowed'
              }`}
              disabled={!input.trim() && !isGenerating}
            >
              {isGenerating ? <><Square size={16} fill="currentColor" /> 终止</> : <><Send size={16} /> 发送</>}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

function MessageBubble({ msg }: { msg: Message }) {
  if (msg.role === 'tool') {
    return (
      <div className="flex w-full justify-center my-2">
        <details className="bg-neutral-800/50 border border-neutral-700/50 rounded-lg p-3 max-w-2xl w-full text-sm [&_summary::-webkit-details-marker]:hidden group">
          <summary className="flex items-center gap-2 cursor-pointer outline-none select-none text-neutral-300 hover:text-white transition-colors">
            <Settings2 size={16} className={msg.status === 'running' ? 'animate-spin text-blue-400' : 'text-neutral-500'} />
            <span className="font-medium">工具执行: {msg.name}</span>
            <div className="ml-auto flex items-center">
              {msg.status === 'running' && <span className="text-blue-400">运行中...</span>}
              {msg.status === 'success' && <CheckCircle2 size={16} className="text-emerald-500" />}
              {msg.status === 'error' && <XCircle size={16} className="text-red-500" />}
            </div>
          </summary>
          <div className="mt-3 space-y-2 border-t border-neutral-700/50 pt-3">
            <div>
              <div className="text-xs text-neutral-500 mb-1 font-semibold uppercase">📥 输入参数</div>
              <pre className="bg-neutral-950 p-2 rounded text-neutral-300 font-mono text-xs overflow-x-auto whitespace-pre-wrap border border-neutral-800">
                {msg.tool_args || '{}'}
              </pre>
            </div>
            {msg.content && (
              <div>
                <div className="text-xs text-neutral-500 mb-1 font-semibold uppercase">📤 输出结果</div>
                <pre className="bg-neutral-950 p-2 rounded text-neutral-300 font-mono text-xs overflow-x-auto whitespace-pre-wrap border border-neutral-800">
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
    return <div className="text-center text-sm text-red-400 my-4 font-medium">{msg.content}</div>;
  }

  // 修复了这里的 Date.now()
  const displayTime = msg.time ? new Date(msg.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <div className={`flex w-full ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[80%] flex flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}>
        {displayTime && <span className="text-xs text-neutral-500 ml-1">{displayTime}</span>}
        <div className={`px-5 py-3 rounded-2xl ${
          isUser 
            ? 'bg-blue-600 text-white rounded-br-sm' 
            : 'bg-neutral-800 text-neutral-200 rounded-bl-sm border border-neutral-700'
        }`}>
          {msg.isHtml ? (
             <div dangerouslySetInnerHTML={{ __html: msg.content }} className="prose prose-invert max-w-none" />
          ) : (
            <div className="whitespace-pre-wrap leading-relaxed">{msg.content}</div>
          )}
        </div>
      </div>
    </div>
  );
}