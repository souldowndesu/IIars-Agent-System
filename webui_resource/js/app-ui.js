// ============================================
// app-ui.js — UI 渲染：消息气泡、会话列表、滚动控制
// 整合自：message-bubble.js + chat-list.js + ui.js
// 依赖：app-state.js (需先加载)
// ============================================

// ---- DOM 引用（由 app-init.js 在初始化时设置） ----
let messagesContainer = null;
let chatListUl = null;
let currentSessionTitle = null;
let messageInput = null;
let sendBtn = null;
let compactBtn = null;
let cleanTempBtn = null;
let connectionToggleBtn = null;
let followUpHint = null;
let compactPanel = null;
let compactStatus = null;
let compactContent = null;

function initUIDOMRefs(refs) {
    messagesContainer     = refs.messagesContainer;
    chatListUl            = refs.chatListUl;
    currentSessionTitle   = refs.currentSessionTitle;
    messageInput          = refs.messageInput;
    sendBtn               = refs.sendBtn;
    compactBtn            = refs.compactBtn;
    cleanTempBtn          = refs.cleanTempBtn;
    connectionToggleBtn   = refs.connectionToggleBtn;
    followUpHint          = refs.followUpHint;
    compactPanel          = refs.compactPanel;
    compactStatus         = refs.compactStatus;
    compactContent        = refs.compactContent;
}

// ---- 消息气泡 ----
function appendMessageBubble(role, content, isHtml = false, savedTime = null) {
    const time = savedTime || new Date().toISOString();

    const wrapper = document.createElement('div');
    wrapper.classList.add('message-bubble');
    wrapper.classList.add(role);

    const timeDiv = document.createElement('div');
    timeDiv.classList.add('msg-time');
    timeDiv.textContent = formatTime(time);

    const textDiv = document.createElement('div');
    textDiv.classList.add('msg-text');
    if (isHtml) {
        textDiv.innerHTML = content;
    } else {
        textDiv.textContent = content;
    }

    wrapper.appendChild(timeDiv);
    wrapper.appendChild(textDiv);
    messagesContainer.appendChild(wrapper);
    scrollToBottom();
    return wrapper;
}


// ---- 历史消息重新渲染 ----
function reRenderMessages(sessionId) {
    const history = localSessionsData[sessionId] || [];
    messagesContainer.innerHTML = ''; // 清空并重新渲染
    
    let lastToolCalls = null; // 用于缓存助手调用工具时的参数

    history.forEach(msg => {
        try { // 【防崩溃装甲】：独立捕获每条消息的错误，绝不影响整体
            const rawContent = msg.content || '';

            // 记录助手的 tool_calls 参数，供后面的 tool 气泡提取"输入参数"使用
            if (msg.role === 'assistant' && msg.tool_calls) {
                lastToolCalls = msg.tool_calls;
            }

            if (msg.role === 'tool') {
                if (msg.isHtml && typeof rawContent === 'string' && rawContent.includes('<details')) {
                    // 1. 本地缓存的已包装好的 HTML，直接使用
                    appendMessageBubble(msg.role, rawContent, true, msg.time);
                } else {
                    // 2. 后端同步过来的原生数据，需要转换为漂亮样式的 HTML
                    let args = '{}';
                    if (Array.isArray(lastToolCalls)) {
                        // 尝试匹配对应 id 的 tool_call
                        const tc = lastToolCalls.find(t => 
                            t.id === msg.tool_call_id || 
                            (t.function && t.function.name === msg.name)
                        );
                        if (tc && tc.function && tc.function.arguments) {
                            args = tc.function.arguments;
                        }
                    }

                    // 强制拆分写法，防止代码压缩或 Markdown 解析器吞噬转义符号
                    const escHtml = (s) => String(s)
                        .replace(/&/g, "&" + "amp;")
                        .replace(/</g, "&" + "lt;")
                        .replace(/>/g, "&" + "gt;");

                    const htmlContent = [
                        '<details>', 
                        '<summary>⚙️ 工具 [', escHtml(msg.name || '未知'), '] 执行完毕 ✅</summary>',
                        '<div class="tool-section-label">📥 输入参数</div>',
                        '<pre class="tool-output tool-input">', escHtml(args), '</pre>',
                        '<div class="tool-section-label">📤 输出结果</div>',
                        '<pre class="tool-output">', escHtml(rawContent), '</pre>',
                        '</details>'
                    ].join('');
                    
                    appendMessageBubble(msg.role, htmlContent, true, msg.time);
                }
            } else if (msg.role === 'assistant') {
                // 如果是只包含 tool_calls 没有 content 的"静默"过渡消息，不渲染空文本气泡
                if (!rawContent && msg.tool_calls && msg.tool_calls.length > 0) {
                    return; 
                }
                appendMessageBubble(msg.role, rawContent, msg.isHtml, msg.time);
            } else {
                // user 等其他角色的消息
                appendMessageBubble(msg.role, rawContent, msg.isHtml, msg.time);
            }
        } catch (err) {
            console.error("[前端防御] 渲染某条历史消息时出错，已自动跳过:", err, msg);
        }
    });
    
    scrollToBottom();
}

