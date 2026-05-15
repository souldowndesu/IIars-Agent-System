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

// 压缩状态
let isCompacting = false;
let compactEventSource = null;
let compactSessionId = null;

// 前端本地存储
let localSessionsData = JSON.parse(localStorage.getItem('chatSessions')) || {};

// 已隐藏的临时会话 ID 集合（数据不删除，仅从侧边栏隐藏）
let hiddenTempIds = new Set(JSON.parse(localStorage.getItem('hiddenTempIds')) || []);

// 格式化时间戳为本地可读时间
function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 生成带前缀的 session_id
function generateSessionId(type) {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
    let shortId = '';
    for (let i = 0; i < 6; i++) {
        shortId += chars[Math.floor(Math.random() * chars.length)];
    }
    return `${type}_${shortId}`;
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

// 初始化
function init() {
    // 确保 main 会话存在并默认加载
    const mainId = getMainSessionId();
    switchSession(mainId);

    newChatBtn.addEventListener('click', createTempChat);
    if (cleanTempBtn) {
        cleanTempBtn.addEventListener('click', cleanTempChats);
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
        if (id.startsWith('main_')) {
            mainSessions.push(id);
        } else if (id.startsWith('temp_')) {
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

    const ordered = [...mainSessions, ...visibleTempIds, ...otherSessions];
    const totalVisibleTemp = visibleTempIds.length;

    // 更新清理按钮状态
    if (cleanTempBtn) {
        cleanTempBtn.disabled = totalVisibleTemp === 0;
    }

    ordered.forEach(id => {
        const li = document.createElement('li');
        li.classList.add('chat-item');

        // 根据前缀加不同图标
        let icon = '💬';
        if (id.startsWith('main_')) icon = '⭐';
        else if (id.startsWith('temp_')) icon = '🕐';

        // 显示名称：前缀 + 短ID 后4位 + 消息数
        const parts = id.split('_');
        const typeLabel = parts[0];
        const shortSuffix = parts.length > 1 ? parts.slice(1).join('_').slice(-4) : id.slice(-4);
        const msgCount = (localSessionsData[id] || []).length;
        li.textContent = `${icon} ${typeLabel}_${shortSuffix} (${msgCount})`;

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
        id => id.startsWith('temp_') && !hiddenTempIds.has(id)
    );
    if (visibleTempIds.length === 0) return;

    // 如果当前在 temp 会话，先切到 main
    if (currentSessionId && currentSessionId.startsWith('temp_')) {
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
    const parts = sessionId.split('_');
    const typeLabel = parts.length > 1 ? parts[0] : 'unknown';
    const shortSuffix = parts.length > 1 ? parts.slice(1).join('_').slice(-6) : sessionId.slice(-6);
    currentSessionTitle.textContent = `[${typeLabel}] ${shortSuffix}`;

    // 从服务端同步最新历史，覆盖 localStorage 缓存
    messagesContainer.innerHTML = '';
    try {
        const sessionType = parts.length > 1 ? parts[0] : 'chat';
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
    if (currentSessionId && currentSessionId.startsWith('main_')) {
        compactBtn.style.display = '';
        compactBtn.disabled = isCompacting;
    } else {
        compactBtn.style.display = 'none';
    }
}

// ========== 压缩流程 ==========

async function startCompact() {
    if (isCompacting) return;
    if (!currentSessionId || !currentSessionId.startsWith('main_')) return;
    if (isCompacting) return;

    isCompacting = true;
    updateCompactButton();
    
    // 显示面板
    compactPanel.classList.add('open');
    compactContent.textContent = '';
    compactStatus.textContent = '步骤 1/4: 保存主会话...';
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
        compactStatus.textContent = '步骤 2/4: 启动压缩会话...';
        console.log(`[Compact] 步骤 2: 启动 compact 会话 ${compactSessionId}`);

        const inputRes = await fetch(
            `${BASE_URL}/str-input?session_id=${encodeURIComponent(compactSessionId)}&session_type=compact&user_input=${encodeURIComponent('请对上面的所有对话进行提炼和压缩。')}`,
            { method: 'POST' }
        );
        console.log('[Compact] str-input 完成:', await inputRes.json());

        // 步骤 3: 建立 compact SSE，接收压缩结果
        compactStatus.textContent = '步骤 3/4: AI 正在生成压缩总结...';
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
        compactStatus.textContent = '❌ 压缩失败';
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
            compactStatus.textContent = '步骤 4/4: 刷新主会话...';
            
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
            compactStatus.textContent = `❌ ${payload.error_msg}`;
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
        
        compactStatus.textContent = '✅ 压缩完成！主会话已更新';
        compactStatus.className = 'compact-status done';
    } catch (err) {
        console.error('[Compact] refresh 异常:', err);
        compactStatus.textContent = '⚠️ 总结已生成，但主会话刷新失败';
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

    const sessionParts = sessionId.split('_');
    const sessionType = sessionParts.length > 1 ? sessionParts[0] : 'chat';

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
                const toolBubble = appendMessageBubble('tool', `⚙️ 正在调用工具: ${payload.name} ...`);
                activeToolBubbles[payload.name] = toolBubble;
            } else if (payload.status === 'result') {
                const toolBubble = activeToolBubbles[payload.name];
                if (toolBubble) {
                    const statusIcon = payload.executed_well ? '✅' : '❌';

                    const escHtml = (s) => String(s)
                        .replace(/&/g, "&" + "amp;")
                        .replace(/</g, "&" + "lt;")
                        .replace(/>/g, "&" + "gt;");

                    const escArgs = escHtml(payload.tool_args || "{}");
                    const escOutput = escHtml(payload.result_data || "无返回结果");

                    const htmlContent = [
                        '<details open>',
                        '<summary>⚙️ 工具 [', escHtml(payload.name), '] 执行完毕 ', statusIcon, '</summary>',
                        '<div class="tool-section-label">📥 输入参数</div>',
                        '<pre class="tool-output tool-input">', escArgs, '</pre>',
                        '<div class="tool-section-label">📤 输出结果</div>',
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
            break;

        case 'error':
            appendMessageBubble('assistant', `[系统错误]: ${payload.error_msg}`);
            activeAssistantMessageBubble = null;
            sendBtn.disabled = false;
            break;
    }
}

// 发送消息
async function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || !currentSessionId) return;

    appendMessageBubble('user', text);
    saveMessageToLocal(currentSessionId, 'user', text);
    messageInput.value = '';
    sendBtn.disabled = true;

    try {
        const sessionParts = currentSessionId.split('_');
        const sessionType = sessionParts.length > 1 ? sessionParts[0] : 'chat';

        const response = await fetch(
            `${BASE_URL}/str-input?session_id=${encodeURIComponent(currentSessionId)}&session_type=${encodeURIComponent(sessionType)}&user_input=${encodeURIComponent(text)}`,
            { method: 'POST' }
        );
        const result = await response.json();
        if (result.status !== 'started') {
            throw new Error("启动对话任务失败");
        }
    } catch (error) {
        console.error("[Frontend] 消息发送异常:", error);
        appendMessageBubble('assistant', `[网络错误]: 无法连接到生成节点。`);
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

// 滚动到底部
function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

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

// 启动
init();