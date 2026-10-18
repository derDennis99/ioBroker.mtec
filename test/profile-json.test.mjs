import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DeviceTelemetry, JsonSource, Q_SENSOR_NOT_REPORTED } = require('../lib/profiles/json.js');
const { createSources } = require('../lib/profiles/index.js');
const { DEVICES, stateCommon, t } = require('../lib/fields.js');

const NOW = 1_791_956_345_000;
const msg = (fields, timestamp = NOW) => JSON.stringify({ name: 'heatpump', fields, timestamp });
const hp = () => new DeviceTelemetry(DEVICES.heatpump.fields, 20_000);
const byField = result => Object.fromEntries(result.updates.map(u => [u.field, u]));

test('number of fields matches the format description', () => {
    assert.equal(Object.keys(DEVICES.heatpump.fields).length, 25);
    assert.equal(Object.keys(DEVICES.butler.fields).length, 16);
});

test('takes over values and the time of measurement', () => {
    const r = hp().process(msg({ dhw_top_temperature_c: 55.6, electrical_power_w: 3414 }), NOW);
    assert.equal(r.status, 'ok');
    assert.equal(r.ts, NOW);
    const u = byField(r);
    assert.deepEqual(u.dhw_top_temperature_c, { field: 'dhw_top_temperature_c', val: 55.6, q: 0 });
    assert.equal(u.electrical_power_w.val, 3414);
});

test('0 is a valid value', () => {
    const u = byField(hp().process(msg({ outdoor_temperature_c: 0 }), NOW));
    assert.deepEqual(u.outdoor_temperature_c, { field: 'outdoor_temperature_c', val: 0, q: 0 });
});

test('missing known fields become null with quality "not reported", not 0', () => {
    const u = byField(hp().process(msg({ electrical_power_w: 1 }), NOW));
    assert.deepEqual(u.flow_temperature_c, { field: 'flow_temperature_c', val: null, q: Q_SENSOR_NOT_REPORTED });
    assert.equal(Object.keys(u).length, 25);
});

test('floating point noise is smoothed, real decimals stay', () => {
    // values from a real system (15.10.2026)
    const u = byField(
        hp().process(
            msg({
                buffer_bottom_temperature_c: 31.400000000000002,
                heatpump_target_temperature_c: 37.300000000000004,
                heating_water_mass_flow_kg_s: 0.123456,
                electrical_power_w: -628,
            }),
            NOW,
        ),
    );
    assert.equal(u.buffer_bottom_temperature_c.val, 31.4);
    assert.equal(u.heatpump_target_temperature_c.val, 37.3);
    assert.equal(u.heating_water_mass_flow_kg_s.val, 0.123456);
    assert.equal(u.electrical_power_w.val, -628);
});

test('0/1 flags become booleans', () => {
    const u = byField(hp().process(msg({ dhw_heat_request: 1, buffer_heat_request: 0 }), NOW));
    assert.equal(u.dhw_heat_request.val, true);
    assert.equal(u.buffer_heat_request.val, false);
});

test('duplicates and older messages are discarded', () => {
    const t = hp();
    assert.equal(t.process(msg({ cop: 3 }, NOW), NOW).status, 'ok');
    assert.equal(t.process(msg({ cop: 3 }, NOW), NOW).status, 'duplicate');
    assert.equal(t.process(msg({ cop: 2 }, NOW - 5000), NOW).status, 'outdated');
    assert.equal(t.process(msg({ cop: 4 }, NOW + 5000), NOW + 5000).status, 'ok');
    assert.equal(t.lastTs, NOW + 5000);
});

test('unknown fields are reported and still taken over', () => {
    const r = hp().process(msg({ energy_total_kwh: 1234.5 }), NOW);
    assert.deepEqual(r.unknown, ['energy_total_kwh']);
    assert.equal(byField(r).energy_total_kwh.val, 1234.5);
});

