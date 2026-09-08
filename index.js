import { eventSource, event_types, isGenerating, stopGeneration } from '../../../../script.js';
import { promptManager } from '../../../openai.js';
import { getSortedEntries } from '../../../world-info.js';
import { KEY, mergeStates, resetToggles, clearItems, applyPromptCombination, normalizeState, itemKey, installPromptAdapter, applyWorldOverrides, catalogWorlds } from './core.mjs';
import { POSITION_KEY, readPosition, positionPixels, attachFloatingDrag } from './floating.mjs';

const context = () => SillyTavern.getContext();
const keyOf = item => itemKey(item.kind, item.source, item.id);
let panel, body, status, subtitle, launcher, dialog;
let editScope = 'chat';
let tab = 'prompt', editing = false, search = '', worldCatalog = [], worldChat = '', refreshToken = 0;
let wiredManager, restoreManager, adapterError = '', generation = null, saving = false;
let worldReadError = '', refreshTimer, worldRead = null;
const hasWorldHook = Boolean(event_types.WORLDINFO_ENTRIES_LOADED);
let active = false;
const subscriptions = [];
let savedPosition, previewPosition, detachDrag;
try { savedPosition = readPosition(globalThis.localStorage); } catch { savedPosition = null; }
function floatingViewport() {
    const v = globalThis.visualViewport;
    return { width: v?.width || globalThis.innerWidth || 390, height: v?.height || globalThis.innerHeight || 700, offsetLeft: v?.offsetLeft || 0, offsetTop: v?.offsetTop || 0 };
}
function resetFloatingPosition() {
    savedPosition = null; previewPosition = null;
    try { globalThis.localStorage?.removeItem(POSITION_KEY); } catch {}
    showFloatingIcon();
}
const activationLabels = { constant: '🔵 상시', normal: '🟢 키워드 트리거', vectorized: '🔗 벡터 검색' };
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
function sharedSettings() { return context().extensionSettings?.[KEY] || {}; }
function localState() { return normalizeState(context().chatMetadata?.[KEY]); }
function sharedState() { return normalizeState(sharedSettings().state); }
function readState() { return editScope === 'global' ? sharedState() : localState(); }
function effectiveState() { return mergeStates(sharedSettings().state, context().chatMetadata?.[KEY]); }
function scopeLabel() { return editScope === 'global' ? '모든 채팅' : '이 채팅'; }
function liveScope() { return { chat: chatKey(), preset: presetKey(), state: effectiveState() }; }
async function saveShared(update) {
    const c = context();
    if (!c.extensionSettings || typeof c.saveSettingsDebounced !== 'function') throw new Error('전체 설정 저장을 지원하지 않는 버전입니다.');
    const next = structuredClone(sharedSettings()); update(next);
    c.extensionSettings[KEY] = next;
    await c.saveSettingsDebounced();
}

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
    const source = presetKey();
    if (!source || !wiredManager) return [];
    const manager = wiredManager;
    const order = manager.getPromptOrderForCharacter(manager.activeCharacter);
    return order.flatMap(entry => {
        const p = manager.getPromptById(entry.identifier);
        // Match ST's own restrictions for structural markers.
        if (!p || (typeof manager.isPromptToggleAllowed === 'function' && !manager.isPromptToggleAllowed(p))) return [];
        return [{ kind: 'prompt', source, id: String(p.identifier), name: p.name || p.identifier,
            enabled: Boolean(entry.enabled), content: String(p.content || ''), strategy: '' }];
    });
}
const indexItems = items => new Map(items.map(item => [keyOf(item), item]));
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
    const targetScope = editScope;
    const next = readState();
    update(next);
    if (targetScope === 'chat') metadata[KEY] = normalizeState(next);
    saving = true;
    render();
    try {
        // Save immediately through ST, never debounce a closure into a different chat.
        if (targetScope === 'global') await saveShared(settings => { settings.state = normalizeState(next); });
        else await context().saveMetadata();
    } catch (error) { notify(`설정 저장에 실패했습니다: ${error.message}`, true); }
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
    d.append(button('원본 따름', async () => {
        if (scope !== chatKey()) return closeDialog();
        closeDialog();
        await changeState(s => { const found = s.items.find(x => keyOf(x) === key); if (found) { found.state = null; found.activation = null; } }, scope);
    }, 'csb-quiet', 'ON/OFF와 주입 방식 지정을 해제'));
}

