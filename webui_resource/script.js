const BASE_URL = 'http://127.0.0.1:8001';

// DOM 元素引用
const newChatBtn = document.getElementById('new-chat-btn');
const cleanTempBtn = document.getElementById('clean-temp-btn');
const compactBtn = document.getElementById('compact-btn');
const compactPanel = document.getElementById('compact-panel');
const compactStatus = document.getElementById('compact-status');
const compactContent = document.getElementById('compact-content');
const chatListUl = document.getElementById('chat-list');
const messagesContainer = document.getElementById('messages-container');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const currentSessionTitle = document.getElementById('current-session-title');

// 状态管理
let currentSessionId = null;
let currentEventSource = null;
let activeAssistantMessageBubble = null;
let activeToolBubbles = {};

// 用户手动上翻标记（用于阻止自动滚动）
let userManuallyScrolledUp = false;

// 压缩状态
let isCompacting = false;
let compactEventSource = null;
let compactSessionId = null;

// 前端本地存储
let localSessionsData = JSON.parse(localStorage.getItem('chatSessions')) || {};

// 已隐藏的临时会话 ID 集合（数据不删除，仅从侧边栏隐藏）
let hiddenTempIds = new Set(JSON.parse(localStorage.getItem('hiddenTempIds')) || []);

// 清理 localStorage 中无效/旧格式的会话条目（只保留 main_* 和 temp-N 格式）
function sanitizeLocalStorage() {
    const validKeys = {};
    let maxTempNum = 0;
    Object.keys(localSessionsData).forEach(key => {
        if (key.startsWith('main_')) {
            // 只保留第一个 main_ 会话
            if (!Object.keys(validKeys).some(k => k.startsWith('main_'))) {
                validKeys[key] = localSessionsData[key];
            }
        } else if (/^temp-\d+$/.test(key)) {
            // 保留有效 temp-N 格式
            validKeys[key] = localSessionsData[key];
            const num = parseInt(key.replace('temp-', ''), 10);
            if (num > maxTempNum) maxTempNum = num;
        }
        // 丢弃所有其他格式（compact_、chat_、temp_xxx 旧格式等）
    });
    if (maxTempNum > 0) {
        localStorage.setItem('tempCounter', String(maxTempNum));
    }
    localSessionsData = validKeys;
    saveLocalData();
    // 清理隐藏列表中的无效条目
    const validHiddenSet = new Set();
    hiddenTempIds.forEach(id => {
        if (/^temp-\d+$/.test(id)) validHiddenSet.add(id);
    });
    hiddenTempIds = validHiddenSet;
    localStorage.setItem('hiddenTempIds', JSON.stringify([...hiddenTempIds]));
}

// 格式化时间戳为本地可读时间
function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 生成带前缀的 session_id（temp 使用递增编号 temp-1, temp-2 ...）
function generateSessionId(type) {
    if (type === 'temp') {
        const nextNum = (parseInt(localStorage.getItem('tempCounter')) || 0) + 1;
        localStorage.setItem('tempCounter', nextNum);
        return `temp-${nextNum}`;
    }
    // compact 仍用随机后缀（不在侧边栏显示，无影响）
    if (type === 'compact') {
        const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
        let shortId = '';
        for (let i = 0; i < 6; i++) {
            shortId += chars[Math.floor(Math.random() * chars.length)];
        }
        return `compact_${shortId}`;
    }
    // main 保持原有随机逻辑
    const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
    let shortId = '';
    for (let i = 0; i < 6; i++) {
        shortId += chars[Math.floor(Math.random() * chars.length)];
    }
    return `main_${shortId}`;
}

// 获取 main 会话 ID（始终用固定的 main_ 前缀，若不存在则创建）
function getMainSessionId() {
    const mainKey = Object.keys(localSessionsData).find(k => k.startsWith('main_'));
    if (mainKey) return mainKey;
    const newMainId = generateSessionId('main');
    localSessionsData[newMainId] = [];
    saveLocalData();
    return newMainId;
}

