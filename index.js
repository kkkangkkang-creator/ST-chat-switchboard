import { eventSource, event_types, isGenerating, stopGeneration } from '../../../../script.js';
import { promptManager } from '../../../openai.js';
import { getSortedEntries } from '../../../world-info.js';
import { KEY, normalizeState, itemKey, installPromptAdapter, applyWorldOverrides, catalogWorlds } from './core.mjs';

const context = () => SillyTavern.getContext();
const keyOf = item => itemKey(item.kind, item.source, item.id);
let panel, body, status, subtitle, launcher, dialog;
let tab = 'prompt', editing = false, search = '', worldCatalog = [], worldChat = '', refreshToken = 0;
let wiredManager, restoreManager, adapterError = '', generation = null, saving = false;
let worldReadError = '', refreshTimer, worldRead = null;
const hasWorldHook = Boolean(event_types.WORLDINFO_ENTRIES_LOADED);
let active = false;
const subscriptions = [];
function listen(name, handler) { eventSource.on(name, handler); subscriptions.push([name, handler]); }

function chatKey() {
    const c = context();
    const id = c.getCurrentChatId?.();
    if (id === undefined || id === null || id === '') return '';
    const owner = c.groupId != null ? ['group', c.groupId] : ['character', c.characters?.[c.characterId]?.avatar ?? c.characterId];
    return JSON.stringify([...owner, id]);
}
function presetKey() {
    const c = context();
    if (c.mainApi !== 'openai') return '';
    const name = c.getPresetManager?.()?.getSelectedPresetName?.();
    return name ? JSON.stringify(['openai', name]) : '';
}
function presetName(source = presetKey()) {
    try { return JSON.parse(source)[1] || ''; } catch { return ''; }
}
function readState() { return normalizeState(context().chatMetadata?.[KEY]); }
function liveScope() { return { chat: chatKey(), preset: presetKey(), state: readState() }; }
function getScope() {
    if (generation) {
        if (generation.chat !== chatKey() || generation.preset !== presetKey()) {
            throw new Error('채팅 또는 프리셋이 변경되어 스위치보드의 생성 적용을 중단했습니다.');
        }
        return generation;
    }
    return liveScope();
}
function notify(message, error = false) {
    globalThis.toastr?.[error ? 'error' : 'info']?.(message, '채팅 스위치보드');
}
function ensureAdapter() {
    if (promptManager === wiredManager) return;
    restoreManager?.();
    wiredManager = null;
    try {
        if (!promptManager) throw new Error('프리셋 관리자를 기다리는 중입니다.');
        restoreManager = installPromptAdapter(promptManager, getScope);
        wiredManager = promptManager;
        adapterError = '';
    } catch (error) { adapterError = error.message; }
}
function promptCatalog() {
    if (!presetKey() || !wiredManager) return [];
    const manager = wiredManager;
    const order = manager.getPromptOrderForCharacter(manager.activeCharacter);
    return order.flatMap(entry => {
        const p = manager.getPromptById(entry.identifier);
        // Match ST's own restrictions for structural markers.
        if (!p || (typeof manager.isPromptToggleAllowed === 'function' && !manager.isPromptToggleAllowed(p))) return [];
        return [{ kind: 'prompt', source: presetKey(), id: String(p.identifier), name: p.name || p.identifier,
            enabled: Boolean(entry.enabled), content: String(p.content || ''), strategy: '' }];
    });
}
function catalog() { return tab === 'prompt' ? promptCatalog() : worldCatalog; }
function lookup(item) {
    const list = item.kind === 'prompt' ? promptCatalog() : worldChat === chatKey() ? worldCatalog : [];
    return list.find(x => keyOf(x) === keyOf(item));
}
function unavailableReason(item) {
    if (item.kind === 'prompt' && item.source !== presetKey()) return '다른 프리셋 · 적용 안 됨';
    if (item.kind === 'world' && worldReadError) return '월드인포 읽기 실패';
    return item.kind === 'prompt' ? '항목을 찾을 수 없음' : '현재 연결되지 않았거나 삭제됨';
}
async function changeState(update, expectedChat = chatKey()) {
    if (!expectedChat || expectedChat !== chatKey()) return;
    if (isGenerating()) { notify('답변 생성이 끝난 뒤 변경해주세요.'); return; }
    if (saving) return;
    generation = null;
    const metadata = context().chatMetadata;
    if (!metadata) return;
    const next = readState();
    update(next);
    metadata[KEY] = normalizeState(next);
    saving = true;
    render();
    try {
        // Save immediately through ST, never debounce a closure into a different chat.
        await context().saveMetadata();
    } catch (error) { notify(`채팅 설정 저장에 실패했습니다: ${error.message}`, true); }
    finally { saving = false; render(); }
}

