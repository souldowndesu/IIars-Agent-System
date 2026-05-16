// ============================================
// app-init.js — 入口初始化：DOM 就绪、事件绑定、启动
// 依赖：app-state.js → app-ui.js → app-core.js (需最后加载)
// ============================================

document.addEventListener('DOMContentLoaded', function () {
    // ========== 步骤 1：获取所有 DOM 引用 ==========
    const domRefs = {
        messagesContainer:    document.getElementById('messages-container'),
        chatListUl:           document.getElementById('chat-list'),
        currentSessionTitle:  document.getElementById('current-session-title'),
        messageInput:         document.getElementById('message-input'),
        sendBtn:              document.getElementById('send-btn'),
        compactBtn:           document.getElementById('compact-btn'),
        cleanTempBtn:         document.getElementById('clean-temp-btn'),
        connectionToggleBtn:  document.getElementById('connection-toggle-btn'),
        followUpHint:         document.getElementById('follow-up-hint'),
        compactPanel:         document.getElementById('compact-panel'),
        compactStatus:        document.getElementById('compact-status'),
        compactContent:       document.getElementById('compact-content')
    };

    // 立即注入 DOM 引用到 app-ui.js
    initUIDOMRefs(domRefs);

    // ========== 步骤 2：绑定 UI 事件 ==========

    // 滚动监听（DOM 已就绪）
    bindScrollListeners(domRefs.messagesContainer);

    // 发送消息（按钮 + 回车键）
    domRefs.sendBtn.addEventListener('click', sendMessage);
    domRefs.messageInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // 新建临时对话按钮
    const newChatBtn = document.getElementById('new-chat-btn');
    if (newChatBtn) {
        newChatBtn.addEventListener('click', createTempChat);
    }

    // 清理临时对话按钮
    if (domRefs.cleanTempBtn) {
        domRefs.cleanTempBtn.addEventListener('click', cleanTempChats);
    }

    // 压缩按钮
    if (domRefs.compactBtn) {
        domRefs.compactBtn.addEventListener('click', startCompact);
    }

    // 清除关联的聊天按钮（如果存在）
    const clearChatBtn = document.getElementById('clear-chat-btn');
    if (clearChatBtn) {
        clearChatBtn.addEventListener('click', function () {
            if (currentSessionId && localSessionsData[currentSessionId]) {
                localSessionsData[currentSessionId] = [];
                saveLocalData();
                domRefs.messagesContainer.innerHTML = '';
                renderChatList();
            }
        });
    }

    // ========== 步骤 3：初始化 ==========

    // 清理损坏的 localStorage 数据
    sanitizeLocalStorage();

    // 获取或创建主会话 ID
    const mainSessionId = getMainSessionId();
    currentSessionId = null;  // 确保 switchSession 不会因为 same-id 跳过

    // 初始切入主会话（此时 DOM 完全就绪）
    switchSession(mainSessionId);
});