async function openPicker() {
    if (!chatKey() || isGenerating() || saving) return;
    const scope = chatKey(), source = presetKey(), kind = tab, target = editScope;
    if (kind === 'world') await refreshWorlds();
    if (scope !== chatKey() || source !== presetKey() || kind !== tab || target !== editScope) return;
    const all = catalog();
    const existing = new Set(readState().items.map(keyOf));
    const choices = all.filter(item => !existing.has(keyOf(item)));
    const selected = new Set();
    const d = modal(kind === 'prompt' ? '프리셋 항목 추가' : '월드인포 항목 추가');
    d.append(el('p', 'csb-muted', '추가한 항목은 원본의 현재 ON/OFF 상태로 시작합니다.'));
    const filter = el('input', 'csb-search'); filter.type = 'search'; filter.placeholder = '제목 · 책 이름 · 내용 검색'; filter.setAttribute('aria-label', '추가할 항목 검색');
    const list = el('div', 'csb-picker-list');
    const footer = el('footer', 'csb-modal-footer');
    const add = button('0개 추가', async () => {
        if (scope !== chatKey() || source !== presetKey() || target !== editScope) return closeDialog();
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

function openBulk(action) {
    if (!chatKey() || isGenerating() || saving) return;
    const chat = chatKey(), kind = tab, target = editScope;
    const d = modal(action === 'clear' ? '선택 항목 비우기' : 'ON/OFF 초기화');
    d.append(el('p', 'csb-muted', `${scopeLabel()} · ${kind === 'prompt' ? '프리셋' : '월드인포'} 탭 전체 (검색으로 숨겨진 항목 포함)`));
    d.append(el('p', '', action === 'clear' ? '이 범위의 선택 목록과 상태 지정을 비웁니다. 원본 항목과 저장한 조합은 삭제하지 않습니다.' : '선택한 목록과 주입 방식은 유지합니다. ON/OFF는 모든 채팅 설정 또는 원본을 다시 따릅니다.'));
    d.append(button('취소', closeDialog, 'csb-quiet'), button('확인', async () => {
        if (chat !== chatKey() || kind !== tab || target !== editScope) return closeDialog();
        closeDialog();
        await changeState(s => (action === 'clear' ? clearItems : resetToggles)(s, kind), chat);
    }, 'csb-primary'));
}
function openCombinations() {
    if (!chatKey() || !presetKey() || isGenerating() || saving) return;
    const chat = chatKey(), source = presetKey(), target = editScope;
    const valid = () => chat === chatKey() && source === presetKey() && target === editScope && !isGenerating() && !saving;
    const d = modal('프롬프트 조합');
    d.append(el('p', 'csb-muted', `${presetName(source)} · 불러올 위치: ${scopeLabel()}`));
    const field = el('label', 'csb-field', '현재 선택 목록과 ON/OFF 저장');
    const name = el('input'); name.placeholder = '예: 일상 대화, 전투'; name.maxLength = 80; field.append(name); d.append(field);
    d.append(button('조합 저장', async () => {
        if (!valid()) return;
        const label = name.value.trim();
        if (!label) return notify('조합 이름을 입력해주세요.');
        const all = Array.isArray(sharedSettings().combinations) ? sharedSettings().combinations : [];
        if (all.some(x => x.source === source && x.name === label)) return notify('같은 이름이 있어요. 다른 이름으로 저장하거나 기존 조합을 삭제해주세요.');
        const effective = indexItems((editScope === 'global' ? sharedState() : effectiveState()).items);
        const originals = indexItems(promptCatalog());
        const items = readState().items.filter(x => x.kind === 'prompt' && x.source === source).map(x => ({ ...x,
            state: effective.get(keyOf(x))?.state ?? originals.get(keyOf(x))?.enabled ?? null }));
        if (!items.length) return notify('먼저 프롬프트 항목을 추가해주세요.');
        saving = true; closeDialog(); render();
        try { await saveShared(settings => { settings.combinations = [...all, { name: label, source, version: 1, items }]; }); notify('조합을 저장했어요.'); }
        catch (error) { notify(error.message, true); }
        finally { saving = false; render(); }
        if (chat === chatKey() && source === presetKey()) openCombinations();
    }, 'csb-primary'));
    const list = el('div', 'csb-picker-list');
    const combinations = (Array.isArray(sharedSettings().combinations) ? sharedSettings().combinations : []).filter(x => x.source === source);
    if (!combinations.length) list.append(el('p', 'csb-muted', '저장한 조합이 없습니다.'));
    for (const combination of combinations) {
        const row = el('div', 'csb-combination');
        row.append(el('strong', '', combination.name));
        row.append(button('불러오기', async () => {
            if (!valid()) return;
            closeDialog();
            await changeState(s => applyPromptCombination(s, combination, source), chat);
        }, 'csb-primary'));
        row.append(button('삭제', async () => {
            if (!valid()) return;
            saving = true; closeDialog(); render();
            try { await saveShared(settings => { settings.combinations = (settings.combinations || []).filter(x => x.source !== source || x.name !== combination.name); }); }
            catch (error) { notify(error.message, true); }
            finally { saving = false; render(); }
            if (chat === chatKey() && source === presetKey()) openCombinations();
        }, 'csb-quiet'));
        list.append(row);
    }
    d.append(list, el('p', 'csb-muted', '불러오면 선택한 범위에서 현재 프리셋의 목록과 ON/OFF가 교체됩니다. 조합은 다른 채팅에서도 사용할 수 있습니다.'));
}

function moveItem(state, key, direction) {
    const index = state.items.findIndex(item => keyOf(item) === key), item = state.items[index];
    if (!item) return;
    for (let next = index + direction; next >= 0 && next < state.items.length; next += direction) {
        const other = state.items[next];
        if (other.kind === item.kind && other.group === item.group) {
            [state.items[index], state.items[next]] = [other, item];
            break;
        }
    }
}

function render() {
    if (!panel) return;
    const previousScroll = body.scrollTop;
    const c = context(), hasChat = Boolean(chatKey()), busy = isGenerating() || saving;
    subtitle.textContent = hasChat ? editScope === 'global' ? '모든 채팅의 공통 설정' : `${c.name2 || '현재 채팅'} · 개별 설정 우선` : '먼저 채팅방을 열어주세요';
    panel.querySelectorAll('[data-scope]').forEach(b => { b.classList.toggle('is-active', b.dataset.scope === editScope); b.disabled = busy; b.setAttribute('aria-pressed', String(b.dataset.scope === editScope)); });
    const combos = panel.querySelector('[data-action="combos"]'); if (combos) { combos.hidden = tab !== 'prompt'; combos.disabled = !hasChat || busy || !presetKey(); }
    status.textContent = saving ? '설정 저장 중…' : isGenerating() ? '답변 생성 중 · 완료 후 변경할 수 있어요' : '변경한 상태는 다음 답변부터 적용됩니다';
    panel.querySelectorAll('[data-tab]').forEach(b => { b.classList.toggle('is-active', b.dataset.tab === tab); b.setAttribute('aria-selected', String(b.dataset.tab === tab)); });
    panel.querySelector('[data-action="edit"]').textContent = editing ? '정리 완료' : '정리';
    panel.querySelector('[data-action="add"]').disabled = !hasChat || busy || (tab === 'prompt' ? Boolean(adapterError) || !presetKey() : !hasWorldHook);
    const currentSource = panel.querySelector('.csb-source');
    currentSource.textContent = tab === 'prompt' ? presetName() || 'Chat Completion 프리셋을 선택해주세요' : '현재 연결된 월드인포';
    body.replaceChildren();
    if (!hasChat) { body.append(el('div', 'csb-empty', '채팅을 열면 원하는 항목을 골라 담을 수 있어요.')); return; }
    const error = tab === 'prompt' ? adapterError : !hasWorldHook ? '이 SillyTavern 버전은 월드인포 제어를 지원하지 않습니다.' : worldReadError;
    if (error) body.append(el('p', 'csb-error', error));
    const query = search.toLocaleLowerCase();
    const items = readState().items.filter(item => item.kind === tab && `${item.alias} ${item.name} ${item.group} ${item.source}`.toLocaleLowerCase().includes(query));
    const originals = indexItems(tab === 'prompt' ? promptCatalog() : worldChat === chatKey() ? worldCatalog : []);
    const effectiveItems = editing ? null : indexItems((editScope === 'global' ? sharedState() : effectiveState()).items);
    if (editing) {
        const actions = el('div', 'csb-bulk');
        for (const [label, action] of [['ON/OFF 초기화', 'reset'], ['선택 항목 비우기', 'clear']]) {
            const b = button(label, () => openBulk(action), 'csb-quiet'); b.disabled = busy; actions.append(b);
        }
        body.append(actions);
    }
    if (!items.length) {
        const empty = el('div', 'csb-empty');
        empty.append(el('strong', '', search ? '검색 결과가 없어요' : '자주 바꾸는 항목만 골라두세요'), el('p', '', search ? '다른 검색어를 입력해보세요.' : '위의 항목 추가 버튼에서 여러 개를 한 번에 선택할 수 있어요.'));
        body.append(empty);
    }
    const groups = new Map();
    for (const item of items) { if (!groups.has(item.group)) groups.set(item.group, []); groups.get(item.group).push(item); }
    for (const [group, members] of groups) {
        const section = el('section', 'csb-section');
        if (group) section.append(el('h4', '', group));
        for (const [index, item] of members.entries()) {
            const key = keyOf(item), native = originals.get(key);
            const row = el('div', `csb-row${native ? '' : ' is-missing'}${editing ? ' is-editing' : ''}`);
            const copy = button('', () => showDetails(item), 'csb-item-copy', `${item.alias || native?.name || item.name} · 내용 미리 보기`);
            copy.append(el('strong', '', item.alias || native?.name || item.name));
            const source = item.kind === 'prompt' ? presetName(item.source) : item.source;
            row.append(copy);
            if (!editing) {
                copy.append(el('small', 'csb-muted', native ? source : `${source} · ${unavailableReason(item)}`));
                const effective = effectiveItems.get(key);
                const on = effective?.state ?? native?.enabled ?? false;
                const toggle = button(on ? 'ON' : 'OFF', () => changeState(s => { const found = s.items.find(x => keyOf(x) === key); if (found) found.state = !on; }), `csb-switch${on ? ' is-on' : ''}`);
                toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(on)); toggle.setAttribute('aria-label', `${item.alias || item.name} 켜기/끄기`);
                toggle.disabled = busy || !native || Boolean(error);
                if (item.kind === 'world') {
                    const select = el('select', 'csb-mode');
                    select.setAttribute('aria-label', `${item.alias || item.name} 주입 방식`);
                    const icons = { constant: '🔵', normal: '🟢', vectorized: '🔗' };
                    for (const [value, label] of Object.entries(icons)) {
                        const option = el('option', '', label); option.value = value; select.append(option);
                    }
                    select.value = effective?.activation || native?.activation || 'normal';
                    select.title = `${activationLabels[effective?.activation || native?.activation] || ''}${item.activation ? '' : ' · 기본값 따름'}`;
                    select.disabled = busy || !native || Boolean(error);
                    select.addEventListener('change', () => {
                        const mode = select.value || null;
                        changeState(s => { const found = s.items.find(x => keyOf(x) === key); if (found) found.activation = mode; });
                    });
                    row.append(select);
                }
                row.append(toggle);
            } else {
                const actions = el('div', 'csb-row-actions');
                const actionsList = [
                    ['edit', '이름·구획 변경', 'fa-feather', () => editItem(item)],
                    ['up', '위로 이동', 'fa-arrow-up', () => changeState(s => moveItem(s, key, -1))],
                    ['down', '아래로 이동', 'fa-arrow-down', () => changeState(s => moveItem(s, key, 1))],
                    ['remove', '제거', 'fa-trash-can', () => changeState(s => { s.items = s.items.filter(x => keyOf(x) !== key); })],
                ];
                for (const [id, label, icon, action] of actionsList) {
                    const b = button('', action, 'csb-action-icon', label);
                    const glyph = el('i', `fa-solid ${icon}`); glyph.setAttribute('aria-hidden', 'true'); b.append(glyph);
                    b.dataset.rowAction = id; b.setAttribute('aria-label', `${item.alias || item.name} · ${label}`);
                    b.disabled = busy || (id === 'up' && index === 0 && !search) || (id === 'down' && index === members.length - 1 && !search);
                    actions.append(b);
                }
                row.append(actions);
            }
            section.append(row);
        }
        body.append(section);
    }
    body.scrollTop = previousScroll;
}

async function refreshWorlds() {
    if (!active || !hasWorldHook || !chatKey()) { worldCatalog = []; return; }
    let request = worldRead;
    if (!request) {
        request = { token: ++refreshToken, chat: chatKey(), promise: null };
        worldRead = request;
        // Every caller awaits the handled task, never the raw rejecting read.
        request.promise = (async () => {
            const isCurrent = () => active && request.token === refreshToken && request.chat === chatKey();
            try {
                await getSortedEntries();
                if (isCurrent()) worldReadError = '';
            } catch (error) {
                if (isCurrent()) {
                    worldCatalog = [];
                    worldReadError = `월드인포를 읽지 못했습니다: ${error.message}`;
                }
            } finally {
                if (worldRead === request) worldRead = null;
            }
            if (isCurrent()) render();
        })();
    }
    await request.promise;
    // A switched chat needs a fresh read, including when the old read failed.
    if (active && (request.chat !== chatKey() || request.token !== refreshToken)) return refreshWorlds();
}
function scheduleRefresh() {
    if (!active) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (!active) return; ensureAdapter(); render(); if (panel && !panel.hidden) refreshWorlds(); }, 100);
}
function setPanelOpen(open) {
    if (!panel) return;
    if (open) {
        panel.hidden = false;
        // Escape theme stacking contexts and extension drawers on mobile.
        if (typeof panel.showPopover === 'function') {
            panel.setAttribute('popover', 'manual');
            if (!panel.matches(':popover-open')) panel.showPopover();
        }
        launcher.setAttribute('aria-expanded', 'true');
        ensureAdapter(); render(); refreshWorlds();
    } else {
        if (typeof panel.hidePopover === 'function' && panel.matches(':popover-open')) panel.hidePopover();
        panel.hidden = true;
        launcher.setAttribute('aria-expanded', 'false');
    }
}
function showFloatingIcon() {
    if (!active || !launcher) return;
    const { x, y } = positionPixels(previewPosition || savedPosition, floatingViewport());
    launcher.style.setProperty('left', `${x}px`, 'important');
    launcher.style.setProperty('top', `${y}px`, 'important');
    // The icon itself (not only the panel) must escape clipping/stacking contexts.
    if (typeof launcher.showPopover === 'function') {
        launcher.setAttribute('popover', 'manual');
        try { if (!launcher.matches(':popover-open')) launcher.showPopover(); } catch (error) { console.warn('[Switchboard] Floating icon fallback', error); }
    }
}
function buildUI() {
    if (panel) return;
    launcher = button('', () => setPanelOpen(panel.hidden), 'csb-launcher', '눌러서 열기 · 끌어서 이동');
    // Inline priorities protect the actual control from mobile theme rules.
    for (const [name, value] of Object.entries({ display:'block', position:'fixed', right:'auto', bottom:'auto', width:'48px', height:'48px', 'min-width':'48px', 'max-width':'48px', 'min-height':'48px', 'max-height':'48px', margin:'0', padding:'0', transform:'none', opacity:'1', visibility:'visible', 'pointer-events':'auto', 'z-index':'2147483646', 'border-radius':'0', background:'transparent', color:'#37433b', border:'0', 'font-size':'27px', 'line-height':'44px', 'text-align':'center', 'writing-mode':'horizontal-tb', 'box-shadow':'none', 'touch-action':'none', 'user-select':'none', cursor:'grab' })) {
        launcher.style.setProperty(name, value, 'important');
    }
    const art = el('img', 'csb-launcher-art');
    art.src = new URL('./assets/strawberry-cake.png', import.meta.url).href;
    art.alt = ''; art.draggable = false; art.setAttribute('aria-hidden', 'true');
    // 48px touch target; transparent margins leave a roughly 36px visible cake.
    for (const [name, value] of Object.entries({ display:'block', width:'48px', height:'48px', 'max-width':'none', margin:'0', padding:'0', border:'0', background:'transparent', 'object-fit':'contain', 'image-rendering':'pixelated', 'pointer-events':'none', 'user-select':'none' })) art.style.setProperty(name, value, 'important');
    const control = launcher;
    art.addEventListener('error', () => { art.remove(); control.textContent = '🍰'; });
    launcher.append(art);
    detachDrag = attachFloatingDrag(launcher, {
        getPosition: () => savedPosition, getViewport: floatingViewport,
        preview: p => { previewPosition = p; showFloatingIcon(); },
        commit: p => { savedPosition = p; previewPosition = null; try { globalThis.localStorage?.setItem(POSITION_KEY, JSON.stringify(p)); } catch {} showFloatingIcon(); },
        restore: () => { previewPosition = null; showFloatingIcon(); },
    });
    launcher.id = 'csb-floating-launcher';
    launcher.setAttribute('aria-label', '채팅 스위치보드 열기'); launcher.setAttribute('aria-expanded', 'false');
    panel = el('aside', 'csb-panel'); panel.hidden = true; panel.setAttribute('aria-label', '채팅 스위치보드');
    const header = el('header', 'csb-header'), titles = el('div');
    titles.append(el('h2', '', '채팅 스위치'));
    subtitle = el('p', 'csb-muted'); titles.append(subtitle);
    header.append(titles, button('×', () => { setPanelOpen(false); launcher.focus(); }, 'csb-close', '패널 닫기'));
    const scopes = el('div', 'csb-scopes');
    for (const [value, label] of [['chat', '이 채팅'], ['global', '모든 채팅']]) {
        const b = button(label, () => { if (isGenerating() || saving) return; closeDialog(); editScope = value; render(); });
        b.dataset.scope = value; scopes.append(b);
    }
    const tabs = el('div', 'csb-tabs'); tabs.setAttribute('role', 'tablist');
    for (const [kind, label] of [['prompt', '프리셋'], ['world', '월드인포']]) {
        const b = button(label, () => { tab = kind; search = ''; input.value = ''; render(); if (kind === 'world') refreshWorlds(); });
        b.dataset.tab = kind; b.setAttribute('role', 'tab'); tabs.append(b);
    }
    const toolbar = el('div', 'csb-toolbar');
    const add = button('＋ 항목 추가', openPicker, 'csb-primary'); add.dataset.action = 'add';
    const edit = button('정리', () => { editing = !editing; render(); }, 'csb-quiet'); edit.dataset.action = 'edit';
    const combinations = button('조합', openCombinations, 'csb-quiet', '프롬프트 ON/OFF 조합'); combinations.dataset.action = 'combos';
    toolbar.append(add, combinations, button('↻', () => { ensureAdapter(); render(); refreshWorlds(); }, 'csb-quiet', '목록 새로고침'), edit);
    const source = el('p', 'csb-source csb-muted');
    const input = el('input', 'csb-search'); input.type = 'search'; input.placeholder = '내 버튼 검색'; input.setAttribute('aria-label', '내 버튼 검색');
    input.addEventListener('input', () => { search = input.value; render(); });
    body = el('div', 'csb-body'); status = el('footer', 'csb-status'); status.setAttribute('role', 'status');
    panel.append(header, scopes, tabs, toolbar, source, input, body, status);
    document.body.append(launcher, panel);
    showFloatingIcon();
    render();
}