// ---- 智能滚动 ----
function scrollToBottom() {
    const threshold = 80;
    const isNearBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < threshold;
    if (isNearBottom && !userManuallyScrolledUp) {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
}

function bindScrollListeners(container) {
    container.addEventListener('wheel', function(e) {
        if (e.deltaY < 0) {
            userManuallyScrolledUp = true;
        } else if (e.deltaY > 0) {
            const threshold = 10;
            const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
            if (isAtBottom) {
                userManuallyScrolledUp = false;
            }
        }
    });

    container.addEventListener('scroll', function() {
        const threshold = 10;
        const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
        userManuallyScrolledUp = !isAtBottom;
    });

    container.addEventListener('touchmove', function() {
        const threshold = 10;
        const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
        userManuallyScrolledUp = !isAtBottom;
    });
}

// ---- 会话列表渲染 ----
function renderChatList() {
    chatListUl.innerHTML = '';

    const mainSessions = [];
    const tempSessions = [];

    Object.keys(localSessionsData).forEach(id => {
        if (id.startsWith('compact_')) return;
        if (id.startsWith('main_') || id === 'main') {
            mainSessions.push(id);
        } else if (id.startsWith('temp-') || id.startsWith('temp_')) {
            tempSessions.push(id);
        }
    });

    const visibleTempIds = tempSessions.filter(id => !hiddenTempIds.has(id));

    const sortByFirstTime = (a, b) => {
        const msgsA = localSessionsData[a] || [];
        const msgsB = localSessionsData[b] || [];
        const timeA = msgsA.length > 0 ? (msgsA[0].time || '') : '';
        const timeB = msgsB.length > 0 ? (msgsB[0].time || '') : '';
        return timeB.localeCompare(timeA);
    };
    mainSessions.sort(sortByFirstTime);
    visibleTempIds.sort(sortByFirstTime);

    const ordered = [...mainSessions, ...visibleTempIds];
    const totalVisibleTemp = visibleTempIds.length;

    if (cleanTempBtn) {
        cleanTempBtn.disabled = totalVisibleTemp === 0;
    }

    ordered.forEach(id => {
        if (id.startsWith('compact_')) return;

        const li = document.createElement('li');
        li.classList.add('chat-item');

        let icon = '\uD83D\uDCAC';
        if (id.startsWith('main_') || id === 'main') icon = '\u2B50';
        else if (id.startsWith('temp-') || id.startsWith('temp_')) icon = '\uD83D\uDD50';

        let displayLabel = id;
        if (id.startsWith('temp-')) {
            displayLabel = id;
        } else if (id.includes('_')) {
            const parts = id.split('_');
            displayLabel = parts[0] + '-' + parts.slice(1).join('_').slice(-6);
        }
        li.textContent = `${icon} ${displayLabel}`;

        if (id === currentSessionId) li.classList.add('active');
        li.addEventListener('click', () => switchSession(id));
        chatListUl.appendChild(li);
    });
}

// ---- 更新按钮状态 ----
function updateConnectionButton() {
    const btn = connectionToggleBtn;
    if (!btn || !currentSessionId) return;
    const status = connectionStatus.get(currentSessionId);
    const connected = eventSources.has(currentSessionId) && status !== 'disconnected';
    if (connected) {
        btn.textContent = '🔗 已连接';
        btn.classList.add('connected');
        btn.classList.remove('disconnected');
        btn.title = '点击断开当前会话的连接';
        btn.onclick = disconnectCurrentSession;
    } else {
        btn.textContent = '❌ 未连接';
        btn.classList.add('disconnected');
        btn.classList.remove('connected');
        btn.title = '点击重新连接当前会话';
        btn.onclick = reconnectCurrentSession;
    }
}

function updateCompactButton() {
    if (!compactBtn) return;
    if (currentSessionId && (currentSessionId.startsWith('main_') || currentSessionId === 'main')) {
        compactBtn.style.display = '';
        compactBtn.disabled = isCompacting;
    } else {
        compactBtn.style.display = 'none';
    }
}

function updateSessionTitle(sessionId) {
    let titleText = sessionId;
    if (sessionId.startsWith('temp-')) {
        titleText = `[temp] ${sessionId.replace('temp-', '')}`;
    } else if (sessionId.includes('_')) {
        const parts = sessionId.split('_');
        titleText = `[${parts[0]}] ${parts.slice(1).join('_').slice(-6)}`;
    } else {
        titleText = `[chat] ${sessionId.slice(-6)}`;
    }
    currentSessionTitle.textContent = titleText;
}

// ---- 提示信息 ----
function showFollowUpHint() {
    if (followUpHint) {
        followUpHint.textContent = '\uD83D\uDCA1 \u4F60\u53EF\u4EE5\u7EE7\u7EED\u8FFD\u95EE\uFF0C\u6216\u8F93\u5165\u65B0\u95EE\u9898...';
        followUpHint.style.opacity = '1';
    }
}

function hideFollowUpHint() {
    if (followUpHint) {
        followUpHint.style.opacity = '0';
        setTimeout(() => { followUpHint.textContent = ''; }, 300);
    }
}

// ---- 新建 / 清理临时对话 ----
function createTempChat() {
    const newId = generateSessionId('temp');
    localSessionsData[newId] = [];
    saveLocalData();
    switchSession(newId);
}

function cleanTempChats() {
    const visibleTempIds = Object.keys(localSessionsData).filter(
        id => (id.startsWith('temp-') || id.startsWith('temp_')) && !hiddenTempIds.has(id)
    );
    if (visibleTempIds.length === 0) return;

    if (currentSessionId && (currentSessionId.startsWith('temp-') || currentSessionId.startsWith('temp_'))) {
        const mainId = getMainSessionId();
        switchSession(mainId);
    }

    visibleTempIds.forEach(id => hiddenTempIds.add(id));
    saveHiddenTempIds();
    renderChatList();
    console.log(`[Frontend] 已隐藏 ${visibleTempIds.length} 个临时对话（数据未删除）`);
}

// ---- 连接状态指示 ----
function getSessionConnectionStatus(sessionId) {
    const es = eventSources.get(sessionId);
    const status = connectionStatus.get(sessionId);
    if (status === 'disconnected') return 'manual-off';
    if (es && es.readyState === EventSource.OPEN) return 'connected';
    if (es && es.readyState === EventSource.CONNECTING) return 'connecting';
    return 'none';
}