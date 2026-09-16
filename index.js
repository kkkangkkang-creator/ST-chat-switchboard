import { eventSource, event_types, isGenerating, stopGeneration } from '../../../../script.js';
import { promptManager } from '../../../openai.js';
import { getSortedEntries } from '../../../world-info.js';
import { KEY, catalogPrompts, resetToggles, clearItems, applyPromptCombination, itemKey, installPromptAdapter, applyWorldOverrides, catalogWorlds } from './core.mjs';
import { POSITION_KEY, readPosition, positionPixels, attachFloatingDrag } from './floating.mjs';

import { SCOPED_KEY, migrateScopes, readScopedState, writeScopedState } from './scopes.mjs';
import { createActivationTracker } from './activation.mjs';

const activation = createActivationTracker();
let worldView = 'manage', badge, showSearch = false;
const context = () => SillyTavern.getContext();
const keyOf = item => itemKey(item.kind, item.source, item.id);
let panel, body, status, subtitle, launcher, dialog;
let tab = 'prompt', editing = false, search = '', worldCatalog = [], worldChat = '', refreshToken = 0;
let wiredManager, restoreManager, adapterError = '', generation = null, saving = false;
let worldReadError = '', refreshTimer, worldRead = null;
const hasWorldHook = Boolean(event_types.WORLDINFO_ENTRIES_LOADED);
const hasActivationHook = Boolean(event_types.WORLD_INFO_ACTIVATED);
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
function ownerKey() {
    const c = context();
    if (c.groupId != null) return JSON.stringify(['group', c.groupId]);
    const avatar = c.characters?.[c.characterId]?.avatar;
    return avatar ? JSON.stringify(['character', avatar]) : '';
}
function sharedSettings() { return context().extensionSettings?.[KEY] || {}; }
function readState() { return readScopedState(sharedSettings(), context().chatMetadata || {}, ownerKey(), presetKey()); }
function effectiveState() { return readState(); }
function scopeLabel() { return tab === 'prompt' ? '이 프리셋 · 모든 채팅' : `목록: ${context().groupId != null ? '이 그룹' : '이 캐릭터'} · ON/OFF: 이 채팅`; }
function ensureScopes() {
    const c = context();
    if (!chatKey() || !c.extensionSettings || !c.chatMetadata) return;
    const previous = c.chatMetadata[SCOPED_KEY], preset = presetKey();
    if (sharedSettings().scopes && previous?.worldMigrated && (!preset || previous.migratedPresets?.includes(preset))) return;
    const settings = structuredClone(sharedSettings());
    if (migrateScopes(settings, c.chatMetadata, ownerKey(), presetKey())) {
        c.extensionSettings[KEY] = settings;
        // Start both saves while this chat is still current, never after an await.
        Promise.all([c.saveSettingsDebounced(), c.saveMetadata()]).catch(error => notify(`설정 이전 저장 실패: ${error.message}`, true));
    }
}
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
function promptCatalog(includeHeadings = false) {
    const rows = catalogPrompts(wiredManager, presetKey());
    return includeHeadings ? rows : rows.filter(row => !row.heading);
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
    if (isGenerating()) { notify('생성 완료 후 변경해주세요.'); return; }
    if (saving) return;
    generation = null;
    const c = context(), metadata = c.chatMetadata;
    if (!metadata || !c.extensionSettings) return;
    const next = readState(), settings = structuredClone(sharedSettings());
    update(next);
    writeScopedState(settings, metadata, ownerKey(), presetKey(), next);
    c.extensionSettings[KEY] = settings;
    saving = true; render();
    try {
        await Promise.all([c.saveSettingsDebounced(), c.saveMetadata()]);
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
    if (title) { b.title = title; b.setAttribute('aria-label', title); }
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

function appendPresetHeadings(container, item, previous) {
    const sections = item?.sections || [];
    const key = JSON.stringify([item?.source, sections.map(x => x.id)]);
    if (key !== previous) for (const heading of sections) container.append(el('h4', 'csb-preset-heading', heading.title));
    return key;
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
    d.append(el('p', 'csb-muted', kind === 'prompt' ? '현재 ON/OFF를 이 프리셋에 저장합니다.' : '등록 후 원본 설정을 따릅니다.'));
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
                s.items.push({ kind: item.kind, source: item.source, id: item.id, name: item.name, alias: '', group: '', state: item.kind === 'prompt' ? item.enabled : null });
            }
        }, scope);
    }, 'csb-primary');
    add.disabled = true;
    function draw() {
        list.replaceChildren();
        const q = filter.value.trim().toLocaleLowerCase();
        const visible = choices.filter(x => `${x.name} ${x.source} ${x.content} ${x.sectionTitle || ''}`.toLocaleLowerCase().includes(q));
        if (!visible.length) list.append(el('p', 'csb-empty', choices.length ? '검색 결과가 없습니다.' : '추가할 항목이 없습니다. 연결 상태를 확인해주세요.'));
        const groups = Map.groupBy ? Map.groupBy(visible, x => x.source) : visible.reduce((m, x) => { if (!m.has(x.source)) m.set(x.source, []); m.get(x.source).push(x); return m; }, new Map());
        for (const [book, rows] of groups) {
            const section = el('details', 'csb-book'); section.open = Boolean(q) || kind === 'prompt';
            section.append(el('summary', '', `${kind === 'prompt' ? presetName(book) : book} · ${rows.length}`));
            let previousSection = '';
            for (const item of rows) {
                previousSection = appendPresetHeadings(section, item, previousSection);
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
        choices.filter(x => `${x.name} ${x.source} ${x.content} ${x.sectionTitle || ''}`.toLocaleLowerCase().includes(q)).forEach(x => selected.add(keyOf(x)));
        add.textContent = `${selected.size}개 추가`; add.disabled = !selected.size; draw();
    }, 'csb-quiet'), add);
    d.append(filter, list, footer); draw(); filter.focus();
}