// 从 sessionId 解析出 session_type（兼容 temp-N 新格式和 main_xxx / compact_xxx 旧格式）
function getSessionType(sessionId) {
    if (sessionId.startsWith('temp-')) return 'temp';
    if (sessionId.includes('_')) return sessionId.split('_')[0];
    return 'chat';
}

// 初始化
function init() {
    // 清理旧格式数据，确保只有 main_* 和 temp-N 格式的会话
    sanitizeLocalStorage();

    // 确保 main 会话存在并默认加载
    const mainId = getMainSessionId();
    switchSession(mainId);

    // 禁用浏览器自动清除/自动补全按钮，防止hover触发异常
    if (messageInput) {
        messageInput.setAttribute('autocomplete', 'off');
        messageInput.setAttribute('spellcheck', 'false');
    }

    newChatBtn.addEventListener('click', createTempChat);
    if (cleanTempBtn) {
        cleanTempBtn.addEventListener('click', cleanTempChats);
        // 防止hover时触发任何意外数据变更
        cleanTempBtn.addEventListener('mouseenter', function(e) {
            e.stopPropagation();
        });
    }
    sendBtn.addEventListener('click', sendMessage);
    messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });
    if (compactBtn) {
        compactBtn.addEventListener('click', startCompact);
    }
}