function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
}
function button(text, fn, cls = '', title = '') {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', fn);
    if (title) b.title = title;
    return b;
}
function closeDialog() {
    const closing = dialog;
    dialog = null;
    if (closing) { closing.close(); closing.remove(); }
}
function modal(title) {
    closeDialog();
    const d = el('dialog', 'csb-dialog');
    const head = el('header', 'csb-modal-head');
    head.append(el('h3', '', title), button('닫기', closeDialog, 'csb-quiet'));
    d.append(head);
    document.body.append(d);
    dialog = d;
    d.addEventListener('close', () => { if (dialog === d) dialog = null; d.remove(); });
    d.showModal();
    return d;
}
function showDetails(item) {
    const native = lookup(item);
    const d = modal(item.alias || native?.name || item.name);
    d.append(el('p', 'csb-muted', `${item.kind === 'prompt' ? presetName(item.source) : item.source} · ${native?.name || item.name}`));
    d.append(el('pre', 'csb-preview', native?.content || '미리 볼 내용이 없습니다.'));
}
function editItem(item) {
    const scope = chatKey(), key = keyOf(item);
    const d = modal('버튼 정리');
    const name = el('input'), group = el('input');
    name.value = item.alias; name.placeholder = item.name; name.maxLength = 120;
    group.value = item.group; group.placeholder = '예: 문체, 시점 (비워도 됩니다)'; group.maxLength = 60;
    const l1 = el('label', 'csb-field', '패널 표시 이름'); l1.append(name);
    const l2 = el('label', 'csb-field', '구획'); l2.append(group);
    d.append(l1, l2, button('저장', async () => {
        if (scope !== chatKey()) return closeDialog();
        const alias = name.value.trim(), section = group.value.trim();
        closeDialog();
        await changeState(s => { const found = s.items.find(x => keyOf(x) === key); if (found) Object.assign(found, { alias, group: section }); }, scope);
    }, 'csb-primary'));
}

async function openPicker() {
    if (!chatKey() || isGenerating() || saving) return;
    const scope = chatKey(), source = presetKey(), kind = tab;
    if (kind === 'world') await refreshWorlds();
    if (scope !== chatKey() || source !== presetKey() || kind !== tab) return;
    const all = catalog();
    const existing = new Set(readState().items.map(keyOf));
    const choices = all.filter(item => !existing.has(keyOf(item)));
    const selected = new Set();
    const d = modal(kind === 'prompt' ? '프리셋 항목 추가' : '월드인포 항목 추가');
    d.append(el('p', 'csb-muted', '추가한 항목은 현재 상태로 시작합니다. 이 채팅방에서만 제어됩니다.'));
    const filter = el('input', 'csb-search'); filter.type = 'search'; filter.placeholder = '제목 · 책 이름 · 내용 검색'; filter.setAttribute('aria-label', '추가할 항목 검색');
    const list = el('div', 'csb-picker-list');
    const footer = el('footer', 'csb-modal-footer');
    const add = button('0개 추가', async () => {
        if (scope !== chatKey() || source !== presetKey()) return closeDialog();
        const picked = choices.filter(x => selected.has(keyOf(x)));
        closeDialog();
        await changeState(s => {
            const keys = new Set(s.items.map(keyOf));
            for (const item of picked) if (!keys.has(keyOf(item))) {
                s.items.push({ kind: item.kind, source: item.source, id: item.id, name: item.name, alias: '', group: '', state: item.enabled });
            }
        }, scope);
    }, 'csb-primary');
    add.disabled = true;
    function draw() {
        list.replaceChildren();
        const q = filter.value.trim().toLocaleLowerCase();
        const visible = choices.filter(x => `${x.name} ${x.source} ${x.content}`.toLocaleLowerCase().includes(q));
        if (!visible.length) list.append(el('p', 'csb-empty', choices.length ? '검색 결과가 없습니다.' : '추가할 항목이 없습니다. 연결 상태를 확인해주세요.'));
        const groups = Map.groupBy ? Map.groupBy(visible, x => x.source) : visible.reduce((m, x) => { if (!m.has(x.source)) m.set(x.source, []); m.get(x.source).push(x); return m; }, new Map());
        for (const [book, rows] of groups) {
            const section = el('details', 'csb-book'); section.open = Boolean(q) || kind === 'prompt';
            section.append(el('summary', '', `${kind === 'prompt' ? presetName(book) : book} · ${rows.length}`));
            for (const item of rows) {
                const row = el('label', 'csb-choice');
                const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(keyOf(item));
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) selected.add(keyOf(item)); else selected.delete(keyOf(item));
                    add.textContent = `${selected.size}개 추가`; add.disabled = !selected.size;
                });
                const copy = el('span', 'csb-copy');
                copy.append(el('strong', '', item.name), el('small', 'csb-muted', `${item.enabled ? 'ON' : 'OFF'}${item.strategy ? ` · ${item.strategy}` : ''}`));
                row.title = item.content.slice(0, 500); row.append(checkbox, copy); section.append(row);
            }
            list.append(section);
        }
    }
    filter.addEventListener('input', draw);
    footer.append(button('검색 결과 모두 선택', () => {
        const q = filter.value.trim().toLocaleLowerCase();
        choices.filter(x => `${x.name} ${x.source} ${x.content}`.toLocaleLowerCase().includes(q)).forEach(x => selected.add(keyOf(x)));
        add.textContent = `${selected.size}개 추가`; add.disabled = !selected.size; draw();
    }, 'csb-quiet'), add);
    d.append(filter, list, footer); draw(); filter.focus();
}