function openBulk(action) {
    if (!chatKey() || isGenerating() || saving) return;
    const chat = chatKey(), kind = tab;
    const d = modal(action === 'clear' ? '선택 항목 비우기' : 'ON/OFF 초기화');
    d.append(el('p', 'csb-muted', `${scopeLabel()} · ${kind === 'prompt' ? '프리셋' : '월드인포'} 탭 전체 (검색으로 숨겨진 항목 포함)`));
    d.append(el('p', '', action === 'clear' ? '공유 등록 목록에서 제거합니다. 원본과 저장한 조합은 유지됩니다.' : '목록과 주입 방식은 유지하고 ON/OFF는 원본을 따릅니다.'));
    d.append(button('취소', closeDialog, 'csb-quiet'), button('확인', async () => {
        if (chat !== chatKey() || kind !== tab) return closeDialog();
        closeDialog();
        await changeState(s => (action === 'clear' ? clearItems : resetToggles)(s, kind), chat);
    }, 'csb-primary'));
}
function openCombinations() {
    if (!chatKey() || !presetKey() || isGenerating() || saving) return;
    const chat = chatKey(), source = presetKey();
    const valid = () => chat === chatKey() && source === presetKey() && !isGenerating() && !saving;
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
        const effective = indexItems(effectiveState().items);
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

const itemGroup = item => item.group || (item.kind === 'world' ? item.source : '');
function moveItem(state, key, direction) {
    const index = state.items.findIndex(item => keyOf(item) === key), item = state.items[index];
    if (!item) return;
    for (let next = index + direction; next >= 0 && next < state.items.length; next += direction) {
        const other = state.items[next];
        if (other.kind === item.kind && itemGroup(other) === itemGroup(item)) {
            [state.items[index], state.items[next]] = [other, item];
            break;
        }
    }
}

function render() {
    updateBadge();
    if (!panel) return;
    const activeView = tab === 'world' && worldView === 'active';
    panel.querySelector('.csb-world-views').hidden = tab !== 'world';
    panel.querySelectorAll('[data-world-view]').forEach(b => { b.classList.toggle('is-active', b.dataset.worldView === worldView); b.setAttribute('aria-pressed', String(b.dataset.worldView === worldView)); });
    panel.querySelectorAll('[data-action=add], [data-action=edit]').forEach(b => { b.hidden = activeView; });
    panel.querySelector('.csb-search').hidden = !showSearch;
    const previousScroll = body.scrollTop;
    const hasChat = Boolean(chatKey()), busy = isGenerating() || saving;
    subtitle.textContent = hasChat ? scopeLabel() : '먼저 채팅방을 열어주세요';
    const combos = panel.querySelector('[data-action="combos"]'); if (combos) { combos.hidden = tab !== 'prompt'; combos.disabled = !hasChat || busy || !presetKey(); }
    status.textContent = saving ? '설정 저장 중…' : isGenerating() ? '생성 중 · 변경 잠금' : '변경은 다음 생성부터 적용';
    panel.querySelectorAll('[data-tab]').forEach(b => { b.classList.toggle('is-active', b.dataset.tab === tab); b.setAttribute('aria-selected', String(b.dataset.tab === tab)); });
    panel.querySelector('[data-action="edit"]').textContent = editing ? '완료' : '정리';
    panel.querySelector('[data-action="add"]').disabled = !hasChat || busy || (tab === 'prompt' ? Boolean(adapterError) || !presetKey() : !hasWorldHook);
    const currentSource = panel.querySelector('.csb-source');
    currentSource.textContent = tab === 'prompt' ? presetName() || 'Chat Completion 프리셋을 선택해주세요' : '현재 연결된 월드인포';
    body.replaceChildren();
    if (!hasChat) { body.append(el('div', 'csb-empty', '채팅을 열면 원하는 항목을 골라 담을 수 있어요.')); return; }
    const error = tab === 'prompt' ? adapterError : !hasWorldHook ? '이 SillyTavern 버전은 월드인포 제어를 지원하지 않습니다.' : worldReadError;
    if (error) body.append(el('p', 'csb-error', error));
    if (activeView) { renderActivated(busy, error); body.scrollTop = previousScroll; return; }
    const query = search.toLocaleLowerCase();
    const originals = indexItems(tab === 'prompt' ? promptCatalog(true) : worldChat === chatKey() ? worldCatalog : []);
    const items = readState().items.filter(item => item.kind === tab && (tab !== 'world' || editing || originals.has(keyOf(item))) && !originals.get(keyOf(item))?.heading && `${item.alias} ${item.name} ${item.group} ${item.source} ${originals.get(keyOf(item))?.sectionTitle || ''}`.toLocaleLowerCase().includes(query));
    const effectiveItems = editing ? null : indexItems(effectiveState().items);
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
    for (const item of items) {
        const group = itemGroup(item);
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(item);
    }
    for (const [group, members] of groups) {
        const section = el('section', 'csb-section');
        if (group) section.append(el('h4', '', group));
        let previousSection = '';
        for (const [index, item] of members.entries()) {
            const key = keyOf(item), native = originals.get(key);
            if (!group) previousSection = appendPresetHeadings(section, native, previousSection);
            const row = el('div', `csb-row${native ? '' : ' is-missing'}${editing ? ' is-editing' : ''}`);
            const copy = button('', () => showDetails(item), 'csb-item-copy', `${item.alias || native?.name || item.name} · 내용 미리 보기`);
            copy.append(el('strong', '', item.alias || native?.name || item.name));
            const source = item.kind === 'prompt' ? presetName(item.source) : item.source;
            row.append(copy);
            if (!editing) {
                if (!native) copy.append(el('small', 'csb-muted', `${source} · ${unavailableReason(item)}`));
                const effective = effectiveItems.get(key);
                const on = effective?.state ?? native?.enabled ?? false;
                const toggle = button(on ? 'ON' : 'OFF', () => changeState(s => { const found = s.items.find(x => keyOf(x) === key); if (found) found.state = !on; }), `csb-switch${on ? ' is-on' : ''}`);
                toggle.title = effective?.state == null ? '원본 따름' : item.kind === 'prompt' ? '프리셋 지정' : '이 채팅 지정';
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

function updateBadge() {
    if (!launcher || !badge) return;
    const result = activation.result;
    const known = result.chat === chatKey() && result.phase === 'ready';
    badge.hidden = !known;
    badge.textContent = known ? String(result.entries.length) : '';
    launcher.setAttribute('aria-label', `채팅 스위치보드 열기${known ? ` · 이번 메시지 활성화 ${result.entries.length}개` : ''}`);
}
function renderActivated(busy, error) {
    if (!hasActivationHook) { body.append(el('p', 'csb-empty', '이 버전은 활성화 조회를 지원하지 않습니다.')); return; }
    const result = activation.result;
    const known = result.chat === chatKey() && result.phase === 'ready';
    panel.querySelector('.csb-source').textContent = known ? `활성화 ${result.entries.length}개` : '이번 메시지 활성화';
    if (!known) {
        body.append(el('p', 'csb-empty', result.phase === 'pending' ? '활성화 확인 중…' : '생성 후 확인할 수 있어요.'));
        return;
    }
    if (!result.entries.length) { body.append(el('p', 'csb-empty', '활성화된 항목이 없습니다.')); return; }
    const states = indexItems(readState().items), originals = indexItems(worldChat === chatKey() ? worldCatalog : []);
    const query = search.toLocaleLowerCase();
    const groups = new Map();
    for (const entry of result.entries) {
        if (!`${entry.name} ${entry.source}`.toLocaleLowerCase().includes(query)) continue;
        if (!groups.has(entry.source)) groups.set(entry.source, []);
        groups.get(entry.source).push(entry);
    }
    if (!groups.size) body.append(el('p', 'csb-empty', '검색 결과가 없습니다.'));
    for (const [book, entries] of groups) {
        const section = el('section', 'csb-section'); section.append(el('h4', '', book));
        for (const entry of entries) {
            const key = keyOf(entry), state = states.get(key), native = originals.get(key);
            const on = state?.state ?? native?.enabled ?? entry.enabled;
            const row = el('div', 'csb-row');
            const mode = el('span', 'csb-active-mode', ({ constant: '🔵', normal: '🟢', vectorized: '🔗' })[entry.activation]);
            mode.title = activationLabels[entry.activation]; mode.setAttribute('aria-label', mode.title);
            const title = el('span', 'csb-active-title', state?.alias || entry.name);
            const toggle = button(on ? 'ON' : 'OFF', () => changeState(s => {
                let item = s.items.find(x => keyOf(x) === key);
                if (!item) { item = { kind: 'world', source: entry.source, id: entry.id, name: entry.name, alias: '', group: '', state: null, activation: null }; s.items.push(item); }
                item.state = !on;
            }), `csb-switch${on ? ' is-on' : ''}`, `${entry.name} · 다음 생성 ${on ? '끄기' : '켜기'}`);
            toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(on));
            toggle.disabled = busy || Boolean(error) || !native;
            row.append(mode, title, toggle); section.append(row);
        }
        body.append(section);
    }
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
    for (const [name, value] of Object.entries({ display:'block', position:'fixed', right:'auto', bottom:'auto', width:'48px', height:'48px', 'min-width':'48px', 'max-width':'48px', 'min-height':'48px', 'max-hei…550 tokens truncated…ader', 'csb-header'), titles = el('div');
    titles.append(el('h2', '', '채팅 스위치'));
    subtitle = el('p', 'csb-muted'); titles.append(subtitle);
    header.append(titles, button('×', () => { setPanelOpen(false); launcher.focus(); }, 'csb-close', '패널 닫기'));
    const tabs = el('div', 'csb-tabs'); tabs.setAttribute('role', 'tablist');
    for (const [kind, label] of [['prompt', '프리셋'], ['world', '월드인포']]) {
        const b = button(label, () => { closeDialog(); editing = false; tab = kind; search = ''; input.value = ''; render(); if (kind === 'world') refreshWorlds(); });
        b.dataset.tab = kind; b.setAttribute('role', 'tab'); tabs.append(b);
    }
    const toolbar = el('div', 'csb-toolbar');
    const views = el('div', 'csb-world-views');
    for (const [value, label] of [['manage', '관리'], ['active', '이번 메시지 활성화']]) {
        const b = button(label, () => { closeDialog(); worldView = value; editing = false; render(); });
        b.dataset.worldView = value; views.append(b);
    }
    const add = button('＋ 추가', openPicker, 'csb-primary'); add.dataset.action = 'add';
    const edit = button('정리', () => { editing = !editing; render(); }, 'csb-quiet'); edit.dataset.action = 'edit';
    const combinations = button('조합', openCombinations, 'csb-quiet', '프롬프트 ON/OFF 조합'); combinations.dataset.action = 'combos';
    const searchButton = button('⌕', () => { showSearch = !showSearch; if (!showSearch) { search = ''; input.value = ''; } render(); if (showSearch) input.focus(); }, 'csb-quiet', '검색');
    toolbar.append(add, combinations, searchButton, button('↻', () => { ensureAdapter(); render(); refreshWorlds(); }, 'csb-quiet', '관리 목록 새로고침'), edit);
    const source = el('p', 'csb-source csb-muted');
    const input = el('input', 'csb-search'); input.type = 'search'; input.placeholder = '제목 · 책 검색'; input.setAttribute('aria-label', '내 버튼 검색');
    input.addEventListener('input', () => { search = input.value; render(); });
    body = el('div', 'csb-body'); status = el('footer', 'csb-status'); status.setAttribute('role', 'status');
    panel.append(header, tabs, views, toolbar, source, input, body, status);
    document.body.append(launcher, panel);
    showFloatingIcon();
    render();
}

function init() {
    if (!active) return;
    ensureScopes(); ensureAdapter(); buildUI();
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
    listen(event_types.GENERATION_AFTER_COMMANDS, (type, _options, dryRun) => {
        ensureScopes(); ensureAdapter();
        if (!dryRun) {
            generation = { ...structuredClone(liveScope()), trackActivation: type !== 'quiet' && hasActivationHook };
            if (generation.trackActivation) activation.begin(chatKey());
            setTimeout(render, 0);
        }
    });
    if (event_types.WORLD_INFO_ACTIVATED) listen(event_types.WORLD_INFO_ACTIVATED, entries => {
        if (generation?.trackActivation) { activation.capture(chatKey(), entries); render(); }
    });
    if (event_types.GENERATE_AFTER_DATA) listen(event_types.GENERATE_AFTER_DATA, (_data, dryRun) => {
        if (!dryRun && generation?.trackActivation) { activation.prepared(chatKey()); render(); }
    });
    for (const name of ['GENERATION_ENDED', 'GENERATION_STOPPED']) if (event_types[name]) listen(event_types[name], () => {
        if (generation?.trackActivation) activation.finish(chatKey());
        generation = null; scheduleRefresh();
    });
    for (const name of ['CHAT_CHANGED', 'OAI_PRESET_CHANGED_AFTER']) if (event_types[name]) listen(event_types[name], () => {
        if (generation && (generation.chat !== chatKey() || generation.preset !== presetKey())) {
            if (isGenerating()) { stopGeneration(); notify('채팅 또는 프리셋이 바뀌어 진행 중인 생성을 중단했습니다.'); }
            generation = null;
        }
        if (name === 'CHAT_CHANGED') activation.reset();
        ensureScopes(); updateBadge();
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
    activation.reset(); badge = null; generation = null; closeDialog();
    panel?.remove(); launcher?.remove(); document.getElementById('csb-settings')?.remove();
    panel = null; launcher = null; worldCatalog = []; worldChat = '';
}
onEnable();
