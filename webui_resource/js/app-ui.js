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

// ---- IntersectionObserver 哨兵滚动系统 ----
let scrollSentinel = null;
let sentinelObserver = null;
let isPinnedToBottom = true;   // true = 用户处于底部/跟随模式

function setupScrollSentinel() {
    // 创建哨兵元素（放在 messagesContainer 底部）
    scrollSentinel = document.createElement('div');
    scrollSentinel.id = 'scroll-sentinel';
    scrollSentinel.style.cssText = 'height:1px;width:100%;flex-shrink:0;';
    messagesContainer.appendChild(scrollSentinel);

    // IntersectionObserver：精准确认用户是否处于滚动容器底部
    sentinelObserver = new IntersectionObserver(
        (entries) => {
            // 当哨兵完全在视口内 → 用户在底部
            entries.forEach(entry => {
                isPinnedToBottom = entry.isIntersecting;
            });
        },
        {
            root: messagesContainer,
            threshold: 1.0    // 哨兵 100% 可见才算在底部
        }
    );
    sentinelObserver.observe(scrollSentinel);
}

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

    // DOM 引用就绪后立即建立哨兵
    setupScrollSentinel();
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
    // 在哨兵之前插入消息气泡
    messagesContainer.insertBefore(wrapper, scrollSentinel);
    scrollToBottom();
    return wrapper;
}


// ---- 历史消息重新渲染 ----
function reRenderMessages(sessionId) {
    const history = localSessionsData[sessionId] || [];

    // ★ 保存当前滚动状态（在清空前精确判断用户是否在底部）
    const savedScrollTop = messagesContainer.scrollTop;
    const savedScrollHeight = messagesContainer.scrollHeight;
    const savedClientHeight = messagesContainer.clientHeight;
    // ★ 关键修复：只有容器确实有可滚动内容时，才判定"在底部"
    // 空容器中 scrollHeight ≈ clientHeight，会导致永真误判
    const wasAtBottom = (savedScrollHeight > savedClientHeight + 10)
                     && (savedScrollTop + savedClientHeight >= savedScrollHeight - 2);

    // ★ 暂停哨兵观察，防止 DOM 替换期间误触发 isPinnedToBottom 改变
    if (sentinelObserver) sentinelObserver.disconnect();

    // ★ 创建 DocumentFragment，批量构建所有消息气泡
    var fragment = document.createDocumentFragment();

    // ★ 局部辅助函数：构建单个气泡 DOM（不触碰真实 DOM）
    function buildBubble(role, content, isHtml, time) {
        var wrapper = document.createElement('div');
        wrapper.classList.add('message-bubble');
        wrapper.classList.add(role);

        var timeDiv = document.createElement('div');
        timeDiv.classList.add('msg-time');
        timeDiv.textContent = formatTime(time);

        var textDiv = document.createElement('div');
        textDiv.classList.add('msg-text');
        if (isHtml) {
            textDiv.innerHTML = content;
        } else {
            textDiv.textContent = content;
        }

        wrapper.appendChild(timeDiv);
        wrapper.appendChild(textDiv);
        return wrapper;
    }

    var lastToolCalls = null;

    history.forEach(function (msg) {
        try {
            var rawContent = msg.content || '';

            if (msg.role === 'assistant' && msg.tool_calls) {
                lastToolCalls = msg.tool_calls;
            }

            if (msg.role === 'tool') {
                if (msg.isHtml && typeof rawContent === 'string' && rawContent.includes('<details')) {
                    fragment.appendChild(buildBubble(msg.role, rawContent, true, msg.time));
                } else {
                    var args = '{}';
                    if (Array.isArray(lastToolCalls)) {
                        var tc = lastToolCalls.find(function (t) {
                            return t.id === msg.tool_call_id ||
                                (t.function && t.function.name === msg.name);
                        });
                        if (tc && tc.function && tc.function.arguments) {
                            args = tc.function.arguments;
                        }
                    }

                    var escHtml = function (s) {
                        return String(s)
                            .replace(/&/g, "&" + "amp;")
                            .replace(/</g, "&" + "lt;")
                            .replace(/>/g, "&" + "gt;");
                    };

                    var htmlContent = [
                        '<details>',
                        '<summary>⚙️ 工具 [', escHtml(msg.name || '未知'), '] 执行完毕 ✅</summary>',
                        '<div class="tool-section-label">📥 输入参数</div>',
                        '<pre class="tool-output tool-input">', escHtml(args), '</pre>',
                        '<div class="tool-section-label">📤 输出结果</div>',
                        '<pre class="tool-output">', escHtml(rawContent), '</pre>',
                        '</details>'
                    ].join('');

                    fragment.appendChild(buildBubble(msg.role, htmlContent, true, msg.time));
                }
            } else if (msg.role === 'assistant') {
                if (!rawContent && msg.tool_calls && msg.tool_calls.length > 0) {
                    return;
                }
                fragment.appendChild(buildBubble(msg.role, rawContent, msg.isHtml, msg.time));
            } else {
                fragment.appendChild(buildBubble(msg.role, rawContent, msg.isHtml, msg.time));
            }
        } catch (err) {
            console.error("[前端防御] 渲染某条历史消息时出错，已自动跳过:", err, msg);
        }
    });

    // ★ 将哨兵元素移到 fragment 末尾（保持 DOM 节点引用不变，只是移动）
    if (scrollSentinel) {
        fragment.appendChild(scrollSentinel);
    }

    // ★ 一次性替换容器全部子节点
    //    先清空再 append Fragment 保证兼容性（replaceChildren 备选）
    while (messagesContainer.firstChild) {
        messagesContainer.removeChild(messagesContainer.firstChild);
    }
    messagesContainer.appendChild(fragment);

    // ★ 恢复滚动位置：用双 rAF 等待浏览器完成 reflow 后再设置 scrollTop
    requestAnimationFrame(function () {
        requestAnimationFrame(function () {
            if (wasAtBottom || !savedScrollHeight || savedScrollHeight <= savedClientHeight + 10) {
                // 之前在底部 或 旧容器为空/不可滚动 → 滚到底部
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
                isPinnedToBottom = true;
            } else {
                // 用户之前在某个可滚动位置 → 按比例恢复
                var ratio = savedScrollTop / savedScrollHeight;
                messagesContainer.scrollTop = Math.round(ratio * messagesContainer.scrollHeight);
                isPinnedToBottom = false;
            }
            // ★ 恢复哨兵观察
            if (sentinelObserver && scrollSentinel) {
                sentinelObserver.observe(scrollSentinel);
            }
        });
    });
}