function init() {
    if (!active) return;
    ensureAdapter(); buildUI();
    showFloatingIcon();
    if (chatKey()) refreshWorlds();
    const settings = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (settings && !document.getElementById('csb-settings')) {
        const wrap = el('div'); wrap.id = 'csb-settings';
        // Use SillyTavern's native drawer and delegated toggle handler so themes match.
        const drawer = el('div', 'inline-drawer');
        const header = el('div', 'inline-drawer-toggle inline-drawer-header');
        header.setAttribute('role', 'button'); header.tabIndex = 0;
        header.setAttribute('aria-label', '채팅 스위치보드 설정 펼치기/접기');
        header.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); header.click(); }
        });
        const chevron = el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down');
        chevron.setAttribute('aria-hidden', 'true');
        header.append(el('b', '', '채팅 스위치보드'), chevron);
        const content = el('div', 'inline-drawer-content');
        const actions = el('div', 'flex-container csb-settings-actions');
        actions.append(button('패널 열기', () => setPanelOpen(true), 'menu_button csb-settings-open'));
        actions.append(button('아이콘 위치 초기화', resetFloatingPosition, 'menu_button csb-settings-reset'));
        content.append(actions);
        drawer.append(header, content); wrap.append(drawer); settings.append(wrap);
    }
}

export function onEnable() {
    if (active) return;
    active = true;
    globalThis.addEventListener?.('resize', showFloatingIcon);
    globalThis.visualViewport?.addEventListener('resize', showFloatingIcon);
    globalThis.visualViewport?.addEventListener('scroll', showFloatingIcon);
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
    detachDrag?.(); detachDrag = null; previewPosition = null;
    globalThis.removeEventListener?.('resize', showFloatingIcon);
    globalThis.visualViewport?.removeEventListener('resize', showFloatingIcon);
    globalThis.visualViewport?.removeEventListener('scroll', showFloatingIcon);
    for (const [name, handler] of subscriptions.splice(0)) eventSource.removeListener(name, handler);
    document.removeEventListener('DOMContentLoaded', init);
    clearTimeout(refreshTimer); refreshToken++;
    restoreManager?.(); restoreManager = null; wiredManager = undefined;
    generation = null; closeDialog();
    panel?.remove(); launcher?.remove(); document.getElementById('csb-settings')?.remove();
    panel = null; launcher = null; worldCatalog = []; worldChat = '';
}
onEnable();
