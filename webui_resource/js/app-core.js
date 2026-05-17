// ============================================
// app-core.js — 核心业务逻辑：会话切换、SSE连接、消息发送、压缩
// 整合自：session-switch.js + sse-client.js + message-send.js + compact.js
// 依赖：app-state.js → app-ui.js (需先加载)
// ============================================

// ---- 从服务端同步历史 ----
async function syncAndRenderHistory(sessionId) {
    try {
        const sessionType = getSessionType(sessionId);
        const resp = await fetch(
            `${BASE_URL}/get-history?session_id=${encodeURIComponent(sessionId)}&session_type=${encodeURIComponent(sessionType)}`
        );
        const data = await resp.json();
        if (data.status === 'ok' && data.messages && data.messages.length > 0) {
            localSessionsData[sessionId] = data.messages;
            saveLocalData();
            console.log(`[Frontend] 从服务端同步了 ${data.messages.length} 条消息 (${sessionId})`);
            return data.messages;
        }
    } catch (err) {
        console.warn('[Frontend] 服务端历史同步失败，降级使用本地缓存:', err);
    }
    return localSessionsData[sessionId] || [];
}

// ---- 会话切换 ----
async function switchSession(sessionId) {
    if (currentSessionId === sessionId) return;

    const oldSessionId = currentSessionId;
    currentSessionId = sessionId;

    // 清理上一个会话的 UI 状态
    activeAssistantMessageBubble = null;
    activeToolBubbles = {};
    userManuallyScrolledUp = false;

    // 更新标题
    updateSessionTitle(sessionId);

    // 隐藏提示
    hideFollowUpHint();

    // ★ 关键修复：确保输入框在切换时立即启用，避免 async 异常导致永久禁用
    updateSendBtnState();

    // 从服务端同步最新历史，覆盖 localStorage 缓存
    await syncAndRenderHistory(sessionId);

    // 刷新后端 LLM 上下文
    const sessionType = getSessionType(sessionId);
    try {
        await fetch(`${BASE_URL}/cmd?session_id=${encodeURIComponent(sessionId)}&session_type=${encodeURIComponent(sessionType)}&cmd=refresh`, { method: 'POST' });
        console.log(`[Frontend] 已刷新后端 LLM 上下文: ${sessionId}`);
    } catch (refreshErr) {
        console.warn(`[Frontend] refresh 失败（非致命）: ${refreshErr}`);
    }

    // ★ 关键修复：在 syncAndRenderHistory 之后再次渲染（确保使用最新数据）
    reRenderMessages(sessionId);

    // ★ 修复：确保输入框最终启用（双重保险，即使上面某步抛异常）
    updateSendBtnState();

    renderChatList();

    // 为目标 session 建立 SSE
    ensureConnected(sessionId);

    // 更新标题栏按钮
    updateConnectionButton();
    updateCompactButton();

    console.log(`[Frontend] 切换到会话: ${sessionId}（旧会话 ${oldSessionId} 的连接保留）`);
}

// ---- SSE 连接管理 ----
function ensureConnected(sessionId) {
    if (eventSources.has(sessionId)) {
        console.log(`[Frontend] 复用已有 SSE 连接: ${sessionId}`);
        return;
    }
    if (connectionStatus.get(sessionId) === 'disconnected') {
        console.log(`[Frontend] 会话 ${sessionId} 已被手动断开，跳过自动连接`);
        return;
    }
    connectSSE(sessionId);
}

function disconnectCurrentSession() {
    if (!currentSessionId) return;
    const es = eventSources.get(currentSessionId);
    if (es) {
        es.close();
        eventSources.delete(currentSessionId);
        console.log(`[Frontend] 手动断开会话: ${currentSessionId}`);
    }
    connectionStatus.set(currentSessionId, 'disconnected');
    updateConnectionButton();
    renderChatList();
}

function reconnectCurrentSession() {
    if (!currentSessionId) return;
    connectionStatus.set(currentSessionId, 'connected');
    connectSSE(currentSessionId);
    updateConnectionButton();
    renderChatList();
}