// ---- 智能滚动 ----
function scrollToBottom() {
    // 仅当用户在底部（哨兵完全可见）时才跟随滚动
    if (isPinnedToBottom) {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
}

// ---- 会话列表渲染 ----
function renderChatList() {
    var mainSessions = [];
    var tempSessions = [];

    Object.keys(localSessionsData).forEach(function (id) {
        if (id.startsWith('compact_')) return;
        if (id.startsWith('main_') || id === 'main') {
            mainSessions.push(id);
        } else if (id.startsWith('temp-') || id.startsWith('temp_')) {
            tempSessions.push(id);
        }
    });

    var visibleTempIds = tempSessions.filter(function (id) {
        return !hiddenTempIds.has(id);
    });

    var sortByFirstTime = function (a, b) {
        var msgsA = localSessionsData[a] || [];
        var msgsB = localSessionsData[b] || [];
        var timeA = msgsA.length > 0 ? (msgsA[0].time || '') : '';
        var timeB = msgsB.length > 0 ? (msgsB[0].time || '') : '';
        return timeB.localeCompare(timeA);
    };
    mainSessions.sort(sortByFirstTime);
    visibleTempIds.sort(sortByFirstTime);

    var ordered = mainSessions.concat(visibleTempIds);
    var totalVisibleTemp = visibleTempIds.length;

    if (cleanTempBtn) {
        cleanTempBtn.disabled = totalVisibleTemp === 0;
    }

    // ★ DOM Diff：用 data-id 识别已存在的 <li>，避免全量销毁重建
    var existingItems = {};
    var currentLis = chatListUl.querySelectorAll('li.chat-item');
    currentLis.forEach(function (li) {
        var id = li.getAttribute('data-id');
        if (id) existingItems[id] = li;
    });

    var processedIds = new Set();

    ordered.forEach(function (id) {
        if (id.startsWith('compact_')) return;
        processedIds.add(id);

        var icon = '\uD83D\uDCAC';
        if (id.startsWith('main_') || id === 'main') icon = '\u2B50';
        else if (id.startsWith('temp-') || id.startsWith('temp_')) icon = '\uD83D\uDD50';

        var displayLabel = id;
        if (id.startsWith('temp-')) {
            displayLabel = id;
        } else if (id.includes('_')) {
            var parts = id.split('_');
            displayLabel = parts[0] + '-' + parts.slice(1).join('_').slice(-6);
        }

        var textContent = icon + ' ' + displayLabel;
        var li = existingItems[id];

        if (li) {
            // 已存在：仅更新文本与 active 状态（不重新创建，不重新绑定事件）
            if (li.textContent !== textContent) {
                li.textContent = textContent;
            }
            if (id === currentSessionId) {
                li.classList.add('active');
            } else {
                li.classList.remove('active');
            }
        } else {
            // 不存在：创建新 <li> 并追加
            li = document.createElement('li');
            li.classList.add('chat-item');
            li.setAttribute('data-id', id);
            li.textContent = textContent;
            if (id === currentSessionId) li.classList.add('active');
            li.addEventListener('click', function () { switchSession(id); });
            chatListUl.appendChild(li);
        }
    });

    // 移除不再出现在目标列表中的旧 <li>
    currentLis.forEach(function (li) {
        var id = li.getAttribute('data-id');
        if (id && !processedIds.has(id)) {
            li.remove();
        }
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

function updateSendBtnState() {
    const generating = !!isGenerating.get(currentSessionId);
    if (generating) {
        sendBtn.textContent = '\u23F9 \u7EC8\u6B62';
        sendBtn.classList.add('stop-btn');
        sendBtn.disabled = false;
        messageInput.disabled = false;
    } else {
        sendBtn.textContent = '\u53D1\u9001';
        sendBtn.classList.remove('stop-btn');
        sendBtn.disabled = false;
        messageInput.disabled = false;
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