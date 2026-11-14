import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkConfig, createSources, migrateConfig, usesMqtt } = require('../lib/profiles/index.js');

const TOPICS = { topicHeatpump: 'hp', topicButler: 'b' };

test('migrateConfig: settings up to 0.4 become one data source per device', () => {
    assert.deepEqual(migrateConfig({ profile: 'json', ...TOPICS }), { butlerSource: 'json', heatpumpSource: 'json' });
    assert.deepEqual(migrateConfig({ profile: 'mtecmqtt', ...TOPICS }), {
        butlerSource: 'mtecmqtt',
        heatpumpSource: 'json',
    });
    // empty topic = device not present; with mtecmqtt the butler topic did not matter
    assert.deepEqual(migrateConfig({ profile: 'json', topicHeatpump: ' ', topicButler: 'b' }), {
        butlerSource: 'json',
        heatpumpSource: 'none',
    });
    assert.deepEqual(migrateConfig({ profile: 'mtecmqtt', topicHeatpump: '', topicButler: '' }), {
        butlerSource: 'mtecmqtt',
        heatpumpSource: 'none',
    });
    // without any profile key (before 0.4): json
    assert.deepEqual(migrateConfig({ topicHeatpump: '', topicButler: 'b' }), {
        butlerSource: 'json',
        heatpumpSource: 'none',
    });
});

test('migrateConfig: the old profile counts even if an update already added the new keys', () => {
    assert.deepEqual(migrateConfig({ profile: 'mtecmqtt', butlerSource: 'json', heatpumpSource: 'json', ...TOPICS }), {
        butlerSource: 'mtecmqtt',
        heatpumpSource: 'json',
    });
});

test('migrateConfig: nothing to do for current settings', () => {
    assert.equal(migrateConfig({ butlerSource: 'none', heatpumpSource: 'json', ...TOPICS }), null);
    assert.equal(migrateConfig({ butlerSource: 'mtecmqtt', heatpumpSource: 'none' }), null);
});

test('checkConfig: MQTT broker only needed for MQTT sources', () => {
    const ok = { host: 'broker', butlerSource: 'json', heatpumpSource: 'json', ...TOPICS };
    assert.deepEqual(checkConfig(ok), []);
    assert.equal(usesMqtt(ok), true);
    assert.deepEqual(checkConfig({ ...ok, host: ' ' }), [
        'No MQTT broker configured, please add it in the instance settings.',
    ]);
    assert.deepEqual(checkConfig({ host: 'broker', butlerSource: 'mtecmqtt', heatpumpSource: 'none' }), []);
    assert.equal(usesMqtt({ butlerSource: 'none', heatpumpSource: 'none' }), false);
});

test('checkConfig: unknown sources, missing topics, no device', () => {
    assert.deepEqual(checkConfig({ host: 'broker', butlerSource: 'modbus', heatpumpSource: 'json', ...TOPICS }), [
        'Unknown data source "modbus" for the M-TEC Energy Butler, please choose one in the instance settings.',
    ]);
    assert.deepEqual(checkConfig({ host: 'broker', butlerSource: 'json', heatpumpSource: 'mtecmqtt', ...TOPICS }), [
        'Unknown data source "mtecmqtt" for the M-TEC heat pump, please choose one in the instance settings.',
    ]);
    assert.deepEqual(checkConfig({ host: 'broker', butlerSource: 'json', heatpumpSource: 'none', topicButler: '' }), [
        'No topic configured for the M-TEC Energy Butler, please add it in the instance settings.',
    ]);
    assert.deepEqual(checkConfig({ butlerSource: 'none', heatpumpSource: 'none' }), [
        'No device configured, please choose a data source in the instance settings.',
    ]);
});

test('createSources: one source per device as configured', () => {
    const sources = config => createSources(config).map(s => [s.profile, s.device]);
    assert.deepEqual(sources({ butlerSource: 'json', heatpumpSource: 'json', ...TOPICS }), [
        ['json', 'heatpump'],
        ['json', 'butler'],
    ]);
    assert.deepEqual(sources({ butlerSource: 'mtecmqtt', heatpumpSource: 'json', ...TOPICS }), [
        ['json', 'heatpump'],
        ['mtecmqtt', 'butler'],
    ]);
    assert.deepEqual(sources({ butlerSource: 'mtecmqtt', heatpumpSource: 'none', ...TOPICS }), [
        ['mtecmqtt', 'butler'],
    ]);
    assert.deepEqual(sources({ butlerSource: 'none', heatpumpSource: 'none', ...TOPICS }), []);
    assert.equal(createSources({ butlerSource: 'json', heatpumpSource: 'none', topicButler: ' b ' })[0].topic, 'b');
});