function connectSSE(sessionId) {
    const oldEs = eventSources.get(sessionId);
    if (oldEs && (oldEs.readyState === EventSource.OPEN || oldEs.readyState === EventSource.CONNECTING)) {
        oldEs.close();
        console.log(`[Frontend] 关闭旧 SSE: ${sessionId}`);
    }

    console.log(`[Frontend] 建立 SSE 连接到会话: ${sessionId}`);
    const sessionType = getSessionType(sessionId);

    const es = new EventSource(
        `${BASE_URL}/stream?session_id=${encodeURIComponent(sessionId)}&session_type=${encodeURIComponent(sessionType)}`
    );

    const boundSessionId = sessionId;

    es.onopen = function () {
        console.log(`[Frontend] SSE 已打开: ${boundSessionId}`);
        connectionStatus.set(boundSessionId, 'connected');
        if (boundSessionId === currentSessionId) {
            updateConnectionButton();
        }
        renderChatList();
    };

    es.onmessage = function (event) {
        const payload = JSON.parse(event.data);
        handleServerEvent(payload, boundSessionId);
    };

    es.onerror = function (err) {
        if (eventSources.get(boundSessionId) !== es) {
            console.log(`[Frontend] 忽略过时 SSE 错误 (${boundSessionId})`);
            return;
        }
        console.error(`[Frontend] SSE 连接错误 (${boundSessionId})`, err);
        if (es.readyState === EventSource.CLOSED) {
            connectionStatus.set(boundSessionId, 'disconnected');
            eventSources.delete(boundSessionId);
            if (boundSessionId === currentSessionId) {
                updateConnectionButton();
            }
            renderChatList();

            setTimeout(() => {
                if (connectionStatus.get(boundSessionId) !== 'disconnected') {
                    console.log(`[Frontend] 自动重连: ${boundSessionId}`);
                    connectSSE(boundSessionId);
                }
            }, 3000);
        }
    };

    eventSources.set(sessionId, es);
    connectionStatus.set(sessionId, 'connected');

    if (sessionId === currentSessionId) {
        updateConnectionButton();
    }
    renderChatList();
}

// ---- 服务端事件处理 ----
function handleServerEvent(payload, sessionId) {
    const isCurrentSession = (sessionId === currentSessionId);

    switch (payload.event) {
        case 'start':
            isGenerating.set(sessionId, true);
            if (isCurrentSession) {
                hideFollowUpHint();
                activeAssistantMessageBubble = appendMessageBubble('assistant', '');
                updateSendBtnState();
            } else {
                console.log(`[Frontend] 后台会话 ${sessionId} 开始生成`);
            }
            break;

        case 'content':
            if (isCurrentSession) {
                if (!activeAssistantMessageBubble) {
                    activeAssistantMessageBubble = appendMessageBubble('assistant', '');
                }
                activeAssistantMessageBubble.querySelector('.msg-text').textContent += payload.data;
                scrollToBottom();
            }
            break;

        case 'tool_status':
            if (isCurrentSession) {
                handleToolStatusForCurrent(payload, sessionId);
            } else {
                handleToolStatusForBackground(payload, sessionId);
            }
            break;

        case 'end':
            isGenerating.set(sessionId, false);
            if (isCurrentSession) {
                if (activeAssistantMessageBubble) {
                    const txt = activeAssistantMessageBubble.querySelector('.msg-text').textContent;
                    if (txt.trim()) saveAssistantToLocal(sessionId, txt);
                }
                activeAssistantMessageBubble = null;
                updateSendBtnState();
                showFollowUpHint();
            } else {
                console.log(`[Frontend] 后台会话 ${sessionId} 生成完成，同步历史`);
                syncAndRenderHistory(sessionId).then(() => {
                    if (currentSessionId === sessionId) {
                        reRenderMessages(sessionId);
                    }
                });
            }
            break;

        case 'error':
            isGenerating.set(sessionId, false);
            if (isCurrentSession) {
                appendMessageBubble('assistant', `[\u7CFB\u7EDF\u9519\u8BEF]: ${payload.error_msg}`);
                activeAssistantMessageBubble = null;
                updateSendBtnState();
                showFollowUpHint();
            } else {
                console.error(`[Frontend] 后台会话 ${sessionId} 错误: ${payload.error_msg}`);
            }
            break;

        case 'interrupt':
            isGenerating.set(sessionId, false);
            if (isCurrentSession) {
                appendMessageBubble('assistant', '\u23F9 \u751F\u6210\u5DF2\u7EC8\u6B62');
                activeAssistantMessageBubble = null;
                updateSendBtnState();
                showFollowUpHint();
            } else {
                console.log(`[Frontend] 后台会话 ${sessionId} 生成已终止`);
            }
            break;
    }
}

