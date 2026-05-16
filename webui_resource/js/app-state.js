// ============================================
// app-state.js — 全局配置 + 状态 + 工具函数
// 整合自：config.js + state.js + utils.js
// ============================================

// ---- 常量 ----
const BASE_URL = 'http://127.0.0.1:8001';

// ---- 全局状态 ----
let currentSessionId = null;
const eventSources = new Map();          // Map<sessionId, EventSource>
const connectionStatus = new Map();      // Map<sessionId, 'connected'|'disconnected'>
let activeAssistantMessageBubble = null;
let activeToolBubbles = {};
let userManuallyScrolledUp = false;

// 压缩状态
let isCompacting = false;
let compactEventSource = null;
let compactSessionId = null;

// 前端本地存储
let localSessionsData = JSON.parse(localStorage.getItem('chatSessions')) || {};
let hiddenTempIds = new Set(JSON.parse(localStorage.getItem('hiddenTempIds')) || []);

// ---- localStorage 持久化 ----
function saveLocalData() {
    localStorage.setItem('chatSessions', JSON.stringify(localSessionsData));
}

function saveHiddenTempIds() {
    localStorage.setItem('hiddenTempIds', JSON.stringify([...hiddenTempIds]));
}

// ---- 工具函数 ----
function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function generateSessionId(type) {
    if (type === 'temp') {
        const nextNum = (parseInt(localStorage.getItem('tempCounter')) || 0) + 1;
        localStorage.setItem('tempCounter', nextNum);
        return `temp-${nextNum}`;
    }
    if (type === 'compact') {
        const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
        let shortId = '';
        for (let i = 0; i < 6; i++) {
            shortId += chars[Math.floor(Math.random() * chars.length)];
        }
        return `compact_${shortId}`;
    }
    const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
    let shortId = '';
    for (let i = 0; i < 6; i++) {
        shortId += chars[Math.floor(Math.random() * chars.length)];
    }
    return `main_${shortId}`;
}

function getMainSessionId() {
    const mainKey = Object.keys(localSessionsData).find(k => k.startsWith('main_'));
    if (mainKey) return mainKey;
    const newMainId = generateSessionId('main');
    localSessionsData[newMainId] = [];
    saveLocalData();
    return newMainId;
}

function getSessionType(sessionId) {
    if (sessionId.startsWith('temp-')) return 'temp';
    if (sessionId.includes('_')) return sessionId.split('_')[0];
    return 'chat';
}

function sanitizeLocalStorage() {
    const validKeys = {};
    let maxTempNum = 0;
    Object.keys(localSessionsData).forEach(key => {
        if (key.startsWith('main_')) {
            if (!Object.keys(validKeys).some(k => k.startsWith('main_'))) {
                validKeys[key] = localSessionsData[key];
            }
        } else if (/^temp-\d+$/.test(key)) {
            const num = parseInt(key.replace('temp-', ''), 10);
            if (num > 0) {
                validKeys[key] = localSessionsData[key];
                if (num > maxTempNum) maxTempNum = num;
            }
        }
    });
    if (maxTempNum > 0) {
        localStorage.setItem('tempCounter', String(maxTempNum));
    } else {
        localStorage.removeItem('tempCounter');
    }
    localSessionsData = validKeys;
    saveLocalData();
    const validHiddenSet = new Set();
    hiddenTempIds.forEach(id => {
        if (/^temp-[1-9]\d*$/.test(id)) validHiddenSet.add(id);
    });
    hiddenTempIds = validHiddenSet;
    saveHiddenTempIds();
}