function render() {
    if (!panel) return;
    const previousScroll = body.scrollTop;
    const c = context(), hasChat = Boolean(chatKey()), busy = isGenerating() || saving;
    subtitle.textContent = hasChat ? `${c.name2 || '현재 채팅'} · 이 채팅방에만 적용` : '먼저 채팅방을 열어주세요';
    status.textContent = saving ? '채팅 설정 저장 중…' : isGenerating() ? '답변 생성 중 · 완료 후 변경할 수 있어요' : '변경한 상태는 다음 답변부터 적용됩니다';
    panel.querySelectorAll('[data-tab]').forEach(b => { b.classList.toggle('is-active', b.dataset.tab === tab); b.setAttribute('aria-selected', String(b.dataset.tab === tab)); });
    panel.querySelector('[data-action="edit"]').textContent = editing ? '정리 완료' : '정리';
    panel.querySelector('[data-action="add"]').disabled = !hasChat || busy || (tab === 'prompt' ? Boolean(adapterError) || !presetKey() : !hasWorldHook);
    const currentSource = panel.querySelector('.csb-source');
    currentSource.textContent = tab === 'prompt' ? presetName() || 'Chat Completion 프리셋을 선택해주세요' : '현재 연결된 월드인포 · ON이어도 원래 발동 조건을 따릅니다';
    body.replaceChildren();
    if (!hasChat) { body.append(el('div', 'csb-empty', '채팅을 열면 원하는 항목을 골라 담을 수 있어요.')); return; }
    const error = tab === 'prompt' ? adapterError : !hasWorldHook ? '이 SillyTavern 버전은 월드인포 제어를 지원하지 않습니다.' : worldReadError;
    if (error) body.append(el('p', 'csb-error', error));
    const items = readState().items.filter(item => item.kind === tab && `${item.alias} ${item.name} ${item.group} ${item.source}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    if (!items.length) {
        const empty = el('div', 'csb-empty');
        empty.append(el('span', 'csb-empty-icon', '＋'), el('strong', '', search ? '검색 결과가 없어요' : '자주 바꾸는 항목만 골라두세요'), el('p', '', search ? '다른 검색어를 입력해보세요.' : '위의 항목 추가 버튼에서 여러 개를 한 번에 선택할 수 있어요.'));
        body.append(empty);
    }
    const groups = new Map();
    for (const item of items) { if (!groups.has(item.group)) groups.set(item.group, []); groups.get(item.group).push(item); }
    for (const [group, members] of groups) {
        const section = el('section', 'csb-section');
        if (group) section.append(el('h4', '', group));
        for (const item of members) {
            const native = lookup(item), key = keyOf(item);
            const row = el('div', `csb-row${native ? '' : ' is-missing'}`);
            const copy = button('', () => showDetails(item), 'csb-item-copy', '내용 미리 보기');
            copy.append(el('strong', '', item.alias || native?.name || item.name));
            const source = item.kind === 'prompt' ? presetName(item.source) : item.source;
            copy.append(el('small', 'csb-muted', native ? `${source} · ${item.state === null ? '원본 따름' : '채팅 설정'}` : unavailableReason(item)));
            const on = item.state ?? native?.enabled ?? false;
            const toggle = button(on ? 'ON' : 'OFF', () => changeState(s => { const found = s.items.find(x => keyOf(x) === key); if (found) found.state = !on; }), `csb-switch${on ? ' is-on' : ''}`);
            toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(on)); toggle.setAttribute('aria-label', `${item.alias || item.name} 켜기/끄기`);
            toggle.disabled = busy || !native || Boolean(error);
            row.append(copy, toggle);
            if (editing) {
                const actions = el('div', 'csb-row-actions');
                const actionsList = [
                    ['이름·구획', () => editItem(item)],
                    ['↑', () => changeState(s => { const index = s.items.findIndex(x => keyOf(x) === key); for (let j = index - 1; j >= 0; j--) if (s.items[j].kind === item.kind && s.items[j].group === item.group) { [s.items[index], s.items[j]] = [s.items[j], s.items[index]]; break; } })],
                    ['↓', () => changeState(s => { const index = s.items.findIndex(x => keyOf(x) === key); for (let j = index + 1; j < s.items.length; j++) if (s.items[j].kind === item.kind && s.items[j].group === item.group) { [s.items[index], s.items[j]] = [s.items[j], s.items[index]]; break; } })],
                    ['원본 따름', () => changeState(s => { const found = s.items.find(x => keyOf(x) === key); if (found) found.state = null; })],
                    ['제거', () => changeState(s => { s.items = s.items.filter(x => keyOf(x) !== key); })],
                ];
                for (const [label, action] of actionsList) { const b = button(label, action, 'csb-quiet'); b.disabled = busy; actions.append(b); }
                row.append(actions);
            }
            section.append(row);
        }
        body.append(section);
    }
    body.scrollTop = previousScroll;
}

async function refreshWorlds() {
    if (worldRead) { await worldRead.promise; if (worldChat !== chatKey()) return refreshWorlds(); return; }
    const token = ++refreshToken, key = chatKey();
    if (!hasWorldHook || !key) { worldCatalog = []; return; }
    const request = { token, chat: key, promise: null };
    worldRead = request;
    try {
        request.promise = getSortedEntries();
        await request.promise;
        if (token !== refreshToken || key !== chatKey()) return;
        worldReadError = '';
    } catch (error) {
        if (token !== refreshToken || key !== chatKey()) return;
        worldCatalog = []; worldReadError = `월드인포를 읽지 못했습니다: ${error.message}`;
    } finally { if (worldRead === request) worldRead = null; }
    render();
}
function scheduleRefresh() {
    if (!active) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (!active) return; ensureAdapter(); render(); if (panel && !panel.hidden) refreshWorlds(); }, 100);
}
function buildUI() {
    if (panel) return;
    launcher = button('◉', () => { panel.hidden = !panel.hidden; launcher.setAttribute('aria-expanded', String(!panel.hidden)); if (!panel.hidden) { ensureAdapter(); render(); refreshWorlds(); } }, 'csb-launcher', '채팅 스위치보드');
    launcher.setAttribute('aria-label', '채팅 스위치보드 열기'); launcher.setAttribute('aria-expanded', 'false');
    panel = el('aside', 'csb-panel'); panel.hidden = true; panel.setAttribute('aria-label', '채팅 스위치보드');
    const header = el('header', 'csb-header'), titles = el('div');
    titles.append(el('span', 'csb-eyebrow', 'CHAT SWITCHBOARD'), el('h2', '', '채팅 스위치보드'));
    subtitle = el('p', 'csb-muted'); titles.append(subtitle);
    header.append(titles, button('×', () => { panel.hidden = true; launcher.setAttribute('aria-expanded', 'false'); launcher.focus(); }, 'csb-close', '패널 닫기'));
    const tabs = el('div', 'csb-tabs'); tabs.setAttribute('role', 'tablist');
    for (const [kind, label] of [['prompt', '프리셋'], ['world', '월드인포']]) {
        const b = button(label, () => { tab = kind; search = ''; input.value = ''; render(); if (kind === 'world') refreshWorlds(); });
        b.dataset.tab = kind; b.setAttribute('role', 'tab'); tabs.append(b);
    }
    const toolbar = el('div', 'csb-toolbar');
    const add = button('＋ 항목 추가', openPicker, 'csb-primary'); add.dataset.action = 'add';
    const edit = button('정리', () => { editing = !editing; render(); }, 'csb-quiet'); edit.dataset.action = 'edit';
    toolbar.append(add, button('↻', () => { ensureAdapter(); render(); refreshWorlds(); }, 'csb-quiet', '목록 새로고침'), edit);
    const source = el('p', 'csb-source csb-muted');
    const input = el('input', 'csb-search'); input.type = 'search'; input.placeholder = '내 버튼 검색'; input.setAttribute('aria-label', '내 버튼 검색');
    input.addEventListener('input', () => { search = input.value; render(); });
    body = el('div', 'csb-body'); status = el('footer', 'csb-status'); status.setAttribute('role', 'status');
    panel.append(header, tabs, toolbar, source, input, body, status);
    document.body.append(launcher, panel);
    render();
}

function init() {
    if (!active) return;
    ensureAdapter(); buildUI();
    const settings = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (settings && !document.getElementById('csb-settings')) {
        const wrap = el('div'); wrap.id = 'csb-settings';
        wrap.append(button('◉ 채팅 스위치보드 열기', () => { panel.hidden = false; launcher.setAttribute('aria-expanded', 'true'); render(); refreshWorlds(); }, 'menu_button'));
        settings.append(wrap);
    }
}

export function onEnable() {
if (active) return;
active = true;
if (hasWorldHook) listen(event_types.WORLDINFO_ENTRIES_LOADED, payload => {
    if (!worldRead || (worldRead.chat === chatKey() && worldRead.token === refreshToken)) {
        worldCatalog = catalogWorlds(payload); worldChat = chatKey();
    }
    const scope = getScope();
    if (scope.chat) applyWorldOverrides(payload, scope.state);
});
listen(event_types.GENERATION_AFTER_COMMANDS, (_type, _options, dryRun) => {
    ensureAdapter();
    if (!dryRun) { generation = structuredClone(liveScope()); setTimeout(render, 0); }
});
for (const name of ['GENERATION_ENDED', 'GENERATION_STOPPED']) if (event_types[name]) listen(event_types[name], () => {
    generation = null; scheduleRefresh();
});
for (const name of ['CHAT_CHANGED', 'OAI_PRESET_CHANGED_AFTER']) if (event_types[name]) listen(event_types[name], () => {
    if (generation && (generation.chat !== chatKey() || generation.preset !== presetKey())) {
        if (isGenerating()) { stopGeneration(); notify('채팅 또는 프리셋이 바뀌어 진행 중인 생성을 중단했습니다.'); }
        generation = null;
    }
    closeDialog(); worldCatalog = []; worldChat = ''; refreshToken++; search = '';
    if (panel) panel.querySelector('.csb-search').value = '';
    scheduleRefresh();
});
for (const name of ['WORLDINFO_SETTINGS_UPDATED', 'WORLDINFO_UPDATED', 'CHARACTER_EDITED', 'CHATCOMPLETION_SOURCE_CHANGED']) {
    if (event_types[name]) listen(event_types[name], scheduleRefresh);
}
listen(event_types.APP_READY, init);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
}
export function onDisable() {
    // Do not change prompt behavior partway through an in-flight generation.
    if (generation && isGenerating()) stopGeneration();
    active = false;
    for (const [name, handler] of subscriptions.splice(0)) eventSource.removeListener(name, handler);
    document.removeEventListener('DOMContentLoaded', init);
    clearTimeout(refreshTimer); refreshToken++;
    restoreManager?.(); restoreManager = null; wiredManager = undefined;
    generation = null; closeDialog();
    panel?.remove(); launcher?.remove(); document.getElementById('csb-settings')?.remove();
    panel = null; launcher = null; worldCatalog = []; worldChat = '';
}
onEnable();
