// Every data point and channel name must exist in all ioBroker languages (repository check E6001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DEVICES, t } = require('../lib/fields.js');
const { ANALYSIS_STATES } = require('../lib/analysis.js');
const { LANGUAGES, TRANSLATIONS } = require('../lib/i18n.js');
const { Bridge } = require('../lib/bridge.js');
const { MtecmqttSource } = require('../lib/profiles/mtecmqtt.js');

const ALL = ['en', 'de', ...LANGUAGES];

function assertComplete(name, where) {
    assert.equal(typeof name, 'object', `${where}: name is not multilingual`);
    assert.deepEqual(Object.keys(name), ALL, `${where}: languages`);
    for (const lang of ALL) {
        assert.ok(typeof name[lang] === 'string' && name[lang].trim(), `${where}: "${lang}" is empty`);
    }
}

test('field and analysis names exist in all languages', () => {
    for (const [id, device] of Object.entries(DEVICES)) {
        assertComplete(device.name, id);
        for (const [field, def] of Object.entries(device.fields)) {
            assertComplete(def.name, `${id}.${field}`);
        }
    }
    for (const [key, def] of Object.entries(ANALYSIS_STATES)) {
        assertComplete(def.name, `analysis.${key}`);
    }
});

test('all objects the adapter creates have names in all languages', async () => {
    for (const config of [
        { topicHeatpump: 'hp', topicButler: 'b', staleSeconds: 20 },
        { profile: 'mtecmqtt', topicHeatpump: 'hp', staleSeconds: 30 },
    ]) {
        const objects = {};
        const adapter = {
            namespace: 'mtec.0',
            log: { debug() {}, info() {}, warn() {}, error() {} },
            async extendObjectAsync(id, obj) {
                objects[id] = obj;
            },
            async setStateAsync() {},
        };
        await new Bridge(adapter, config, () => null).createObjects();
        for (const [id, obj] of Object.entries(objects)) {
            if (typeof obj.common.name === 'object') {
                assertComplete(obj.common.name, id);
            } else {
                assert.equal(obj.common.name, 'Information', `${id}: plain name`);
            }
        }
        assert.match(objects['butler.info.stale'].common.name.fr, new RegExp(`${config.staleSeconds} s$`));
    }
    const extra = new MtecmqttSource({ staleMs: 1, slowStaleMs: 1, now: 0 }).extra('now-base', 'x', 1);
    assertComplete(extra.channels[0].name, extra.channels[0].id);
});

test('t() replaces the placeholder in all languages', () => {
    const name = t('Data older than %s s', 'Daten älter als %s s', 45);
    assert.equal(name.en, 'Data older than 45 s');
    assert.equal(name.de, 'Daten älter als 45 s');
    assert.equal(name['zh-cn'], '数据超过 45 秒');
    assert.ok(Object.values(name).every(v => !v.includes('%s')));
});

test('every translation is used', () => {
    const used = new Set([
        'Data older than %s s',
        'Time of the last measurement',
        'Serial number',
        'Analysis',
        'Daily values (since midnight)',
        'Further values from MTECmqtt',
    ]);
    for (const device of Object.values(DEVICES)) {
        used.add(device.name.en);
        for (const def of Object.values(device.fields)) {
            used.add(def.name.en);
        }
    }
    for (const def of Object.values(ANALYSIS_STATES)) {
        used.add(def.name.en);
    }
    assert.deepEqual(
        Object.keys(TRANSLATIONS).filter(k => !used.has(k)),
        [],
    );
});