test('non-numeric values are ignored', () => {
    const r = hp().process(msg({ cop: 'three', thermal_power_w: null }), NOW);
    assert.deepEqual(r.rejected.sort(), ['cop', 'thermal_power_w']);
    assert.equal(byField(r).cop.val, null);
});

test('invalid messages', () => {
    const t = hp();
    assert.equal(t.process('no json', NOW).status, 'invalid');
    assert.equal(t.process(JSON.stringify({ timestamp: NOW }), NOW).status, 'invalid');
    assert.equal(t.process(JSON.stringify({ fields: {} }), NOW).status, 'invalid');
    assert.equal(t.process(JSON.stringify({ fields: [], timestamp: NOW }), NOW).status, 'invalid');
    assert.equal(t.process(msg({ cop: 1 }, NOW + 120_000), NOW).status, 'invalid', 'timestamp far in the future');
    assert.equal(t.lastTs, null, 'invalid messages do not change the state');
});

test('stale by age of the measurement', () => {
    const t = hp();
    assert.equal(t.isStale(NOW), true, 'stale without a measurement');
    t.process(msg({ cop: 1 }, NOW - 30_000), NOW);
    assert.equal(t.isStale(NOW), true, 'a buffered old message does not make it fresh');
    t.process(msg({ cop: 1 }, NOW), NOW);
    assert.equal(t.isStale(NOW + 20_000), false);
    assert.equal(t.isStale(NOW + 20_001), true);
});

test('stateCommon sets type, unit, multilingual name and state texts', () => {
    const f = DEVICES.heatpump.fields;
    assert.deepEqual(stateCommon('flow_temperature_c', f.flow_temperature_c), {
        name: t('Heat pump flow', 'WP-Vorlauf'),
        type: 'number',
        role: 'value.temperature',
        read: true,
        write: false,
        unit: '°C',
    });
    assert.equal(stateCommon('dhw_heat_request', f.dhw_heat_request).type, 'boolean');
    assert.equal(stateCommon('operating_status_code', f.operating_status_code).states[2], 'Heating');
    assert.deepEqual(stateCommon('foo'), { name: 'foo', type: 'number', role: 'value', read: true, write: false });
});

test('JsonSource turns messages into records', () => {
    const s = new JsonSource('heatpump', 'energy/heatpump/telemetry', DEVICES.heatpump.fields, 20_000);
    assert.deepEqual(s.subscriptions, [{ topic: 'energy/heatpump/telemetry', qos: 1 }]);
    assert.equal(s.matches('energy/heatpump/telemetry'), true);
    assert.equal(s.matches('energy/butler/telemetry'), false);
    const [rec] = s.handle('energy/heatpump/telemetry', msg({ cop: 3 }), NOW);
    assert.equal(rec.type, 'record');
    assert.equal(rec.device, 'heatpump');
    assert.equal(rec.main, true);
    assert.equal(rec.ts, NOW);
    assert.equal(s.lastTs, NOW);
    assert.equal(s.handle('energy/heatpump/telemetry', msg({ cop: 3 }), NOW)[0].type, 'skipped');
    assert.equal(s.handle('energy/heatpump/telemetry', '{oops', NOW)[0].type, 'invalid');
});

test('createSources: profile json is the default, the heat pump always uses json', () => {
    const json = createSources({ topicHeatpump: 'hp', topicButler: 'b' });
    assert.deepEqual(
        json.map(s => [s.profile, s.device]),
        [
            ['json', 'heatpump'],
            ['json', 'butler'],
        ],
    );
    const mtec = createSources({ profile: 'mtecmqtt', topicHeatpump: 'hp', topicButler: 'b', mtecTopicPrefix: 'MTEC' });
    assert.deepEqual(
        mtec.map(s => [s.profile, s.device]),
        [
            ['json', 'heatpump'],
            ['mtecmqtt', 'butler'],
        ],
    );
    assert.deepEqual(
        createSources({ profile: 'mtecmqtt' }).map(s => s.device),
        ['butler'],
    );
    assert.deepEqual(createSources({ topicHeatpump: ' ', topicButler: '' }), []);
});