// ---- 工具状态处理（当前会话） ----
function handleToolStatusForCurrent(payload, sessionId) {
    if (payload.status === 'start') {
        if (activeAssistantMessageBubble) {
            const txt = activeAssistantMessageBubble.querySelector('.msg-text').textContent;
            if (txt.trim()) {
                saveAssistantToLocal(sessionId, txt);
            } else {
                // 【修复点】：如果这个气泡是空的，彻底从页面 DOM 节点中删除它，不留占位！
                activeAssistantMessageBubble.remove();
            }
            activeAssistantMessageBubble = null;
        }
        
        const toolBubble = appendMessageBubble('tool', `⚙️ 正在调用工具: ${payload.name} ...`);
        activeToolBubbles[payload.name] = toolBubble;
    } else if (payload.status === 'result') {
        const toolBubble = activeToolBubbles[payload.name];
        if (toolBubble) {
            const statusIcon = payload.executed_well ? '\u2705' : '\u274C';

            const escHtml = (s) => String(s)
                .replace(/&/g, "&" + "amp;")
                .replace(/</g, "&" + "lt;")
                .replace(/>/g, "&" + "gt;");

            const escArgs = escHtml(payload.tool_args || "{}");
            const escOutput = escHtml(payload.result_data || "\u65E0\u8FD4\u56DE\u7ED3\u679C");

            const htmlContent = [
                '<details open>',
                '<summary>\u2699\uFE0F \u5DE5\u5177 [', escHtml(payload.name), '] \u6267\u884C\u5B8C\u6BD5 ', statusIcon, '</summary>',
                '<div class="tool-section-label">\uD83D\uDCE5 \u8F93\u5165\u53C2\u6570</div>',
                '<pre class="tool-output tool-input">', escArgs, '</pre>',
                '<div class="tool-section-label">\uD83D\uDCE4 \u8F93\u51FA\u7ED3\u679C</div>',
                '<pre class="tool-output">', escOutput, '</pre>',
                '</details>'
            ].join('');

            toolBubble.querySelector('.msg-text').innerHTML = htmlContent;
            saveMessageToLocal(sessionId, 'tool', htmlContent, true);
            delete activeToolBubbles[payload.name];
            scrollToBottom();
        }
    }
}

// ---- 工具状态处理（后台会话） ----
function handleToolStatusForBackground(payload, sessionId) {
    if (payload.status === 'result') {
        const escHtml = (s) => String(s)
            .replace(/&/g, "&" + "amp;")
            .replace(/</g, "&" + "lt;")
            .replace(/>/g, "&" + "gt;");
        const escArgs = escHtml(payload.tool_args || "{}");
        const escOutput = escHtml(payload.result_data || "\u65E0\u8FD4\u56DE\u7ED3\u679C");
        const statusIcon = payload.executed_well ? '\u2705' : '\u274C';
        const htmlContent = [
            '<details open>',
            '<summary>\u2699\uFE0F \u5DE5\u5177 [', escHtml(payload.name), '] \u6267\u884C\u5B8C\u6BD5 ', statusIcon, '</summary>',
            '<div class="tool-section-label">\uD83D\uDCE5 \u8F93\u5165\u53C2\u6570</div>',
            '<pre class="tool-output tool-input">', escArgs, '</pre>',
            '<div class="tool-section-label">\uD83D\uDCE4 \u8F93\u51FA\u7ED3\u679C</div>',
            '<pre class="tool-output">', escOutput, '</pre>',
            '</details>'
        ].join('');
        saveMessageToLocal(sessionId, 'tool', htmlContent, true);
        console.log(`[Frontend] 后台会话 ${sessionId} 工具 [${payload.name}] 结果已保存`);
    }
}

