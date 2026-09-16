import { KEY, normalizeState, mergeStates, itemKey } from './core.mjs';

export const SCOPED_KEY = 'chat_switchboard_scoped_v2';
const keyOf = item => itemKey(item.kind, item.source, item.id);
const stateOf = items => normalizeState({ version: 1, items });
const registry = items => stateOf(items.map(item => ({ ...item, state: null, activation: null })));
const appendMissing = (base, incoming) => {
    const seen = new Set(base.items.map(keyOf));
    return stateOf([...base.items, ...incoming.filter(item => !seen.has(keyOf(item)))]);
};

// Called once per visited legacy chat/preset. Existing scoped choices win conflicts.
// Keep legacy data as a rollback backup; never import the same source twice.
export function migrateScopes(settings, metadata, owner, preset) {
    const before = JSON.stringify([settings.scopes, metadata[SCOPED_KEY]]);
    settings.scopes ||= { presets: {}, worlds: {} };
    const scopes = settings.scopes;
    scopes.presets ||= {}; scopes.worlds ||= {};
    const local = metadata[SCOPED_KEY] ||= { world: stateOf([]), migratedPresets: [], worldMigrated: false };
    local.migratedPresets ||= [];
    const legacy = mergeStates(settings.state, metadata[KEY]);
    if (preset && !local.migratedPresets.includes(preset)) {
        scopes.presets[preset] = appendMissing(normalizeState(scopes.presets[preset]), legacy.items.filter(x => x.kind === 'prompt' && x.source === preset));
        local.migratedPresets.push(preset);
    }
    if (owner && !local.worldMigrated) {
        const worlds = legacy.items.filter(x => x.kind === 'world');
        scopes.worlds[owner] = registry(appendMissing(normalizeState(scopes.worlds[owner]), worlds).items);
        local.world = appendMissing(normalizeState(local.world), metadata[KEY] ? worlds : []);
        local.worldMigrated = true;
    }
    return before !== JSON.stringify([settings.scopes, metadata[SCOPED_KEY]]);
}

export function readScopedState(settings, metadata, owner, preset) {
    const prompts = normalizeState(settings.scopes?.presets?.[preset]).items;
    const worlds = normalizeState(settings.scopes?.worlds?.[owner]).items;
    const overrides = new Map(normalizeState(metadata[SCOPED_KEY]?.world).items.map(item => [keyOf(item), item]));
    return stateOf([...prompts, ...worlds.map(item => {
        const local = overrides.get(keyOf(item));
        return { ...item, state: local?.state ?? null, activation: local?.activation ?? null };
    })]);
}

export function writeScopedState(settings, metadata, owner, preset, value) {
    settings.scopes ||= { presets: {}, worlds: {} };
    const state = normalizeState(value);
    if (preset) settings.scopes.presets[preset] = stateOf(state.items.filter(x => x.kind === 'prompt' && x.source === preset));
    if (owner) {
        const worlds = state.items.filter(x => x.kind === 'world');
        settings.scopes.worlds[owner] = registry(worlds);
        metadata[SCOPED_KEY] ||= { migratedPresets: [], worldMigrated: true };
        metadata[SCOPED_KEY].world = stateOf(worlds.filter(x => x.state !== null || x.activation !== null));
    }
}
