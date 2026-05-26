// App.tsx
import React, { useState, useRef, useEffect } from 'react';
import { 
  View, Text, TextInput, TouchableOpacity, ScrollView, 
  KeyboardAvoidingView, Platform, Modal, ActivityIndicator
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { 
  Send, Menu, Clock, MessageSquare, Wifi, WifiOff, 
  BrainCircuit, PlusCircle, Square, CheckCircle2, XCircle, Settings2, X
} from 'lucide-react-native';

import { useChatLogic } from './src/useChatLogic';
import type { Message } from './src/types';

export default function App() {
  const [view, setView] = useState<'chat' | 'timetable'>('chat');
  const [input, setInput] = useState('');
  const [showSidebar, setShowSidebar] = useState(false);
  const scrollViewRef = useRef<ScrollView>(null);

  const {
    sessions, currentSessionId, generatingStates, connectionStates, 
    switchSession, sendMessage, interrupt, compactMemory, setSessions,
    connectSSE, disconnectSSE
  } = useChatLogic();

  const currentMessages = sessions[currentSessionId] || [];
  const isGenerating = generatingStates[currentSessionId] || false;
  const connectionStatus = connectionStates[currentSessionId] || 'disconnected';
  const isCompactMode = currentSessionId.startsWith('compact__');

  useEffect(() => {
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }, [currentMessages.length, currentMessages[currentMessages.length - 1]?.content]);

  const createTempChat = () => {
    const newId = `temp-${Date.now()}`;
    setSessions((prev) => ({ ...prev, [newId]: [] }));
    switchSession(newId);
    setShowSidebar(false);
    setView('chat');
  };

  const handleSend = () => {
    if (isGenerating) {
      interrupt();
    } else if (input.trim()) {
      sendMessage(input);
      setInput('');
    }
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: '#171717' }}>
        <KeyboardAvoidingView 
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'} 
          keyboardVerticalOffset={Platform.OS === 'android' ? 25 : 0} 
          style={{ flex: 1 }}
        >
          <View className="h-14 flex-row items-center justify-between px-4 border-b border-neutral-800 bg-neutral-900 z-10">
            <TouchableOpacity onPress={() => setShowSidebar(true)} className="p-2 -ml-2">
              <Menu color="#d4d4d8" size={24} />
            </TouchableOpacity>

            <View className="flex-row items-center flex-1 justify-center">
              {isCompactMode ? <BrainCircuit color="#c084fc" size={18} /> : (currentSessionId === 'main' ? <Text>⭐</Text> : <MessageSquare color="#9ca3af" size={18} />)}
              <Text className="text-white font-bold text-base ml-2 truncate max-w-[150px]" numberOfLines={1}>
                {currentSessionId === 'main' ? '主对话' : (isCompactMode ? '压缩视界' : currentSessionId)}
              </Text>
            </View>

            <View className="flex-row items-center gap-3">
              {(!isCompactMode && (currentSessionId === 'main' || currentSessionId.includes('main_'))) ? (
                <TouchableOpacity 
                  onPress={compactMemory} 
                  disabled={generatingStates[`compact__${currentSessionId}`]}
                >
                  {generatingStates[`compact__${currentSessionId}`] ? (
                    <ActivityIndicator size="small" color="#c084fc" />
                  ) : (
                    <BrainCircuit color="#c084fc" size={20} />
                  )}
                </TouchableOpacity>
              ) : null}
              
              <TouchableOpacity 
                onPress={() => connectionStatus === 'connected' ? disconnectSSE(currentSessionId) : connectSSE(currentSessionId)}
              >
                {connectionStatus === 'connected' ? <Wifi color="#34d399" size={20} /> : <WifiOff color="#f87171" size={20} />}
              </TouchableOpacity>
            </View>
          </View>

          {view === 'chat' ? (
            <ScrollView 
              ref={scrollViewRef}
              className="flex-1 bg-neutral-950 px-4" 
              contentContainerStyle={{ paddingVertical: 20 }}
              keyboardShouldPersistTaps="handled" 
              onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}
              onLayout={() => scrollViewRef.current?.scrollToEnd({ animated: true })}
            >
              {currentMessages.length === 0 ? (
                <View className="items-center justify-center mt-20 opacity-30">
                  <MessageSquare color="#fff" size={48} />
                  <Text className="text-white mt-4">暂无对话记录，打个招呼吧！</Text>
                </View>
              ) : null}
              
              {currentMessages.map((msg: Message) => (
                <MessageBubble key={msg.id} msg={msg} />
              ))}
            </ScrollView>
          ) : (
            <View className="flex-1 bg-neutral-950 items-center justify-center">
              <Clock color="#9ca3af" size={48} />
              <Text className="text-neutral-500 mt-4">定时任务看板移动端仍在开发中...</Text>
            </View>
          )}

          {view === 'chat' ? (
            <View className="p-3 bg-neutral-900 border-t border-neutral-800 flex-row items-end">
              <TextInput
                className={`flex-1 bg-neutral-800 text-white rounded-2xl px-4 pt-3 pb-3 text-base border border-neutral-700 min-h-[48px] max-h-[120px] ${isCompactMode ? 'opacity-50' : ''}`}
                placeholder={isCompactMode ? "⚠️ 记忆压缩中无法对话..." : "输入你的问题..."}
                placeholderTextColor="#6b7280"
                value={input}
                onChangeText={setInput}
                multiline
                editable={!isCompactMode}
              />
              <TouchableOpacity 
                onPress={handleSend}
                disabled={(!input.trim() && !isGenerating) || isCompactMode}
                className={`ml-3 p-3 rounded-xl justify-center items-center h-[48px] w-[48px] ${
                  isGenerating ? 'bg-red-500/20 border border-red-900/50' : 
                  (input.trim() ? 'bg-blue-600' : 'bg-neutral-800')
                }`}
              >
                {isGenerating ? <Square color="#f87171" size={20} fill="#f87171" /> : <Send color={input.trim() ? "white" : "#6b7280"} size={20} />}
              </TouchableOpacity>
            </View>
          ) : null}
        </KeyboardAvoidingView>

        <Modal visible={showSidebar} animationType="slide" transparent={true} onRequestClose={() => setShowSidebar(false)}>
          <View className="flex-1 flex-row bg-black/60">
            <View className="w-4/5 bg-neutral-900 h-full p-4 shadow-2xl">
              <View className="flex-row justify-between items-center mb-6 mt-4">
                <Text className="text-white font-bold text-xl">所有会话</Text>
                <TouchableOpacity onPress={() => setShowSidebar(false)}>
                  <X color="#9ca3af" size={24} />
                </TouchableOpacity>
              </View>

              <TouchableOpacity 
                onPress={createTempChat}
                className="flex-row items-center justify-center gap-2 bg-blue-600 p-3 rounded-xl mb-6"
              >
                <PlusCircle color="white" size={18} />
                <Text className="text-white font-bold">新建临时对话</Text>
              </TouchableOpacity>

              <ScrollView className="flex-1">
                {Object.keys(sessions).map(id => {
                  const isCompacting = id.startsWith('compact__');
                  const isActive = currentSessionId === id;
                  return (
                    <TouchableOpacity 
                      key={id}
                      onPress={() => { switchSession(id); setShowSidebar(false); }}
                      className={`flex-row items-center gap-3 p-4 rounded-xl mb-2 ${isActive ? 'bg-neutral-800 border border-neutral-700' : ''}`}
                    >
                      {isCompacting ? <BrainCircuit color="#c084fc" size={20} /> : <MessageSquare color={isActive ? "#60a5fa" : "#71717a"} size={20} />}
                      <Text className={`font-medium ${isCompacting ? 'text-purple-300' : (isActive ? 'text-white' : 'text-neutral-400')}`}>
                        {id === 'main' ? '⭐ 主对话' : (isCompacting ? `记忆压缩 [${id.replace('compact__', '')}]` : id)}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
            <TouchableOpacity className="flex-1" onPress={() => setShowSidebar(false)} />
          </View>
        </Modal>

      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function MessageBubble({ msg }: { msg: Message }) {
  if (msg.role === 'tool') {
    return (
      <View className="items-center my-2">
        <View className={`bg-neutral-800 border rounded-xl p-3 w-[90%] ${msg.status === 'error' ? 'border-red-900/50' : 'border-neutral-700'}`}>
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center gap-2">
              <Settings2 color="#9ca3af" size={16} />
              <Text className="text-neutral-400 text-sm font-bold">工具执行: {msg.name}</Text>
            </View>
            {msg.status === 'running' ? <ActivityIndicator size="small" color="#60a5fa" /> : null}
            {msg.status === 'success' ? <CheckCircle2 color="#34d399" size={16} /> : null}
            {msg.status === 'error' ? <XCircle color="#f87171" size={16} /> : null}
          </View>
          {msg.content ? (
            <Text className={`text-xs mt-2 ${msg.status === 'error' ? 'text-red-400' : 'text-neutral-500'}`} numberOfLines={3}>
              {msg.content}
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  const isUser = msg.role === 'user';
  const isSystem = msg.role === 'system';

  if (isSystem) {
    return (
      <View className="items-center my-3">
        <View className="bg-neutral-800 border border-neutral-700 px-4 py-2 rounded-full">
          <Text className="text-neutral-400 text-xs">{msg.content}</Text>
        </View>
      </View>
    );
  }

  if (!isUser && (!msg.content || msg.content.trim() === '')) {
    return null;
  }

  return (
    <View className={`flex-row mb-4 ${isUser ? 'justify-end' : 'justify-start'}`}>
      <View className={`max-w-[85%] px-4 py-3 rounded-2xl ${
        isUser ? 'bg-blue-600 rounded-br-sm' : 'bg-neutral-800 border border-neutral-700 rounded-bl-sm'
      }`}>
        <Text className={`text-base leading-6 ${isUser ? 'text-white' : 'text-neutral-200'}`}>
          {msg.content ? msg.content.replace(/<\/?[a-z][\s\S]*?>/gi, '') : ''}
        </Text>
      </View>
    </View>
  );
}