// ---- 消息发送 ----
async function sendMessage() {
    // ★ 如果正在生成，改为发送终止指令
    if (isGenerating.get(currentSessionId)) {
        await sendInterrupt();
        return;
    }

    const text = messageInput.value.trim();
    if (!text || !currentSessionId) return;

    hideFollowUpHint();
    appendMessageBubble('user', text);
    saveMessageToLocal(currentSessionId, 'user', text);
    messageInput.value = '';
    sendBtn.disabled = true;

    try {
        const sessionType = getSessionType(currentSessionId);

        const response = await fetch(
            `${BASE_URL}/str-input?session_id=${encodeURIComponent(currentSessionId)}&session_type=${encodeURIComponent(sessionType)}&user_input=${encodeURIComponent(text)}`,
            { method: 'POST' }
        );
        const result = await response.json();
        if (result.status !== 'started') {
            throw new Error("\u542F\u52A8\u5BF9\u8BDD\u4EFB\u52A1\u5931\u8D25");
        }
    } catch (error) {
        console.error("[Frontend] 消息发送异常:", error);
        appendMessageBubble('assistant', `[\u7F51\u7EDC\u9519\u8BEF]: \u65E0\u6CD5\u8FDE\u63A5\u5230\u751F\u6210\u8282\u70B9\u3002`);
        sendBtn.disabled = false;
    }
}

// ---- 中断指令 ----
async function sendInterrupt() {
    if (!currentSessionId) return;
    try {
        const sessionType = getSessionType(currentSessionId);
        await fetch(
            `${BASE_URL}/cmd?session_id=${encodeURIComponent(currentSessionId)}&session_type=${encodeURIComponent(sessionType)}&cmd=interrupt`,
            { method: 'POST' }
        );
        console.log('[Frontend] 已发送中断指令');
    } catch (err) {
        console.error('[Frontend] 发送中断指令失败:', err);
    }
}

// ---- 本地持久化 ----
function saveMessageToLocal(sessionId, role, content, isHtml = false) {
    if (!localSessionsData[sessionId]) {
        localSessionsData[sessionId] = [];
    }
    if (role !== 'assistant' || isHtml) {
        localSessionsData[sessionId].push({
            role,
            content,
            isHtml,
            time: new Date().toISOString()
        });
    }
    saveLocalData();
}

function saveAssistantToLocal(sessionId, content) {
    if (!localSessionsData[sessionId]) {
        localSessionsData[sessionId] = [];
    }
    localSessionsData[sessionId].push({
        role: 'assistant',
        content: content,
        isHtml: false,
        time: new Date().toISOString()
    });
    saveLocalData();
}

// ========== 压缩流程 ==========

