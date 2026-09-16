import { itemKey } from './core.mjs';

// One in-memory result, no message history, content strings, or chat cache.
export function createActivationTracker() {
    let result = { chat: '', phase: 'unknown', entries: [] }, pending = false;
    return {
        get result() { return result; },
        reset() { pending = false; result = { chat: '', phase: 'unknown', entries: [] }; },
        begin(chat) { pending = true; result = { chat, phase: 'pending', entries: [] }; },
        capture(chat, entries) {
            if (!pending || chat !== result.chat) return;
            const seen = new Set();
            result.entries = Array.from(entries || []).flatMap(entry => {
                if (!entry || typeof entry.world !== 'string' || entry.uid == null) return [];
                const key = itemKey('world', entry.world, entry.uid);
                if (seen.has(key)) return [];
                seen.add(key);
                return [{ kind: 'world', source: entry.world, id: String(entry.uid),
                    name: String(entry.comment || (Array.isArray(entry.key) ? entry.key.join(', ') : '') || `항목 ${entry.uid}`),
                    enabled: !entry.disable, activation: entry.constant ? 'constant' : entry.vectorized ? 'vectorized' : 'normal' }];
            });
            result.phase = 'ready';
        },
        prepared(chat) {
            // GENERATE_AFTER_DATA proves prompt preparation reached the API payload.
            // Unlike GENERATION_ENDED it cannot turn an early failure into zero.
            if (pending && chat === result.chat && result.phase === 'pending') result.phase = 'ready';
        },
        finish(chat) {
            if (chat !== result.chat) return;
            if (result.phase === 'pending') result.phase = 'unknown';
            pending = false;
        },
    };
}