// 渲染左侧会话列表（main 永远靠前，temp 排后，时间最近的在同类里靠上）
function renderChatList() {
    chatListUl.innerHTML = '';

    const mainSessions = [];
    const tempSessions = [];
    const otherSessions = [];

    Object.keys(localSessionsData).forEach(id => {
        // 跳过 compact_ 内部会话（不在侧边栏显示）
        if (id.startsWith('compact_')) return;
        if (id.startsWith('main_') || id === 'main') {
            mainSessions.push(id);
        } else if (id.startsWith('temp-') || id.startsWith('temp_')) {
            tempSessions.push(id);
        } else {
            otherSessions.push(id);
        }
    });

    // 过滤掉已隐藏的 temp 会话
    const visibleTempIds = tempSessions.filter(id => !hiddenTempIds.has(id));

    // 同类内按首条消息时间倒序（最新在前）
    const sortByFirstTime = (a, b) => {
        const msgsA = localSessionsData[a] || [];
        const msgsB = localSessionsData[b] || [];
        const timeA = msgsA.length > 0 ? (msgsA[0].time || '') : '';
        const timeB = msgsB.length > 0 ? (msgsB[0].time || '') : '';
        return timeB.localeCompare(timeA);
    };
    mainSessions.sort(sortByFirstTime);
    visibleTempIds.sort(sortByFirstTime);
    otherSessions.sort(sortByFirstTime);

    // 只显示 main 和 temp 会话，过滤掉旧版 chat_* 等杂项
    const ordered = [...mainSessions, ...visibleTempIds];
    const totalVisibleTemp = visibleTempIds.length;

    // 更新清理按钮状态
    if (cleanTempBtn) {
        cleanTempBtn.disabled = totalVisibleTemp === 0;
    }

    ordered.forEach(id => {
        // 跳过 compact_ 内部会话（不在侧边栏显示）
        if (id.startsWith('compact_')) return;

        const li = document.createElement('li');
        li.classList.add('chat-item');

        // 根据前缀加不同图标
        let icon = '\uD83D\uDCAC'; // 💬
        if (id.startsWith('main_') || id === 'main') icon = '\u2B50'; // ⭐
        else if (id.startsWith('temp-') || id.startsWith('temp_')) icon = '\uD83D\uDD50'; // 🕐

        // 显示名称：temp-N 直接显示；main_xxx 显示 main-xxx后6位
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

// 新建临时对话
function createTempChat() {
    const newId = generateSessionId('temp');
    localSessionsData[newId] = [];
    saveLocalData();
    switchSession(newId);
}

// 清理临时对话（仅隐藏，不删除 localStorage 记录）
function cleanTempChats() {
    const visibleTempIds = Object.keys(localSessionsData).filter(
        id => (id.startsWith('temp-') || id.startsWith('temp_')) && !hiddenTempIds.has(id)
    );
    if (visibleTempIds.length === 0) return;

    // 如果当前在 temp 会话，先切到 main
    if (currentSessionId && (currentSessionId.startsWith('temp-') || currentSessionId.startsWith('temp_'))) {
        const mainId = getMainSessionId();
        switchSession(mainId);
    }

    // 将所有当前可见的 temp 加入隐藏集合
    visibleTempIds.forEach(id => hiddenTempIds.add(id));
    localStorage.setItem('hiddenTempIds', JSON.stringify([...hiddenTempIds]));

    renderChatList();
    console.log(`[Frontend] 已隐藏 ${visibleTempIds.length} 个临时对话（数据未删除）`);
}

// 切换对话
async function switchSession(sessionId) {
    if (currentSessionId === sessionId) return;

    if (currentEventSource) {
        currentEventSource.close();
        console.log(`[Frontend] 已主动断开会话 ${currentSessionId} 的连接`);
        currentEventSource = null;
    }

    currentSessionId = sessionId;

    // 更新标题
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

    // 隐藏提示
    hideFollowUpHint();

    // 从服务端同步最新历史，覆盖 localStorage 缓存
    messagesContainer.innerHTML = '';
    try {
        const sessionType = getSessionType(sessionId);
        const resp = await fetch(
            `${BASE_URL}/get-history?session_id=${encodeURIComponent(sessionId)}&session_type=${encodeURIComponent(sessionType)}`
        );
        const data = await resp.json();
        if (data.status === 'ok' && data.messages && data.messages.length > 0) {
            // 用服务端数据更新 localStorage
            localSessionsData[sessionId] = data.messages;
            saveLocalData();
            console.log(`[Frontend] 从服务端同步了 ${data.messages.length} 条消息 (${sessionId})`);
        }
    } catch (err) {
        console.warn('[Frontend] 服务端历史同步失败，降级使用本地缓存:', err);
    }

    // 恢复历史消息
    const history = localSessionsData[sessionId] || [];
    history.forEach(msg => {
        appendMessageBubble(msg.role, msg.content, msg.isHtml, msg.time);
    });

    messageInput.disabled = false;
    sendBtn.disabled = false;

    renderChatList();
    connectSSE(sessionId);

    // 更新压缩按钮状态
    updateCompactButton();
}

// 更新压缩按钮可见性和状态
function updateCompactButton() {
    if (!compactBtn) return;
    if (currentSessionId && (currentSessionId.startsWith('main_') || currentSessionId === 'main')) {
        compactBtn.style.display = '';
        compactBtn.disabled = isCompacting;
    } else {
        compactBtn.style.display = 'none';
    }
}

// ========== 压缩流程 ==========

async function startCompact() {
    if (isCompacting) return;
    if (!currentSessionId || (!currentSessionId.startsWith('main_') && currentSessionId !== 'main')) return;

    isCompacting = true;
    updateCompactButton();

    // 显示面板
    compactPanel.classList.add('open');
    compactContent.textContent = '';
    compactStatus.textContent = '\u6B65\u9AA4 1/4: \u4FDD\u5B58\u4E3B\u4F1A\u8BDD...';
    compactStatus.className = 'compact-status';

    try {
        // 步骤 1: flush main 会话
        console.log('[Compact] 步骤 1: 刷新主会话内存到磁盘');
        const flushRes = await fetch(
            `${BASE_URL}/cmd?session_id=${encodeURIComponent(currentSessionId)}&session_type=main&cmd=flush`,
            { method: 'POST' }
        );
        console.log('[Compact] flush 完成:', await flushRes.json());

        // 步骤 2: 发送压缩指令到 compact 会话
        compactSessionId = generateSessionId('compact');
        compactStatus.textContent = '\u6B65\u9AA4 2/4: \u542F\u52A8\u538B\u7F29\u4F1A\u8BDD...';
        console.log(`[Compact] 步骤 2: 启动 compact 会话 ${compactSessionId}`);

        const inputRes = await fetch(
            `${BASE_URL}/str-input?session_id=${encodeURIComponent(compactSessionId)}&session_type=compact&user_input=${encodeURIComponent('\u8BF7\u5BF9\u4E0A\u9762\u7684\u6240\u6709\u5BF9\u8BDD\u8FDB\u884C\u63D0\u70BC\u548C\u538B\u7F29\u3002')}`,
            { method: 'POST' }
        );
        console.log('[Compact] str-input 完成:', await inputRes.json());

        // 步骤 3: 建立 compact SSE，接收压缩结果
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

            // 自动触发 refresh（步骤 4）
            if (compactEventSource) {
                compactEventSource.close();
                compactEventSource = null;
            }

            // 异步执行 refresh + 完成清理
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
        // 步骤 4: refresh main
        const refreshRes = await fetch(
            `${BASE_URL}/cmd?session_id=${encodeURIComponent(currentSessionId)}&session_type=main&cmd=refresh`,
            { method: 'POST' }
        );
        const refreshData = await refreshRes.json();
        console.log('[Compact] refresh 完成:', refreshData);

        compactStatus.textContent = '\u2705 \u538B\u7F29\u5B8C\u6210\uFF01\u4E3B\u4F1A\u8BDD\u5DF2\u66F4\u65B0';
        compactStatus.className = 'compact-status done';
    } catch (err) {
        console.error('[Compact] refresh 异常:', err);
        compactStatus.textContent = '\u26A0\uFE0F \u603B\u7ED3\u5DF2\u751F\u6210\uFF0C\u4F46\u4E3B\u4F1A\u8BDD\u5237\u65B0\u5931\u8D25';
        compactStatus.className = 'compact-status error';
    }

    // 延迟后收起面板
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

// 建立 SSE 连接
function connectSSE(sessionId) {
    console.log(`[Frontend] 尝试连接到会话: ${sessionId}`);

    const sessionType = getSessionType(sessionId);

    currentEventSource = new EventSource(
        `${BASE_URL}/stream?session_id=${encodeURIComponent(sessionId)}&session_type=${encodeURIComponent(sessionType)}`
    );

    currentEventSource.onmessage = function (event) {
        const payload = JSON.parse(event.data);
        handleServerEvent(payload);
    };

    currentEventSource.onerror = function (err) {
        console.error(`[Frontend] SSE 连接发生错误 (会话: ${sessionId})`, err);
    };
}

// 处理服务端事件
function handleServerEvent(payload) {
    switch (payload.event) {
        case 'start':
            hideFollowUpHint();
            userManuallyScrolledUp = false;  // 新一轮对话，重置滚动标记
            activeAssistantMessageBubble = appendMessageBubble('assistant', '');
            break;

        case 'content':
            if (activeAssistantMessageBubble) {
                activeAssistantMessageBubble.querySelector('.msg-text').textContent += payload.data;
                scrollToBottom();
            }
            break;

        case 'tool_status':
            if (payload.status === 'start') {
                const toolBubble = appendMessageBubble('tool', `\u2699\uFE0F \u6B63\u5728\u8C03\u7528\u5DE5\u5177: ${payload.name} ...`);
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
                    saveMessageToLocal(currentSessionId, 'tool', htmlContent, true);
                    delete activeToolBubbles[payload.name];
                    scrollToBottom();
                }
            }
            break;

        case 'end':
            if (activeAssistantMessageBubble) {
                saveAssistantToLocal(currentSessionId, activeAssistantMessageBubble.querySelector('.msg-text').textContent);
            }
            activeAssistantMessageBubble = null;
            sendBtn.disabled = false;
            showFollowUpHint();
            break;

        case 'error':
            appendMessageBubble('assistant', `[\u7CFB\u7EDF\u9519\u8BEF]: ${payload.error_msg}`);
            activeAssistantMessageBubble = null;
            sendBtn.disabled = false;
            showFollowUpHint();
            break;
    }
}

// 发送消息
async function sendMessage() {
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

// 添加消息气泡（结构：气泡 > 时间戳行 + 正文行）
function appendMessageBubble(role, content, isHtml = false, savedTime = null) {
    const time = savedTime || new Date().toISOString();

    const wrapper = document.createElement('div');
    wrapper.classList.add('message-bubble');
    wrapper.classList.add(role);

    // 时间戳行
    const timeDiv = document.createElement('div');
    timeDiv.classList.add('msg-time');
    timeDiv.textContent = formatTime(time);

    // 正文行
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

// 智能滚动到底部：仅当用户在底部附近且未手动上翻时才自动滚动
function scrollToBottom() {
    const threshold = 80; // 距离底部80px以内视为"在底部"
    const isNearBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < threshold;
    // 只有用户在底部附近且没有手动上翻时才自动滚动
    if (isNearBottom && !userManuallyScrolledUp) {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
}

// 监听用户手动滚动行为（支持鼠标滚轮、触摸板、滚动条拖动、键盘翻页等所有滚动方式）
// 1) wheel 事件：精准判断方向
messagesContainer.addEventListener('wheel', function(e) {
    if (e.deltaY < 0) {
        userManuallyScrolledUp = true;
    } else if (e.deltaY > 0) {
        const threshold = 10;
        const isAtBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < threshold;
        if (isAtBottom) {
            userManuallyScrolledUp = false;
        }
    }
});

// 2) scroll 事件：捕获滚动条拖动、键盘翻页等，判断是否在底部
messagesContainer.addEventListener('scroll', function() {
    const threshold = 10;
    const isAtBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < threshold;
    if (!isAtBottom) {
        userManuallyScrolledUp = true;
    } else {
        userManuallyScrolledUp = false;
    }
});

// 3) 触摸/拖动滚动（移动端支持）
messagesContainer.addEventListener('touchmove', function() {
    const threshold = 10;
    const isAtBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < threshold;
    if (!isAtBottom) {
        userManuallyScrolledUp = true;
    } else {
        userManuallyScrolledUp = false;
    }
});

// 持久化消息（带时间戳）
function saveMessageToLocal(sessionId, role, content, isHtml = false) {
    if (!localSessionsData[sessionId]) {
        localSessionsData[sessionId] = [];
    }
    // 如果正在渲染临时消息（由 assistant 产生），不立即保存，等 end 事件统一保存
    // user 消息和 tool 消息则立即保存
    if (role !== 'assistant' || isHtml) {
        localSessionsData[sessionId].push({
            role,
            content,
            isHtml,
            time: new Date().toISOString()
        });
    }
    // assistant 的最终保存由 handleServerEvent 中的 'end' 事件触发
    saveLocalData();
}

// 覆盖 assistant 保存（end 事件时调用）
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

function saveLocalData() {
    localStorage.setItem('chatSessions', JSON.stringify(localSessionsData));
}

// 显示连续对话提示（执行完成后在输入框下方显示）
function showFollowUpHint() {
    const hintEl = document.getElementById('follow-up-hint');
    if (hintEl) {
        hintEl.textContent = '\uD83D\uDCA1 \u4F60\u53EF\u4EE5\u7EE7\u7EED\u8FFD\u95EE\uFF0C\u6216\u8F93\u5165\u65B0\u95EE\u9898...';
        hintEl.style.opacity = '1';
    }
}

// 隐藏连续对话提示（用户开始新输入时）
function hideFollowUpHint() {
    const hintEl = document.getElementById('follow-up-hint');
    if (hintEl) {
        hintEl.style.opacity = '0';
        setTimeout(() => { hintEl.textContent = ''; }, 300);
    }
}

// 启动
init();