async function startCompact() {
    if (isCompacting) return;
    if (!currentSessionId || (!currentSessionId.startsWith('main_') && currentSessionId !== 'main')) return;

    isCompacting = true;
    updateCompactButton();

    compactPanel.classList.add('open');
    compactContent.textContent = '';
    compactStatus.textContent = '\u6B65\u9AA4 1/4: \u4FDD\u5B58\u4E3B\u4F1A\u8BDD...';
    compactStatus.className = 'compact-status';

    try {
        console.log('[Compact] 步骤 1: 刷新主会话内存到磁盘');
        const flushRes = await fetch(
            `${BASE_URL}/cmd?session_id=${encodeURIComponent(currentSessionId)}&session_type=main&cmd=flush`,
            { method: 'POST' }
        );
        console.log('[Compact] flush 完成:', await flushRes.json());

        compactSessionId = currentSessionId;
        compactStatus.textContent = '\u6B65\u9AA4 2/4: \u542F\u52A8\u538B\u7F29\u4F1A\u8BDD...';
        console.log(`[Compact] 步骤 2: 启动 compact 会话 ${compactSessionId}`);

        const inputRes = await fetch(
            `${BASE_URL}/str-input?session_id=${encodeURIComponent(compactSessionId)}&session_type=compact&user_input=${encodeURIComponent('\u8BF7\u5BF9\u4E0A\u9762\u7684\u6240\u6709\u5BF9\u8BDD\u8FDB\u884C\u63D0\u70BC\u548C\u538B\u7F29\u3002')}`,
            { method: 'POST' }
        );
        console.log('[Compact] str-input 完成:', await inputRes.json());

        compactStatus.textContent = '\u6B65\u9AA4 3/4: AI \u6B63\u5728\u751F\u6210\u538B\u7F29\u603B\u7ED3...';
        console.log(`[Compact] 步骤 3: 连接 compact SSE`);

        compactEventSource = new EventSource(
            `${BASE_URL}/stream?session_id=${encodeURIComponent(compactSessionId)}&session_type=compact`
        );

        compactEventSource.onmessage = function (event) {
            const payload = JSON.parse(event.data);
            handleCompactEvent(payload);
        };

        compactEventSource.onerror = function (err) {
            console.error(`[Compact] SSE 错误:`, err);
        };

    } catch (err) {
        console.error('[Compact] 压缩流程异常:', err);
        compactStatus.textContent = '\u274C \u538B\u7F29\u5931\u8D25';
        compactStatus.className = 'compact-status error';
        finishCompact();
    }
}

function handleCompactEvent(payload) {
    const eventType = payload.event;

    switch (eventType) {
        case 'start':
            console.log('[Compact] 开始接收压缩内容');
            compactContent.textContent = '';
            break;

        case 'content':
            if (payload.data) {
                compactContent.textContent += payload.data;
                compactPanel.scrollTop = compactPanel.scrollHeight;
            }
            break;

        case 'end':
            console.log('[Compact] 压缩结束，触发步骤 4: refresh main');
            compactStatus.textContent = '\u6B65\u9AA4 4/4: \u5237\u65B0\u4E3B\u4F1A\u8BDD...';

            if (compactEventSource) {
                compactEventSource.close();
                compactEventSource = null;
            }

            finishCompactWithRefresh();
            break;

        case 'error':
            console.error('[Compact] 服务端错误:', payload.error_msg);
            compactStatus.textContent = `\u274C ${payload.error_msg}`;
            compactStatus.className = 'compact-status error';
            if (compactEventSource) {
                compactEventSource.close();
                compactEventSource = null;
            }
            finishCompact();
            break;
    }
}

async function finishCompactWithRefresh() {
    try {
        const refreshRes = await fetch(
            `${BASE_URL}/cmd?session_id=${encodeURIComponent(currentSessionId)}&session_type=main&cmd=refresh`,
            { method: 'POST' }
        );
        const refreshData = await refreshRes.json();
        console.log('[Compact] refresh 完成:', refreshData);

        await syncAndRenderHistory(currentSessionId);
        reRenderMessages(currentSessionId);

        compactStatus.textContent = '\u2705 \u538B\u7F29\u5B8C\u6210\uFF01\u4E3B\u4F1A\u8BDD\u5DF2\u66F4\u65B0';
        compactStatus.className = 'compact-status done';
    } catch (err) {
        console.error('[Compact] refresh 异常:', err);
        compactStatus.textContent = '\u26A0\uFE0F \u603B\u7ED3\u5DF2\u751F\u6210\uFF0C\u4F46\u4E3B\u4F1A\u8BDD\u5237\u65B0\u5931\u8D25';
        compactStatus.className = 'compact-status error';
    }

    setTimeout(() => {
        compactPanel.classList.remove('open');
    }, 3000);

    finishCompact();
}

function finishCompact() {
    isCompacting = false;
    compactSessionId = null;
    if (compactEventSource) {
        compactEventSource.close();
        compactEventSource = null;
    }
    updateCompactButton();
}

// ---- 页面卸载清理 ----
window.addEventListener('beforeunload', () => {
    eventSources.forEach((es, sid) => {
        es.close();
        console.log(`[Frontend] 页面卸载，关闭 SSE: ${sid}`);
    });
    eventSources.clear();
    if (compactEventSource) {
        compactEventSource.close();
        compactEventSource = null;
    }
});