export const KEY = 'chat_switchboard_v1';
export const itemKey = (kind, source, id) => JSON.stringify([kind, source, String(id)]);
export const emptyState = () => ({ version: 1, items: [] });
export function normalizeState(value) {
    if (!value || value.version !== 1 || !Array.isArray(value.items)) return emptyState();
    const seen = new Set();
    return { version: 1, items: value.items.filter(item => {
        if (!item || !['prompt', 'world'].includes(item.kind) || typeof item.source !== 'string' ||
            !['string', 'number'].includes(typeof item.id)) return false;
        const key = itemKey(item.kind, item.source, item.id);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).map(item => ({
        kind: item.kind, source: item.source, id: String(item.id),
        name: String(item.name || item.id), alias: String(item.alias || ''), group: String(item.group || ''),
        state: typeof item.state === 'boolean' ? item.state : null,
        activation: item.kind === 'world' && ['constant', 'normal', 'vectorized'].includes(item.activation) ? item.activation : null,
    })) };
}
export function overrideFor(state, kind, source, id) {
    const item = state?.items?.find(x => x.kind === kind && x.source === source && String(x.id) === String(id));
    return typeof item?.state === 'boolean' ? item.state : null;
}

// Apply only to read calls. Native getters and their mutable arrays stay intact.
export function installPromptAdapter(manager, getScope) {
    const methods = ['getPromptCollection', 'isPromptDisabledForActiveCharacter', 'getPromptsForCharacter'];
    if (!manager || methods.some(name => typeof manager[name] !== 'function') ||
        typeof manager.getPromptOrderForCharacter !== 'function') throw new Error('지원하지 않는 프롬프트 관리자 버전입니다.');
    const originals = Object.fromEntries(methods.map(name => [name, manager[name]]));
    const wrappers = {};
    for (const name of methods) {
        wrappers[name] = function (...args) {
            // The editor asks for all prompts; its original state must remain untouched.
            if (name === 'getPromptsForCharacter' && args[1] !== true) return originals[name].apply(this, args);
            const scope = getScope();
            if (!scope?.preset || !scope.state.items.some(x => x.kind === 'prompt' && x.source === scope.preset && x.state !== null)) {
                return originals[name].apply(this, args);
            }
            const receiver = this;
            const view = new Proxy(receiver, {
                get(target, prop, proxy) {
                    if (prop === 'getPromptOrderForCharacter') return character => {
                        const order = receiver.getPromptOrderForCharacter(character);
                        return order.map(entry => {
                            const on = overrideFor(scope.state, 'prompt', scope.preset, entry.identifier);
                            return on === null ? entry : { ...entry, enabled: on };
                        });
                    };
                    return Reflect.get(target, prop, proxy);
                },
            });
            return originals[name].apply(view, args);
        };
        manager[name] = wrappers[name];
    }
    return () => {
        for (const name of methods) if (manager[name] === wrappers[name]) manager[name] = originals[name];
    };
}

export function applyWorldOverrides(payload, state) {
    for (const key of ['globalLore', 'characterLore', 'chatLore', 'personaLore']) {
        const entries = payload[key];
        if (!Array.isArray(entries)) continue;
        // Splice is necessary: ST retains the original array reference after emitting.
        // Clone entries so loadWorldInfo's cached source is never edited.
        const copies = entries.map(entry => {
            const on = overrideFor(state, 'world', entry.world, entry.uid);
            const mode = state?.items?.find(x => x.kind === 'world' && x.source === entry.world && String(x.id) === String(entry.uid))?.activation;
            const hasMode = ['constant', 'normal', 'vectorized'].includes(mode);
            if (on === null && !hasMode) return entry;
            return { ...entry, ...(on === null ? {} : { disable: !on }),
                ...(hasMode ? { constant: mode === 'constant', vectorized: mode === 'vectorized' } : {}) };
        });
        entries.splice(0, entries.length, ...copies);
    }
}

export function catalogWorlds(payload) {
    const entries = new Map();
    for (const key of ['globalLore', 'characterLore', 'chatLore', 'personaLore']) {
        for (const entry of payload[key] || []) {
            const k = itemKey('world', entry.world, entry.uid);
            if (entries.has(k)) continue;
            entries.set(k, {
                kind: 'world', source: entry.world, id: String(entry.uid),
                name: entry.comment || (Array.isArray(entry.key) ? entry.key.join(', ') : '') || `항목 ${entry.uid}`,
                enabled: !entry.disable, content: String(entry.content || ''),
                strategy: entry.constant ? '상시 조건' : entry.vectorized ? '벡터 조건' : '키워드 조건',
                activation: entry.constant ? 'constant' : entry.vectorized ? 'vectorized' : 'normal',
            });
        }
    }
    return [...entries.values()];
}

// Local non-null values override shared defaults; original source data stays intact.
export function mergeStates(shared, local) {
    const items = new Map(normalizeState(shared).items.map(x => [itemKey(x.kind, x.source, x.id), x]));
    for (const item of normalizeState(local).items) {
        const key = itemKey(item.kind, item.source, item.id), base = items.get(key);
        items.set(key, { ...item, state: item.state ?? base?.state ?? null,
            activation: item.activation ?? base?.activation ?? null });
    }
    return { version: 1, items: [...items.values()] };
}
export function resetToggles(state, kind) {
    for (const item of state.items) if (item.kind === kind) item.state = null;
}
export function clearItems(state, kind) { state.items = state.items.filter(x => x.kind !== kind); }
export function applyPromptCombination(state, combination, source) {
    const items = normalizeState(combination).items.filter(x => x.kind === 'prompt' && x.source === source);
    state.items = [...state.items.filter(x => x.kind !== 'prompt' || x.source !== source), ...items];
}

// Built-in prompts can be filled by ST even when their stored content is empty.
const builtInPrompts = new Set(['main', 'nsfw', 'jailbreak', 'enhanceDefinitions',
    'dialogueExamples', 'chatHistory', 'worldInfoBefore', 'worldInfoAfter',
    'charDescription', 'charPersonality', 'scenario', 'personaDescription']);

export function catalogPrompts(manager, source) {
    if (!source || !manager) return [];
    let sections = [], afterItem = false;
    const items = [];
    for (const entry of manager.getPromptOrderForCharacter(manager.activeCharacter)) {
        const prompt = manager.getPromptById(entry.identifier);
        if (!prompt) continue;
        const id = String(prompt.identifier), name = String(prompt.name || id), content = String(prompt.content || '');
        const toggleable = typeof manager.isPromptToggleAllowed !== 'function' || manager.isPromptToggleAllowed(prompt);
        const heading = !builtInPrompts.has(id) && Boolean(String(prompt.name || '').trim()) &&
            ((prompt.marker && !toggleable) || (!prompt.marker && !prompt.system_prompt && !content.trim()));
        if (heading) {
            if (afterItem) sections = [];
            sections = [...sections, { id, title: name }]; afterItem = false;
            items.push({ kind: 'prompt', source, id, name, content, heading: true });
            continue;
        }
        if (!toggleable) continue;
        items.push({ kind: 'prompt', source, id, name, content, enabled: Boolean(entry.enabled), strategy: '',
            sections, sectionTitle: sections.map(x => x.title).join(' · '), sectionId: sections.at(-1)?.id || '' });
        afterItem = true;
    }
    return items;
}
